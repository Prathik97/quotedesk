// Vendor level deterministic checks, run after any document of the vendor changes:
// conflicts, stated total, freight, certificates, knockouts, coverage. Idempotent.
import type pg from 'pg';
import { evaluateVendor, type KnockoutQuestion, type StoredAnswer } from '../../../engine/questionnaire.js';
import { detectConflicts, namesMatch, reconcileTotal } from '../../../engine/verify.js';
import type { CertificateFacts } from '../../../src/lib/schemas/extraction.js';

/** Checks that depend on prices. They are the only ones an FX, GST or value change can alter. */
export const PRICE_KINDS = ['conflict', 'total_mismatch'];
export const RECONCILE_KINDS = [
  'freight_amount_unknown', 'freight_terms_unknown', 'certificate_expired',
  'attachment_name_mismatch', 'knockout_failed', 'knockout_pending', 'not_quoted',
];

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

type Queryable = { query: pg.Pool['query'] };

/** Knockout outcomes for one vendor from the stored answers and any certificate expiry. No model involved. */
export async function evaluateVendorQuestionnaire(c: Queryable, vendorId: string, rfxId: string) {
  const submitted = ((await c.query(`select to_char(min(received_at), 'YYYY-MM-DD') d from vendor_messages where vendor_id = $1`, [vendorId])) as { rows: { d: string | null }[] }).rows[0]?.d ?? null;
  const docs = ((await c.query(`select facts from documents where vendor_id = $1 and facts is not null`, [vendorId])) as { rows: { facts: CertificateFacts }[] }).rows;
  const qs = ((await c.query('select id, code, is_knockout, pass_rule from questionnaire_questions where rfx_id = $1', [rfxId])) as { rows: (KnockoutQuestion & { id: string })[] }).rows;
  const ans = (
    (await c.query(
      'select q.code, a.status, a.answer_value, a.basis from questionnaire_answers a join questionnaire_questions q on q.id = a.question_id where a.vendor_id = $1',
      [vendorId],
    )) as { rows: StoredAnswer[] }
  ).rows;
  return { ...evaluateVendor(qs, ans, submitted, docs.map((d) => d.facts)), submitted };
}

type PriceLine = { id: string; vendor_id: string; rfx_line_id: string; code: string; normalized: number | null; source_document_id: string; annual_qty: number };

/**
 * Conflicts and stated total checks for a set of vendors, in a handful of queries.
 * Run inside the caller's transaction. Dismissed items stay dismissed while the
 * same finding is regenerated.
 */
