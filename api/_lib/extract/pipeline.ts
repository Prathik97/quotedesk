// One document per call: load, prepare, classify, extract, persist, reconcile.
// Failures are isolated to the document and recorded on it; nothing throws past here
// except the budget guard, which must stop the whole batch.
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import type { Assumptions } from '../../../engine/types.js';
import { BudgetExceededError, type CallDeps } from '../llm/call.js';
import { certificateFacts, classify, extract, loadPrompt, type RfxContext, type StageOptions } from './model.js';
import { clearDocument, persistCertificate, persistExtraction, persistObservations, type QuestionRow, type RfxLineRow } from './persist.js';
import { prepare, prepareMessageBody, type Prepared } from './prepare.js';
import { reconcileVendor } from './reconcile.js';

export const STORAGE_BUCKET = 'documents';

export type DocumentRecord = {
  id: string;
  vendor_id: string;
  vendor_name: string;
  rfx_id: string;
  filename: string;
  mime: string;
  storage_path: string;
  sha256: string;
  message_from: string | null;
  message_subject: string | null;
  message_body: string | null;
  received_at: string | null;
};

export async function loadDocument(pool: pg.Pool, id: string): Promise<DocumentRecord> {
  const r = await pool.query<DocumentRecord>(
    `select d.id, d.vendor_id, v.name as vendor_name, v.rfx_id, d.filename, d.mime, d.storage_path, d.sha256,
            v.contact_email as message_from, m.subject as message_subject, m.body_text as message_body, m.received_at::text
     from documents d join vendors v on v.id = d.vendor_id left join vendor_messages m on m.id = d.message_id where d.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new Error('Document not found.');
  return row;
}

export async function loadRfxContext(pool: pg.Pool, rfxId: string): Promise<{ lines: RfxLineRow[]; questions: QuestionRow[]; ctx: RfxContext }> {
  const lines = (await pool.query<RfxLineRow>(
    `select id, code, section, description, uom, annual_qty::float8 as annual_qty, last_year_rate_inr::float8 as last_year_rate_inr from rfx_lines where rfx_id = $1 order by sort`, [rfxId])).rows;
  const questions = (await pool.query<QuestionRow>('select id, code, text, is_knockout, pass_rule from questionnaire_questions where rfx_id = $1 order by sort', [rfxId])).rows;
  return { lines, questions, ctx: { lines, questions } };
}

export async function loadAssumptions(pool: pg.Pool): Promise<Assumptions> {
  const r = await pool.query<{ key: string; value: number }>(`select key, value from assumptions where scope = 'global' and key in ('usd_inr','gst_pct') order by set_by = 'buyer' desc, created_at desc`);
  const get = (k: string, fallback: number) => Number(r.rows.find((x) => x.key === k)?.value ?? fallback);
  return { usd_inr: get('usd_inr', Number(process.env.DEFAULT_USD_INR ?? 96)), gst_pct: get('gst_pct', Number(process.env.DEFAULT_GST_PCT ?? 18)) };
}

export async function documentBytes(doc: DocumentRecord): Promise<Uint8Array> {
  if (doc.storage_path.startsWith('message:')) return new TextEncoder().encode(doc.message_body ?? '');
  const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false } });
  const { data, error } = await sb.storage.from(STORAGE_BUCKET).download(doc.storage_path);
  if (error || !data) throw new Error(`Could not read the stored file: ${error?.message ?? 'empty'}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function prepareDocument(doc: DocumentRecord): Promise<Prepared> {
  const bytes = await documentBytes(doc);
  if (doc.storage_path.startsWith('message:')) {
    return prepareMessageBody({ from: doc.message_from ?? '', subject: doc.message_subject ?? '', received: doc.received_at ?? '' }, doc.message_body ?? '');
  }
  return prepare(doc.mime, bytes);
}

export type ProcessResult = {
  document_id: string;
  filename: string;
  vendor: string;
  ok: boolean;
  kind?: string;
  error?: string;
  cache_hits: number;
  live_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_inr: number;
  lines?: number;
  statuses?: Record<string, number>;
  repaired?: boolean;
};

export type ProcessOptions = {
  deps: CallDeps;
  pool: pg.Pool;
  fresh: boolean;
  run_id: string | null;
  session_id: string;
  route: string;
  reconcile?: boolean;
};

const EXTRACTABLE = new Set(['quote', 'questionnaire']);
const FACTS = new Set(['certificate', 'profile']);

export async function processDocument(id: string, o: ProcessOptions): Promise<ProcessResult> {
  const doc = await loadDocument(o.pool, id);
  const res: ProcessResult = { document_id: id, filename: doc.filename, vendor: doc.vendor_name, ok: false, cache_hits: 0, live_calls: 0, tokens_in: 0, tokens_out: 0, cost_inr: 0 };
  const tally = (calls: { cache_hit: boolean; cost_inr: number; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } }[]) => {
    for (const c of calls) {
      if (c.cache_hit) res.cache_hits++;
      else {
        res.live_calls++;
        res.cost_inr += c.cost_inr;
        res.tokens_in += c.usage.input_tokens + c.usage.cache_read_input_tokens + c.usage.cache_creation_input_tokens;
        res.tokens_out += c.usage.output_tokens;
      }
    }
  };
  const fail = async (message: string) => {
    await o.pool.query(`update documents set status = 'failed', error = $2 where id = $1`, [id, message]);
    res.error = message;
    return res;
  };

  const stage: StageOptions = {
    deps: o.deps,
    models: { fast: process.env.MODEL_FAST ?? 'claude-haiku-4-5-20251001', extract: process.env.MODEL_EXTRACT ?? 'claude-sonnet-5-5' },
    base: { route: o.route, run_id: o.run_id, session_id: o.session_id, fresh: o.fresh },
  };
  const meta = { id: doc.id, filename: doc.filename, sha256: doc.sha256 };

  try {
    const prep = await prepareDocument(doc);
    const { lines, questions, ctx } = await loadRfxContext(o.pool, doc.rfx_id);
    const assumptions = await loadAssumptions(o.pool);

    const cls = await classify(prep, meta, stage);
    tally(cls.calls);
    if (!cls.ok) return await fail(`Classification failed: ${cls.error}`);
    res.kind = cls.data.kind;
    await o.pool.query(`update documents set kind = $2, kind_confidence = $3, status = 'classified', error = null where id = $1`, [id, cls.data.kind, cls.data.confidence]);

    const c = await o.pool.connect();
    try {
      await c.query('begin');
      await clearDocument(c, id);
      await persistObservations(c, { id, vendor_id: doc.vendor_id, filename: doc.filename, sha256: doc.sha256 }, prep);
      if (cls.data.confidence < 0.6) {
        await c.query(`insert into review_items (vendor_id, document_id, kind, severity, message) values ($1,$2,'low_classification_confidence','warn',$3)`, [doc.vendor_id, id, `${doc.filename}: unsure what kind of document this is (${cls.data.kind}, ${cls.data.confidence}). ${cls.data.reason}`]);
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }

    if (EXTRACTABLE.has(cls.data.kind)) {
      const x = await extract(prep, meta, ctx, stage);
      tally(x.calls);
      const p = loadPrompt('extract.v3');
      if (!x.ok) {
        await o.pool.query(`insert into extractions (document_id, model, prompt_version, raw_json, status, stage, run_id, cache_hit) values ($1,$2,$3,$4,'invalid','extract',$5,$6)`, [id, stage.models.extract, p.version, JSON.stringify({ raw: x.raw.slice(0, 20000) }), o.run_id, x.calls.every((k) => k.cache_hit)]);
        await o.pool.query(`insert into review_items (vendor_id, document_id, kind, severity, message) values ($1,$2,'extraction_invalid','block',$3)`, [doc.vendor_id, id, `${doc.filename}: ${x.error} Nothing from this document is used until it is re-run or entered by hand.`]);
        return await fail(x.error);
      }
      res.repaired = x.repaired;
      const c2 = await o.pool.connect();
      try {
        await c2.query('begin');
        const r = await persistExtraction(c2, { id, vendor_id: doc.vendor_id, filename: doc.filename, sha256: doc.sha256 }, prep, x.data, lines, questions, assumptions);
        res.lines = r.lines;
        res.statuses = r.statuses;
        const u = x.calls.reduce((s, k) => ({ i: s.i + k.usage.input_tokens + k.usage.cache_read_input_tokens + k.usage.cache_creation_input_tokens, o: s.o + k.usage.output_tokens, c: s.c + k.cost_inr }), { i: 0, o: 0, c: 0 });
        await c2.query(
          `insert into extractions (document_id, model, prompt_version, raw_json, tokens_in, tokens_out, est_cost_inr, status, stage, run_id, cache_hit)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'extract',$9,$10)`,
          [id, stage.models.extract, p.version, JSON.stringify(x.data), u.i, u.o, u.c, x.repaired ? 'repaired' : 'ok', o.run_id, x.calls.every((k) => k.cache_hit)],
        );
        await c2.query(`update documents set status = 'extracted', error = null where id = $1`, [id]);
        await c2.query('commit');
      } catch (e) {
        await c2.query('rollback');
        throw e;
      } finally {
        c2.release();
      }
    } else if (FACTS.has(cls.data.kind)) {
      const f = await certificateFacts(prep, meta, stage);
      tally(f.calls);
      if (!f.ok) return await fail(`Certificate read failed: ${f.error}`);
      const c3 = await o.pool.connect();
      try {
        await c3.query('begin');
        await persistCertificate(c3, { id, vendor_id: doc.vendor_id, filename: doc.filename, sha256: doc.sha256 }, f.data);
        await c3.query(`update documents set status = 'extracted', error = null where id = $1`, [id]);
        await c3.query('commit');
      } finally {
        c3.release();
      }
    } else {
      await o.pool.query(`update documents set status = 'extracted', error = null, source_note = 'No prices, answers or certificate facts; classified only.' where id = $1`, [id]);
    }

    if (o.reconcile !== false) await reconcileVendor(o.pool, doc.vendor_id);
    res.ok = true;
    return res;
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      await o.pool.query(`update documents set error = $2 where id = $1`, [id, e.message]);
      throw e;
    }
    return await fail((e as Error).message.split('\n')[0] ?? 'Unknown error');
  }
}
