// Loads the saved demo RFx (lines, questions, vendors, global assumptions) into
// Postgres and uploads every generated file to Supabase Storage.
// Vendor messages and documents are not inserted here: the "Simulate vendor
// replies" control drops them into the inbox (phase 6), and phase 2 tooling
// inserts them for extraction runs. Idempotent: replaces the saved demo RFx.
// Usage: npm run seed:db
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { pgConfig } from '../api/_lib/pgconfig.js';
import { loadEnvLocal, requireEnv } from '../scripts/envfile.js';

type Spec = {
  buyer: { name: string };
  rfx: {
    ref: string;
    title: string;
    category: string;
    delivery_location: string;
    payment_terms_requested_days: number;
    validity_days: number;
    gst_basis_requested: string;
    currency: string;
    issued_on: string;
  };
  lines: { code: string; section: string; description: string; uom: string; annual_qty: number; ly_rate: number; is_one_time?: boolean }[];
  questions: { code: string; text: string; answer_type: string; is_knockout: boolean; pass_rule: unknown }[];
  vendors: { key: string; name: string; legal_name: string; email: string; location: string }[];
};

export const BUCKET = 'documents';
const ROOT = path.resolve('seed');
const OUT = path.join(ROOT, 'out');

const MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.eml': 'message/rfc822',
  '.json': 'application/json',
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

async function uploadFiles(): Promise<number> {
  const sb = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
  const { data: buckets, error: listErr } = await sb.storage.listBuckets();
  if (listErr) throw new Error(`storage list failed: ${listErr.message}`);
  if (!buckets.some((b) => b.name === BUCKET)) {
    const { error } = await sb.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 10 * 1024 * 1024 });
    if (error) throw new Error(`bucket create failed: ${error.message}`);
  }
  // truth.json is the hidden answer key: it stays in the repo for the eval harness, never in Storage.
  const files = walk(OUT).filter((f) => path.basename(f) !== 'truth.json');
  for (const f of files) {
    const rel = path.relative(OUT, f).split(path.sep).join('/');
    const key = `seed/${rel.replace(/[^A-Za-z0-9._/-]/g, '_')}`;
    const { error } = await sb.storage.from(BUCKET).upload(key, fs.readFileSync(f), {
      contentType: MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream',
      upsert: true,
    });
    if (error) throw new Error(`upload ${rel} failed: ${error.message}`);
  }
  return files.length;
}

async function loadRows(spec: Spec): Promise<void> {
  const c = new pg.Client(pgConfig(requireEnv('SUPABASE_DB_URL')));
  await c.connect();
  try {
    await c.query('begin');
    await c.query('delete from rfx where is_saved_demo');
    await c.query("delete from assumptions where scope = 'global' and set_by = 'system'");
    const r = spec.rfx;
    const { rows } = await c.query<{ id: string }>(
      `insert into rfx (ref, title, category, buyer_org, status, is_saved_demo, delivery_location,
         payment_terms_requested_days, validity_days, gst_basis_requested, currency, issued_at)
       values ($1,$2,$3,$4,'issued',true,$5,$6,$7,$8,$9,$10) returning id`,
      [r.ref, r.title, r.category, spec.buyer.name, r.delivery_location, r.payment_terms_requested_days, r.validity_days,
        r.gst_basis_requested, r.currency, r.issued_on],
    );
    const rfxId = rows[0]?.id;
    if (!rfxId) throw new Error('rfx insert returned no id');
    for (const [i, l] of spec.lines.entries()) {
      await c.query(
        `insert into rfx_lines (rfx_id, code, section, description, uom, annual_qty, last_year_rate_inr, is_one_time, sort)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rfxId, l.code, l.section, l.description, l.uom, l.annual_qty, l.ly_rate, l.is_one_time ?? false, i + 1],
      );
    }
    for (const [i, q] of spec.questions.entries()) {
      await c.query(
        `insert into questionnaire_questions (rfx_id, code, text, answer_type, is_knockout, pass_rule, sort)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [rfxId, q.code, q.text, q.answer_type, q.is_knockout, JSON.stringify(q.pass_rule), i + 1],
      );
    }
    for (const v of spec.vendors) {
      await c.query(
        `insert into vendors (rfx_id, vendor_key, name, legal_name, contact_email, location) values ($1,$2,$3,$4,$5,$6)`,
        [rfxId, v.key, v.name, v.legal_name, v.email, v.location],
      );
    }
    const usd = Number(requireEnv('DEFAULT_USD_INR'));
    const gst = Number(requireEnv('DEFAULT_GST_PCT'));
    await c.query(
      `insert into assumptions (key, label, value, scope, set_by, note) values
       ('usd_inr', 'USD to INR rate', $1, 'global', 'system', 'Default from configuration. No vendor stated a rate.'),
       ('gst_pct', 'GST rate for inclusive to exclusive conversion', $2, 'global', 'system', 'Default from configuration. Display and conversion only.')`,
      [JSON.stringify(usd), JSON.stringify(gst)],
    );
    await c.query('commit');
    const counts = await c.query<{ t: string; n: string }>(
      `select 'rfx' t, count(*) n from rfx where is_saved_demo
       union all select 'rfx_lines', count(*) from rfx_lines l join rfx r on r.id = l.rfx_id and r.is_saved_demo
       union all select 'questions', count(*) from questionnaire_questions q join rfx r on r.id = q.rfx_id and r.is_saved_demo
       union all select 'vendors', count(*) from vendors v join rfx r on r.id = v.rfx_id and r.is_saved_demo
       union all select 'comparison_view rows', count(*) from comparison_view c join rfx r on r.id = c.rfx_id and r.is_saved_demo
       union all select 'assumptions', count(*) from assumptions`,
    );
    for (const row of counts.rows) console.log(`${row.t}: ${row.n}`);
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'rfx.json'), 'utf8')) as Spec;
  await loadRows(spec);
  const n = await uploadFiles();
  console.log(`storage: ${n} files uploaded to bucket '${BUCKET}' under seed/`);
}

main().catch((e: Error) => {
  console.error(e.message.split('\n')[0]);
  process.exit(1);
});
