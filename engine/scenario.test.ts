import { describe, expect, it } from 'vitest';
import { discountedPrice, evaluateDiscounts, lineCarriesDiscount, parseThresholdInr, type ConditionalDiscount, type DiscountCell } from './scenario';

describe('parseThresholdInr', () => {
  it('reads Indian grouped rupees', () => {
    expect(parseThresholdInr('single purchase order value above Rs. 25,00,000 excl. GST')).toBe(2500000);
  });
  it('reads lakh and crore words', () => {
    expect(parseThresholdInr('PO value above 25 lakh')).toBe(2500000);
    expect(parseThresholdInr('orders over Rs 2.5 crore')).toBe(25000000);
    expect(parseThresholdInr('INR 25 Lakhs')).toBe(2500000);
  });
  it('does not take the percentage or GST rate as an amount', () => {
    expect(parseThresholdInr('4% discount, GST 18% extra')).toBeNull();
  });
  it('refuses to guess when two different amounts appear', () => {
    expect(parseThresholdInr('above Rs. 25,00,000 and below Rs. 50,00,000')).toBeNull();
  });
  it('returns null for text with no amount', () => {
    expect(parseThresholdInr('on large orders')).toBeNull();
    expect(parseThresholdInr(null)).toBeNull();
  });
});

const D: ConditionalDiscount = {
  id: 'd1',
  percent: 4,
  condition: 'single purchase order value above Rs. 25,00,000 excl. GST; not on split orders',
  text: 'Special discount of 4% on carton items applicable only for a single purchase order above Rs. 25,00,000',
};
const COND = '4% discount if single PO above Rs. 25,00,000 excl. GST';

function cells(): DiscountCell[] {
  return [
    { code: 'A', price: 10, annual_qty: 200000, conditions: [COND] }, // 20,00,000
    { code: 'B', price: 5, annual_qty: 100000, conditions: [COND] }, // 5,00,000
    { code: 'C', price: 100, annual_qty: 10000, conditions: [] }, // 10,00,000, not discounted
    { code: 'D', price: null, annual_qty: 5, conditions: [] },
  ];
}

describe('lineCarriesDiscount', () => {
  it('matches the same percentage and a discount word only', () => {
    expect(lineCarriesDiscount(D, [COND])).toBe(true);
    expect(lineCarriesDiscount(D, ['payment within 30 days'])).toBe(false);
    expect(lineCarriesDiscount(D, ['14% discount'])).toBe(false);
    expect(lineCarriesDiscount(D, ['4 percent rebate on pallets'])).toBe(true);
  });
});

describe('evaluateDiscounts', () => {
  it('applies when the order value is above the threshold, and shows the effect', () => {
    const [o] = evaluateDiscounts([D], cells());
    expect(o?.po_value_inr).toBe(3500000);
    expect(o?.threshold_inr).toBe(2500000);
    expect(o?.met).toBe(true);
    expect(o?.affected_codes).toEqual(['A', 'B']);
    expect(o?.saving_inr).toBeCloseTo(0.04 * 2500000, 6);
    expect(o?.single_po_only).toBe(true);
  });

  it('does not apply when below the threshold but still reports the potential saving', () => {
    const small = cells().map((c) => ({ ...c, annual_qty: c.annual_qty / 10 }));
    const [o] = evaluateDiscounts([D], small);
    expect(o?.met).toBe(false);
    expect(o?.saving_inr).toBe(0);
    expect(o?.potential_saving_inr).toBeGreaterThan(0);
  });

  it('is strict for above and inclusive for at least', () => {
    const exact = [{ code: 'A', price: 25, annual_qty: 100000, conditions: [COND] }];
    expect(evaluateDiscounts([D], exact)[0]?.met).toBe(false);
    const atLeast: ConditionalDiscount = { ...D, condition: 'order value of at least Rs. 25,00,000' };
    expect(evaluateDiscounts([atLeast], exact)[0]?.met).toBe(true);
  });

  it('never applies a discount whose threshold cannot be read', () => {
    const vague: ConditionalDiscount = { id: 'v', percent: 4, condition: 'on large orders', text: '4% discount on large orders' };
    const [o] = evaluateDiscounts([vague], cells());
    expect(o?.met).toBeNull();
    expect(o?.saving_inr).toBe(0);
    expect(o?.note).toContain('not applied');
  });

  it('missing lines are not counted as zero cost or priced', () => {
    const [o] = evaluateDiscounts([D], cells());
    expect(o?.po_value_inr).toBe(3500000);
  });
});

describe('discountedPrice', () => {
  it('discounts only affected lines when met', () => {
    const [o] = evaluateDiscounts([D], cells());
    expect(discountedPrice(10, 'A', [o!])).toEqual({ price: 9.6, applied: [4] });
    expect(discountedPrice(100, 'C', [o!])).toEqual({ price: 100, applied: [] });
  });
  it('leaves the price alone when the threshold is not met', () => {
    const small = cells().map((c) => ({ ...c, annual_qty: 1 }));
    const [o] = evaluateDiscounts([D], small);
    expect(discountedPrice(10, 'A', [o!]).price).toBe(10);
  });
});