export async function reconcilePrices(c: pg.PoolClient, vendorIds: string[]): Promise<void> {
  if (vendorIds.length === 0) return;
  const lines = (
    await c.query<PriceLine>(
      `select q.id, q.vendor_id, q.rfx_line_id, l.code, q.normalized_price_inr::float8 as normalized, q.source_document_id, l.annual_qty::float8 as annual_qty
       from quote_lines q join rfx_lines l on l.id = q.rfx_line_id where q.vendor_id = any($1) and q.status <> 'rejected'`,
      [vendorIds],
    )
  ).rows;
  const terms = new Map(
    (
      await c.query<{ vendor_id: string; stated_total_inr: string | null; stated_total_evidence: { document_id?: string } | null }>(
        'select vendor_id, stated_total_inr, stated_total_evidence from vendor_terms where vendor_id = any($1)',
        [vendorIds],
      )
    ).rows.map((t) => [t.vendor_id, t]),
  );
  const carried = new Map(
    (
      await c.query<{ fingerprint: string; state: string; resolution: unknown }>(
        `select fingerprint, state, resolution from review_items where vendor_id = any($1) and kind = any($2) and state <> 'open' and fingerprint is not null`,
        [vendorIds, PRICE_KINDS],
      )
    ).rows.map((r) => [r.fingerprint, r]),
  );
  type Item = { vendor_id: string; kind: string; message: string; document_id: string | null; quote_line_id: string | null; value: number | null };
  const items: Item[] = [];
  const conflicted: string[] = [];

  for (const vendorId of vendorIds) {
    const mine = lines.filter((l) => l.vendor_id === vendorId);
    const byLine = new Map<string, PriceLine[]>();
    for (const q of mine) byLine.set(q.rfx_line_id, [...(byLine.get(q.rfx_line_id) ?? []), q]);
    for (const group of byLine.values()) {
      const ids = detectConflicts(group.map((g) => ({ id: g.id, normalized_inr: g.normalized })));
      if (ids.length) {
        conflicted.push(...ids);
        const vals = group.filter((g) => ids.includes(g.id)).map((g) => fmt(g.normalized ?? 0)).join(' vs ');
        items.push({ vendor_id: vendorId, kind: 'conflict', message: `${group[0]?.code}: sources disagree (${vals} per unit).`, document_id: null, quote_line_id: ids[0] ?? null, value: null });
      }
    }
    const t = terms.get(vendorId);
    const docId = t?.stated_total_evidence?.document_id;
    if (t?.stated_total_inr && docId) {
      const own = mine.filter((q) => q.source_document_id === docId && q.normalized != null).map((q) => ({ normalized_inr: q.normalized as number, annual_qty: q.annual_qty }));
      if (own.length) {
        const r = reconcileTotal(own, Number(t.stated_total_inr));
        if (r.mismatch) {
          items.push({
            vendor_id: vendorId, kind: 'total_mismatch', document_id: docId, quote_line_id: null, value: Math.abs(r.stated_inr - r.computed_inr),
            message: `Stated grand total Rs ${fmt(r.stated_inr)} differs from the sum of its ${own.length} lines times annual quantity, Rs ${fmt(r.computed_inr)} (${r.delta_pct.toFixed(2)} percent). Neither figure is trusted until resolved.`,
          });
        }
      }
    }
  }

  await c.query(`update quote_lines set status = conversion->>'base_status' where vendor_id = any($1) and status = 'conflict' and conversion ? 'base_status'`, [vendorIds]);
  await c.query('delete from review_items where vendor_id = any($1) and kind = any($2)', [vendorIds, PRICE_KINDS]);
  if (conflicted.length) await c.query(`update quote_lines set status = 'conflict' where id = any($1)`, [conflicted]);
  if (items.length) {
    const rows = items.map((i) => {
      const fp = [i.kind, i.document_id ?? '', i.quote_line_id ?? '', i.message.slice(0, 48)].join('|');
      const prior = carried.get(fp);
      return { vendor_id: i.vendor_id, kind: i.kind, message: i.message, document_id: i.document_id, quote_line_id: i.quote_line_id, value: i.value, fp, state: prior?.state ?? 'open', resolution: prior ? prior.resolution : null };
    });
    await c.query(
      `insert into review_items (vendor_id, document_id, quote_line_id, kind, severity, message, value_at_stake_inr, fingerprint, state, resolution)
       select d.vendor_id, d.document_id, d.quote_line_id, d.kind, 'warn', d.message, d.value, d.fp, d.state, d.resolution
       from jsonb_to_recordset($1::jsonb) as d(vendor_id uuid, kind text, message text, document_id uuid, quote_line_id uuid, value numeric, fp text, state text, resolution jsonb)`,
      [JSON.stringify(rows)],
    );
  }
}

