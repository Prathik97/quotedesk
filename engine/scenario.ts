// Conditional discounts are scenario inputs. They are never part of a base price.
// This module decides, for a stated order value, whether a discount's threshold
// is met and what it would change. Nothing here is applied unless the caller asks.

export type ConditionalDiscount = {
  id: string;
  percent: number;
  /** The condition as the vendor wrote it, for example "single purchase order value above Rs. 25,00,000". */
  condition: string | null;
  /** The whole footnote. Used when the condition field is empty. */
  text: string;
};

export type DiscountCell = {
  code: string;
  price: number | null;
  annual_qty: number;
  conditions: string[];
};

export type DiscountOutcome = {
  discount_id: string;
  percent: number;
  threshold_inr: number | null;
  /** True when the order must be a single PO, so splitting the award loses the discount. */
  single_po_only: boolean;
  po_value_inr: number;
  /** True or false when the threshold is understood; null when it could not be read, in which case nothing is applied. */
  met: boolean | null;
  affected_codes: string[];
  /** What the discount would save on the affected lines at annual quantity, whether or not it is met. */
  potential_saving_inr: number;
  /** The saving that applies in this scenario: potential when met, else zero. */
  saving_inr: number;
  note: string;
};

const MONEY = /(?:rs\.?|inr|₹)\s*([\d][\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|l\b)?/gi;
const WORD_MONEY = /([\d][\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?)\b/gi;

function scale(unit: string | undefined): number {
  const u = (unit ?? '').toLowerCase();
  if (u.startsWith('cr')) return 1e7;
  if (u.startsWith('l')) return 1e5;
  return 1;
}

/** "Rs. 25,00,000", "Rs 25 lakh", "25 lakh", "INR 2.5 crore" to rupees. Null when no amount is found. */
export function parseThresholdInr(text: string | null | undefined): number | null {
  if (!text) return null;
  const found: number[] = [];
  for (const m of text.matchAll(MONEY)) {
    const v = Number((m[1] ?? '').replace(/,/g, ''));
    if (Number.isFinite(v)) found.push(v * scale(m[2]));
  }
  if (found.length === 0) {
    for (const m of text.matchAll(WORD_MONEY)) {
      const v = Number((m[1] ?? '').replace(/,/g, ''));
      if (Number.isFinite(v)) found.push(v * scale(m[2]));
    }
  }
  // Two different amounts in one condition is ambiguous: do not guess.
  const unique = [...new Set(found)];
  return unique.length === 1 ? (unique[0] as number) : null;
}

/** "above" and "over" are strict. "at least" and "minimum" include the threshold. */
function isStrict(text: string): boolean {
  if (/at least|not less than|minimum|min\.|or more|>=/i.test(text)) return false;
  return true;
}

/** A line carries the discount when one of its own conditions names the same percentage. */
export function lineCarriesDiscount(d: Pick<ConditionalDiscount, 'percent'>, conditions: string[]): boolean {
  const p = String(d.percent).replace('.', '\\.');
  const re = new RegExp(`(^|[^\\d.])${p}\\s*(%|percent|per cent)`, 'i');
  return conditions.some((c) => re.test(c) && /discount|rebate|off\b/i.test(c));
}

/**
 * @param cells one vendor's cells. PO value is every priced line at annual quantity
 *   and base price, the value of giving this vendor the whole RFx as one order.
 */
export function evaluateDiscounts(discounts: ConditionalDiscount[], cells: DiscountCell[]): DiscountOutcome[] {
  const priced = cells.filter((c) => c.price != null);
  const po = priced.reduce((s, c) => s + (c.price as number) * c.annual_qty, 0);
  return discounts.map((d) => {
    const words = d.condition ?? d.text;
    const threshold = parseThresholdInr(words) ?? parseThresholdInr(d.text);
    const affected = priced.filter((c) => lineCarriesDiscount(d, c.conditions));
    const potential = affected.reduce((s, c) => s + (c.price as number) * c.annual_qty * (d.percent / 100), 0);
    const singlePo = /single|one (purchase )?order|not (applicable )?on split|split orders/i.test(`${d.condition ?? ''} ${d.text}`);
    let met: boolean | null = null;
    let note: string;
    if (threshold == null) {
      note = 'The order value in the condition could not be read, so this discount is not applied. Read the footnote.';
    } else if (affected.length === 0) {
      note = 'No line carries this discount, so it changes nothing. Read the footnote.';
      met = po > threshold;
    } else {
      met = isStrict(words) ? po > threshold : po >= threshold;
      note = met
        ? `Order value ${po.toFixed(2)} meets the threshold ${threshold}.`
        : `Order value ${po.toFixed(2)} is below the threshold ${threshold}.`;
    }
    return {
      discount_id: d.id,
      percent: d.percent,
      threshold_inr: threshold,
      single_po_only: singlePo,
      po_value_inr: po,
      met,
      affected_codes: affected.map((c) => c.code),
      potential_saving_inr: potential,
      saving_inr: met === true ? potential : 0,
      note,
    };
  });
}

/** The price after the discounts that are met. Multiplicative if more than one applies. */
export function discountedPrice(price: number, code: string, outcomes: DiscountOutcome[]): { price: number; applied: number[] } {
  let v = price;
  const applied: number[] = [];
  for (const o of outcomes) {
    if (o.met === true && o.affected_codes.includes(code)) {
      v = v * (1 - o.percent / 100);
      applied.push(o.percent);
    }
  }
  return { price: v, applied };
}
