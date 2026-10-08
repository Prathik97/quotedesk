// Read only access to the seeded FY27 RFx and its five vendors, for the saved outbox and the saved pack.
// Nothing here writes. Drafts never copy or change these rows.
import type pg from 'pg';
import { describeRule, type PassRule } from '../../../engine/questionnaire.js';
import type { PackInput } from './pack.js';

export type SavedVendor = { id: string; vendor_key: string | null; name: string; contact_email: string | null };

export async function savedVendors(pool: pg.Pool): Promise<SavedVendor[]> {
  const r = await pool.query<SavedVendor>(
    `select v.id, v.vendor_key, v.name, v.contact_email from vendors v join rfx r on r.id = v.rfx_id where r.is_saved_demo order by v.vendor_key`,
  );
  return r.rows;
}

export async function savedBuyerOrg(pool: pg.Pool): Promise<string> {
  const r = await pool.query<{ buyer_org: string }>(`select buyer_org from rfx where is_saved_demo order by created_at limit 1`);
  return r.rows[0]?.buyer_org ?? 'The buyer';
}

export async function loadSavedPack(pool: pg.Pool): Promise<PackInput | null> {
  const x = (await pool.query(`select * from rfx where is_saved_demo order by created_at limit 1`)).rows[0] as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!x) return null;
  const [lines, qs] = await Promise.all([
    pool.query(`select code, section, description, spec, uom, annual_qty from rfx_lines where rfx_id = $1 order by sort`, [x.id]),
    pool.query(`select code, text, is_knockout, pass_rule from questionnaire_questions where rfx_id = $1 order by sort`, [x.id]),
  ]);
  return {
    title: x.title, buyer_org: x.buyer_org, ref: x.ref ?? null, scope_summary: `${x.category}. Annual rate contract for the plant at ${x.delivery_location ?? 'the buyer'}.`,
    delivery_location: x.delivery_location ?? null, payment_terms_days: x.payment_terms_requested_days ?? null, validity_days: x.validity_days ?? null,
    gst_basis: x.gst_basis_requested ?? null, currency: x.currency ?? 'INR', timeline: { clarifications_by_day: null, quotes_due_day: null, award_by_day: null },
    lines: lines.rows.map((l) => ({ code: l.code, section: l.section, description: l.description, spec: l.spec ?? null, unit: l.uom, annual_qty: Number(l.annual_qty) })),
    questions: qs.rows.map((q) => ({ code: q.code, text: q.text, is_knockout: q.is_knockout, rule: describeRule((q.pass_rule ?? null) as PassRule | null) })),
  };
}
