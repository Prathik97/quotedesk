// Vendor level deterministic checks, run after any document of the vendor changes:
// conflicts, stated total, freight, certificates, knockouts, coverage. Idempotent.
import type pg from 'pg';
import { evaluateKnockouts, type AnswerForRule, type KnockoutQuestion } from '../../../engine/questionnaire.js';
import { detectConflicts, namesMatch, reconcileTotal } from '../../../engine/verify.js';
import type { CertificateFacts } from '../../../src/lib/schemas/extraction.js';

export const RECONCILE_KINDS = [
  'conflict', 'total_mismatch', 'freight_amount_unknown', 'freight_terms_unknown', 'certificate_expired',
  'attachment_name_mismatch', 'knockout_failed', 'knockout_pending', 'not_quoted',
];

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export async function reconcileVendor(pool: pg.Pool, vendorId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('delete from review_items where vendor_id = $1 and kind = any($2)', [vendorId, RECONCILE_KINDS]);
    await c.query(`update quote_lines set status = conversion->>'base_status' where vendor_id = $1 and status = 'conflict' and conversion ? 'base_status'`, [vendorId]);
    const add = (kind: string, severity: string, message: string, extra: { document_id?: string | null; quote_line_id?: string | null; value?: number | null } = {}) =>
      c.query('insert into review_items (vendor_id, document_id, quote_line_id, kind, severity, message, value_at_stake_inr) values ($1,$2,$3,$4,$5,$6,$7)', [
        vendorId, extra.document_id ?? null, extra.quote_line_id ?? null, kind, severity, message, extra.value ?? null,
      ]);

    const vendor = (await c.query<{ name: string; rfx_id: string }>('select name, rfx_id from vendors where id = $1', [vendorId])).rows[0];
    if (!vendor) throw new Error('Vendor not found.');
    const submitted = (await c.query<{ d: string | null }>(`select to_char(min(received_at), 'YYYY-MM-DD') d from vendor_messages where vendor_id = $1`, [vendorId])).rows[0]?.d ?? null;

    // Conflicts: two or more values for the same RFx line.
    const ql = (await c.query<{ id: string; rfx_line_id: string; code: string; normalized_price_inr: string | null; source_document_id: string; annual_qty: string }>(
      `select q.id, q.rfx_line_id, l.code, q.normalized_price_inr, q.source_document_id, l.annual_qty
       from quote_lines q join rfx_lines l on l.id = q.rfx_line_id where q.vendor_id = $1 and q.status <> 'rejected'`, [vendorId])).rows;
    const byLine = new Map<string, typeof ql>();
    for (const q of ql) byLine.set(q.rfx_line_id, [...(byLine.get(q.rfx_line_id) ?? []), q]);
    for (const [, group] of byLine) {
      const ids = detectConflicts(group.map((g) => ({ id: g.id, normalized_inr: g.normalized_price_inr == null ? null : Number(g.normalized_price_inr) })));
      if (ids.length) {
        await c.query(`update quote_lines set status = 'conflict' where id = any($1)`, [ids]);
        const vals = group.filter((g) => ids.includes(g.id)).map((g) => fmt(Number(g.normalized_price_inr))).join(' vs ');
        await add('conflict', 'warn', `${group[0]?.code}: sources disagree (${vals} per unit).`, { quote_line_id: ids[0] });
      }
    }

    // Stated total vs sum of that document's lines.
    const terms = (await c.query<{ stated_total_inr: string | null; stated_total_evidence: { document_id?: string } | null; freight_terms: string; freight_amount_inr: string | null; letterhead_name: string | null }>(
      'select stated_total_inr, stated_total_evidence, freight_terms, freight_amount_inr, letterhead_name from vendor_terms where vendor_id = $1', [vendorId])).rows[0];
    if (terms?.stated_total_inr && terms.stated_total_evidence?.document_id) {
      const docId = terms.stated_total_evidence.document_id;
      const lines = ql.filter((q) => q.source_document_id === docId && q.normalized_price_inr != null).map((q) => ({ normalized_inr: Number(q.normalized_price_inr), annual_qty: Number(q.annual_qty) }));
      if (lines.length) {
        const t = reconcileTotal(lines, Number(terms.stated_total_inr));
        if (t.mismatch) {
          await add('total_mismatch', 'warn', `Stated grand total Rs ${fmt(t.stated_inr)} differs from the sum of its ${lines.length} lines times annual quantity, Rs ${fmt(t.computed_inr)} (${t.delta_pct.toFixed(2)} percent). Neither figure is trusted until resolved.`, { document_id: docId, value: Math.abs(t.stated_inr - t.computed_inr) });
        }
      }
    }

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
    let isoExpiry = null as string | null;
    for (const d of docs) {
      const f = d.facts;
      if (!f) continue;
      const flags: string[] = [];
      if (f.doc_type === 'iso_9001' && f.expiry_date) isoExpiry = isoExpiry && isoExpiry > f.expiry_date ? isoExpiry : f.expiry_date;
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
    const qs = (await c.query<KnockoutQuestion & { id: string }>('select id, code, is_knockout, pass_rule from questionnaire_questions where rfx_id = $1', [vendor.rfx_id])).rows;
    const ans = (await c.query<{ code: string; status: AnswerForRule['status']; answer_value: unknown; basis: 'explicit' | 'inferred' }>(
      'select q.code, a.status, a.answer_value, a.basis from questionnaire_answers a join questionnaire_questions q on q.id = a.question_id where a.vendor_id = $1', [vendorId])).rows;
    const answers: Record<string, AnswerForRule> = Object.fromEntries(ans.map((a) => [a.code, { status: a.status, value: a.answer_value, basis: a.basis }]));
    let result: string | null = null;
    if (submitted && (ans.length > 0 || docs.length > 0)) {
      const r = evaluateKnockouts(qs, answers, submitted, isoExpiry);
      result = r.result;
      const fails = Object.entries(r.knockouts).filter(([, k]) => k.outcome === 'fail');
      const pend = Object.entries(r.knockouts).filter(([, k]) => k.outcome === 'pending');
      for (const [code, k] of fails) await add('knockout_failed', 'warn', `Knockout ${code} failed: ${k.reason}`);
      for (const [code, k] of pend) await add('knockout_pending', 'warn', `Knockout ${code} cannot be decided: ${k.reason}`);
    }
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