export async function reconcileVendor(pool: pg.Pool, vendorId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    // A dismissed or resolved item stays that way while the same finding is regenerated.
    const carried = new Map(
      (await c.query<{ fingerprint: string; state: string; resolution: unknown }>(
        `select fingerprint, state, resolution from review_items where vendor_id = $1 and kind = any($2) and state <> 'open' and fingerprint is not null`,
        [vendorId, RECONCILE_KINDS],
      )).rows.map((r) => [r.fingerprint, r]),
    );
    await c.query('delete from review_items where vendor_id = $1 and kind = any($2)', [vendorId, RECONCILE_KINDS]);
    const add = (kind: string, severity: string, message: string, extra: { document_id?: string | null; quote_line_id?: string | null; value?: number | null } = {}) => {
      const fp = [kind, extra.document_id ?? '', extra.quote_line_id ?? '', message.slice(0, 48)].join('|');
      const prior = carried.get(fp);
      return c.query(
        'insert into review_items (vendor_id, document_id, quote_line_id, kind, severity, message, value_at_stake_inr, fingerprint, state, resolution) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [vendorId, extra.document_id ?? null, extra.quote_line_id ?? null, kind, severity, message, extra.value ?? null, fp, prior?.state ?? 'open', prior ? JSON.stringify(prior.resolution) : null],
      );
    };

    const vendor = (await c.query<{ name: string; rfx_id: string }>('select name, rfx_id from vendors where id = $1', [vendorId])).rows[0];
    if (!vendor) throw new Error('Vendor not found.');
    const submitted = (await c.query<{ d: string | null }>(`select to_char(min(received_at), 'YYYY-MM-DD') d from vendor_messages where vendor_id = $1`, [vendorId])).rows[0]?.d ?? null;

    await reconcilePrices(c, [vendorId]);
    const terms = (await c.query<{ freight_terms: string; freight_amount_inr: string | null; letterhead_name: string | null }>(
      'select freight_terms, freight_amount_inr, letterhead_name from vendor_terms where vendor_id = $1', [vendorId])).rows[0];
    const ql = (await c.query<{ id: string }>(`select id from quote_lines where vendor_id = $1 and status <> 'rejected'`, [vendorId])).rows;

    // Freight
    if (terms?.freight_terms === 'extra' && terms.freight_amount_inr == null) {
      await add('freight_amount_unknown', 'warn', 'Freight is extra and no amount is stated. Landed cost is incomplete; freight is not assumed to be zero.');
    } else if (!terms || terms.freight_terms === 'unknown') {
      const anyQuote = ql.length > 0;
      if (anyQuote) await add('freight_terms_unknown', 'info', 'Freight terms not stated. Landed cost is incomplete.');
    }

    // Certificates and other attachments
    const docs = (await c.query<{ id: string; filename: string; facts: CertificateFacts | null }>(`select id, filename, facts from documents where vendor_id = $1 and facts is not null`, [vendorId])).rows;
    const letterhead = terms?.letterhead_name ?? null;
    for (const d of docs) {
      const f = d.facts;
      if (!f) continue;
      const flags: string[] = [];
      if (f.expiry_date && submitted && f.expiry_date < submitted) {
        flags.push('expired');
        await add('certificate_expired', 'warn', `${d.filename}: ${f.standard ?? f.doc_type} certificate ${f.certificate_number ?? ''} expired on ${f.expiry_date}, before the reply date ${submitted}.`, { document_id: d.id });
      }
      if (f.legal_name) {
        const refs = [letterhead, vendor.name].filter((x): x is string => !!x);
        if (!refs.some((r) => namesMatch(f.legal_name ?? '', r))) {
          flags.push('name_mismatch');
          const tradeMatches = f.trade_name ? refs.some((r) => namesMatch(f.trade_name ?? '', r)) : false;
          await add('attachment_name_mismatch', 'warn', `${d.filename}: legal name "${f.legal_name}" differs from the quote letterhead "${letterhead ?? vendor.name}".${tradeMatches ? ` The trade name "${f.trade_name}" matches, so check which legal entity will invoice.` : ''}`, { document_id: d.id });
        }
      }
      await c.query('update documents set flags = $2 where id = $1', [d.id, flags]);
    }

    // Knockouts
    const q = await evaluateVendorQuestionnaire(c, vendorId, vendor.rfx_id);
    const result = q.result;
    for (const [code, k] of Object.entries(q.knockouts).filter(([, k]) => k.outcome === 'fail')) await add('knockout_failed', 'warn', `Knockout ${code} failed: ${k.reason}`);
    for (const [code, k] of Object.entries(q.knockouts).filter(([, k]) => k.outcome === 'pending')) await add('knockout_pending', 'warn', `Knockout ${code} cannot be decided: ${k.reason}`);
    await c.query(
      `update vendor_terms set flags = array(select unnest(flags) except select unnest(array['questionnaire_cleared','questionnaire_failed','questionnaire_pending'])) || $2::text[] where vendor_id = $1`,
      [vendorId, result ? [`questionnaire_${result.toLowerCase()}`] : []],
    );

    // Coverage
    if (ql.length > 0) {
      const missing = (await c.query<{ code: string; v: string }>(
        `select l.code, (l.annual_qty * coalesce(l.last_year_rate_inr, 0))::text v from rfx_lines l
         where l.rfx_id = $1 and not exists (select 1 from quote_lines q where q.vendor_id = $2 and q.rfx_line_id = l.id and q.status <> 'rejected')
         order by l.sort`, [vendor.rfx_id, vendorId])).rows;
      if (missing.length) {
        await add('not_quoted', 'info', `Not quoted: ${missing.map((m) => m.code).join(', ')}. Shown as Not quoted, never as zero.`, { value: missing.reduce((s, m) => s + Number(m.v), 0) });
      }
    }
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
