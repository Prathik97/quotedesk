// Loads what the analyst tools need: the comparison payload (the same one the grid uses),
// open review items, and the award input derived from them at a given set of assumptions.
import type pg from 'pg';
import type { AwardInput } from '../../../engine/award.js';
import type { Assumptions } from '../../../engine/types.js';
import type { CompareResponse } from '../../../src/lib/api-types.js';
import { awardInputFromCompare, globalAssumptionsOf, safeMessage } from '../../../src/lib/awardInput.js';
import { loadCompare } from '../compare/data.js';

export type OpenItemRow = {
  id: string;
  vendor_id: string;
  quote_line_id: string | null;
  line_code: string | null;
  kind: string;
  severity: 'info' | 'warn' | 'block';
  message: string;
  value_at_stake_inr: number | null;
};

export type AnalystData = { compare: CompareResponse; items: OpenItemRow[] };

export { safeMessage };

export async function loadAnalystData(pool: pg.Pool): Promise<AnalystData> {
  const [compare, items] = await Promise.all([
    loadCompare(pool),
    pool.query<{
      id: string; vendor_id: string; quote_line_id: string | null; line_code: string | null; kind: string; severity: 'info' | 'warn' | 'block'; message: string; value: string | null;
    }>(
      `select i.id, i.vendor_id, i.quote_line_id, l.code as line_code, i.kind, i.severity, i.message, i.value_at_stake_inr as value
       from review_items i left join quote_lines q on q.id = i.quote_line_id left join rfx_lines l on l.id = q.rfx_line_id
       where i.state = 'open' order by i.created_at`,
    ),
  ]);
  return {
    compare,
    items: items.rows.map((r) => ({
      id: r.id, vendor_id: r.vendor_id, quote_line_id: r.quote_line_id, line_code: r.line_code, kind: r.kind, severity: r.severity,
      message: safeMessage(r.kind, r.message), value_at_stake_inr: r.value == null ? null : Number(r.value),
    })),
  };
}

export function globalAssumptions(c: CompareResponse): Assumptions {
  return globalAssumptionsOf(c);
}

/** The award input at the given assumptions. Cells are re-derived with the same engine function the grid uses. */
export function buildAwardInput(data: AnalystData, a: Assumptions): AwardInput {
  return awardInputFromCompare(data.compare, a, data.items);
}

/** Resolves "V3", "vendor 3", "Sunrise" or "Kaveri Packaging" to a vendor key. Null when nothing matches. */
export function resolveVendor(c: CompareResponse, ref: string): string | null {
  const t = ref.trim().toLowerCase();
  const num = /^(?:v|vendor)\s*#?\s*(\d)$/.exec(t);
  if (num) {
    const k = `V${num[1]}`;
    return c.vendors.some((v) => v.key === k) ? k : null;
  }
  const exact = c.vendors.find((v) => v.key.toLowerCase() === t);
  if (exact) return exact.key;
  const hits = c.vendors.filter((v) => v.name.toLowerCase().includes(t) || t.includes(v.name.toLowerCase().split(' ')[0] ?? '@@'));
  return hits.length === 1 ? (hits[0] as { key: string }).key : null;
}
