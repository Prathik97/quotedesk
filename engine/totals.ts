// Vendor totals at annual quantity, and landed cost. Missing lines are never zero:
// they are counted and valued at last year's rate only as information.
import { landedTotal } from './convert';
import type { LineStatus } from './types';

export type TotalCell = {
  annual_qty: number;
  last_year_rate_inr: number | null;
  /** Normalized price after any scenario discount, or null when not quoted. */
  price: number | null;
  status: LineStatus;
};

export type Freight = { terms: 'included' | 'extra' | 'unknown'; amount_inr: number | null };

export type VendorTotal = {
  goods_total_inr: number;
  lines_priced: number;
  lines_total: number;
  lines_missing: number;
  /** What the missing lines would cost at last year's rate. Information only, never added to the total. */
  missing_value_at_ly_inr: number;
  /** Value of lines whose status is needs review or conflict. */
  unresolved_value_inr: number;
  assumed_value_inr: number;
  confirmed_value_inr: number;
  freight: Freight;
  landed_total_inr: number;
  /** False when freight is unknown or lines are missing: the figure is a floor, not a total. */
  complete: boolean;
  incomplete_reasons: string[];
};

export function vendorTotal(cells: TotalCell[], freight: Freight): VendorTotal {
  let goods = 0;
  let priced = 0;
  let missing = 0;
  let missingLy = 0;
  let unresolved = 0;
  let assumed = 0;
  let confirmed = 0;
  for (const c of cells) {
    if (c.price == null) {
      missing++;
      missingLy += (c.last_year_rate_inr ?? 0) * c.annual_qty;
      continue;
    }
    const v = c.price * c.annual_qty;
    goods += v;
    priced++;
    if (c.status === 'needs_review' || c.status === 'conflict') unresolved += v;
    else if (c.status === 'assumed') assumed += v;
    else if (c.status === 'confirmed') confirmed += v;
  }
  const landed = landedTotal(goods, freight);
  const reasons: string[] = [];
  if (!landed.complete) reasons.push(landed.reason);
  if (missing > 0) reasons.push(`${missing} ${missing === 1 ? 'line is' : 'lines are'} not quoted, so the total covers ${priced} of ${cells.length} lines.`);
  return {
    goods_total_inr: goods,
    lines_priced: priced,
    lines_total: cells.length,
    lines_missing: missing,
    missing_value_at_ly_inr: missingLy,
    unresolved_value_inr: unresolved,
    assumed_value_inr: assumed,
    confirmed_value_inr: confirmed,
    freight,
    landed_total_inr: landed.total_inr,
    complete: reasons.length === 0,
    incomplete_reasons: reasons,
  };
}

/** Lowest price per line among eligible cells. Ties return all tied indices. */
export function lowestIndices(prices: (number | null)[], eligible: boolean[]): number[] {
  let best = Infinity;
  prices.forEach((p, i) => {
    if (p != null && eligible[i] && p < best) best = p;
  });
  if (best === Infinity) return [];
  return prices.flatMap((p, i) => (p != null && eligible[i] && Math.abs(p - best) < 1e-9 ? [i] : []));
}
