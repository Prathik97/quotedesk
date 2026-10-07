// GET /api/vendor?id=X: one vendor's summary with terms, notes, totals and what makes the total incomplete.
import { z } from 'zod';
import { vendorTotal } from '../engine/totals.js';
import type { VendorDetail } from '../src/lib/api-types.js';
import { loadCompare } from './_lib/compare/data.js';
import { db } from './_lib/db.js';
import { ApiError, route } from './_lib/http.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export default route(['GET'], async (req): Promise<VendorDetail> => {
  const q = z.object({ id: z.string().uuid() }).safeParse(req.query);
  if (!q.success) throw new ApiError(400, 'bad_request', 'Pass the vendor id as ?id=.');
  const pool = db();
  const [compare, t] = await Promise.all([
    loadCompare(pool),
    pool.query<Json>('select global_notes, suspicious_content, unit_definitions from vendor_terms where vendor_id = $1', [q.data.id]),
  ]);
  const vendor = compare.vendors.find((v) => v.id === q.data.id);
  if (!vendor) throw new ApiError(404, 'not_found', 'That vendor does not exist. Reload the page.');
  const lineById = new Map(compare.lines.map((l) => [l.id, l]));
  const cells = compare.cells.filter((c) => c.vendor_id === vendor.id).map((c) => {
    const l = lineById.get(c.rfx_line_id);
    return { annual_qty: l?.annual_qty ?? 0, last_year_rate_inr: l?.ly_rate ?? null, price: c.price, status: c.status };
  });
  const total = vendorTotal(cells, { terms: vendor.freight_terms, amount_inr: vendor.freight_amount_inr });
  const row = t.rows[0] ?? {};
  return {
    vendor,
    notes: ((row.global_notes ?? []) as Json[]).map((n) => ({ text: n.text, document_id: n.document_id ?? null })),
    suspicious: ((row.suspicious_content ?? []) as Json[]).map((s) => ({ text: s.text, locator: s.evidence?.locator ?? null })),
    unit_definitions: ((row.unit_definitions ?? []) as Json[]).map((u) => ({ term: u.term, means: `${u.means_quantity} ${u.means_unit ?? ''}`.trim(), quote: u.evidence?.quote ?? null, locator: u.evidence?.locator ?? null })),
    unresolved_value_inr: total.unresolved_value_inr,
    assumed_value_inr: total.assumed_value_inr,
    confirmed_value_inr: total.confirmed_value_inr,
    goods_total_inr: total.goods_total_inr,
    landed_total_inr: total.landed_total_inr,
    complete: total.complete,
    incomplete_reasons: total.incomplete_reasons,
    missing_value_at_ly_inr: total.missing_value_at_ly_inr,
  };
});
