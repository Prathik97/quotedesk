// Sensitivity tests. The fixture is tiny and every expected number was worked out by hand.
//
//   L1 qty 100, last year 10      L2 qty 50, last year 20
//   VA (cleared): L1 9.00, L2 21.00. A 10 percent discount on both lines for a single PO above Rs 1,500.
//   VB (cleared): L1 priced in USD at 0.10 per unit (so 0.10 x the USD rate), L2 19.00.
//   VF (failed):  cheapest on everything, never eligible.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENARIO, simulateAward, type AwardInput, type Scenario } from './award';
import { runSensitivity } from './decision';
import type { Assumptions } from './types';

function makeInput(a: Assumptions): AwardInput {
  const disc = ['10% special discount'];
  return {
    vendors: [
      { id: 'a', key: 'VA', name: 'Vendor A', questionnaire: 'Cleared', freight: { terms: 'included', amount_inr: null }, discounts: [{ id: 'VA-d1', percent: 10, condition: 'single PO above Rs. 1,500', text: '10% discount above Rs 1,500' }], open_items: [] },
      { id: 'b', key: 'VB', name: 'Vendor B', questionnaire: 'Cleared', freight: { terms: 'included', amount_inr: null }, discounts: [], open_items: [] },
      { id: 'f', key: 'VF', name: 'Vendor F', questionnaire: 'Failed', freight: { terms: 'included', amount_inr: null }, discounts: [], open_items: [] },
    ],
    lines: [
      { id: 'L1', code: 'L1', section: 'S', description: 'one', uom: 'piece', annual_qty: 100, ly_rate: 10, sort: 1 },
      { id: 'L2', code: 'L2', section: 'S', description: 'two', uom: 'piece', annual_qty: 50, ly_rate: 20, sort: 2 },
    ],
    cells: [
      { vendor_id: 'a', line_id: 'L1', quote_line_id: 'qa1', price: 9, status: 'confirmed', conditions: disc },
      { vendor_id: 'a', line_id: 'L2', quote_line_id: 'qa2', price: 21, status: 'confirmed', conditions: disc },
      { vendor_id: 'b', line_id: 'L1', quote_line_id: 'qb1', price: 0.1 * a.usd_inr, status: 'assumed', conditions: [] },
      { vendor_id: 'b', line_id: 'L2', quote_line_id: 'qb2', price: 19, status: 'confirmed', conditions: [] },
      { vendor_id: 'f', line_id: 'L1', quote_line_id: 'qf1', price: 1, status: 'confirmed', conditions: [] },
      { vendor_id: 'f', line_id: 'L2', quote_line_id: 'qf2', price: 1, status: 'confirmed', conditions: [] },
    ],
  };
}

const at96: Assumptions = { usd_inr: 96, gst_pct: 18 };
const base = (s: Scenario = DEFAULT_SCENARIO) => simulateAward(makeInput(at96), s);

describe('USD sweep', () => {
  const s = runSensitivity(makeInput, at96, DEFAULT_SCENARIO, base());
  it('covers 85, 96 and 105 and marks the current rate', () => {
    expect(s.fx.map((r) => r.usd_inr)).toEqual([85, 96, 105]);
    expect(s.fx.filter((r) => r.is_current).map((r) => r.usd_inr)).toEqual([96]);
  });
  it('totals without the discount follow the USD line', () => {
    // 85: VB L1 8.50 beats VA 9.00 -> 850 + 950 = 1,800.  96 and 105: VA L1 9.00 -> 900 + 950 = 1,850.
    expect(s.fx.map((r) => r.without_discount.goods_inr)).toEqual([expect.closeTo(1800, 6), expect.closeTo(1850, 6), expect.closeTo(1850, 6)]);
  });
  it('totals with the discount use the cheaper consistent answer', () => {
    // VA wins both lines with the discount: 9 x 0.9 x 100 + 21 x 0.9 x 50 = 810 + 945 = 1,755. VA list PO is 1,950, above 1,500.
    // At 85 the no discount answer (1,800) is also consistent, and 1,755 is cheaper.
    for (const r of s.fx) expect(r.with_discount.goods_inr).toBeCloseTo(1755, 6);
  });
  it('adds the current rate to the sweep when it is not one of the three', () => {
    const at90: Assumptions = { usd_inr: 90, gst_pct: 18 };
    const r = runSensitivity(makeInput, at90, DEFAULT_SCENARIO, simulateAward(makeInput(at90), DEFAULT_SCENARIO));
    expect(r.fx.map((x) => x.usd_inr)).toEqual([85, 90, 96, 105]);
    expect(r.fx.find((x) => x.is_current)?.usd_inr).toBe(90);
    // At 90 VB L1 costs 9.00, a tie with VA, and the tie goes to the vendor key VA: 900 + 950.
    expect(r.fx.find((x) => x.is_current)?.without_discount.goods_inr).toBeCloseTo(1850, 6);
  });
  it('says when the discount changes nothing', () => {
    const noDisc = (a: Assumptions): AwardInput => ({ ...makeInput(a), vendors: makeInput(a).vendors.map((v) => ({ ...v, discounts: [] })) });
    const r = runSensitivity(noDisc, at96, DEFAULT_SCENARIO, simulateAward(noDisc(at96), DEFAULT_SCENARIO));
    expect(r.discount_in_play).toBe(false);
    expect(r.discount_note).toMatch(/No eligible vendor has a conditional discount/);
  });
});

describe('top vendor lost', () => {
  it('re runs without the vendor holding the most value', () => {
    // Base at 96: L1 VA 900, L2 VB 950. VB is top (950 against 900). Without VB: VA 900 + 21 x 50 = 1,950. Difference +100, which is 100 / 1,850 = 5.405 percent.
    const s = runSensitivity(makeInput, at96, DEFAULT_SCENARIO, base());
    const t = s.top_vendor_lost!;
    expect(t.vendor_key).toBe('VB');
    expect(t.cell.goods_inr).toBeCloseTo(1950, 6);
    expect(t.goods_delta_inr).toBeCloseTo(100, 6);
    expect(t.goods_delta_pct).toBeCloseTo((100 / 1850) * 100, 9);
    expect(t.like_for_like).toBe(true);
    expect(t.new_top_vendor).toBe('VA');
    expect(t.strategy_note).toBeNull();
  });
  it('does not call it like for like when lines lose all coverage', () => {
    // Only VB quotes L1 here, so losing VB leaves L1 uncovered and the total falls for the wrong reason.
    const sparse = (a: Assumptions): AwardInput => ({ ...makeInput(a), cells: makeInput(a).cells.filter((c) => !(c.vendor_id === 'a' && c.line_id === 'L1')) });
    const b = simulateAward(sparse(at96), DEFAULT_SCENARIO);
    const t = runSensitivity(sparse, at96, DEFAULT_SCENARIO, b).top_vendor_lost!;
    // Base: L1 VB 9.60 x 100 = 960, L2 VB 19 x 50 = 950 -> VB holds everything. Without VB: L2 VA 1,050 only, L1 uncovered.
    expect(t.vendor_key).toBe('VB');
    expect(t.cell.goods_inr).toBeCloseTo(1050, 6);
    expect(t.like_for_like).toBe(false);
    expect(t.goods_delta_inr).toBeNull();
    expect(t.lines_uncovered).toEqual(['L1']);
    expect(t.note).toMatch(/Not like for like/);
  });
  it('falls back to cheapest per line for a single vendor scenario and says so', () => {
    const single: Scenario = { ...DEFAULT_SCENARIO, strategy: 'single_vendor', constraints: { vendor: 'VB', max_share: null } };
    const s = runSensitivity(makeInput, at96, single, simulateAward(makeInput(at96), single));
    // VB alone: 9.60 x 100 + 19 x 50 = 960 + 950 = 1,910. Without VB, cheapest per line among VA: 1,950. Difference +40.
    const t = s.top_vendor_lost!;
    expect(t.strategy_note).toMatch(/no answer without VB/);
    expect(t.cell.goods_inr).toBeCloseTo(1950, 6);
    expect(t.goods_delta_inr).toBeCloseTo(40, 6);
  });
  it('never brings in a vendor the filters left out', () => {
    // VF failed and is the cheapest everywhere. It must not appear when VB is lost.
    const t = runSensitivity(makeInput, at96, DEFAULT_SCENARIO, base()).top_vendor_lost!;
    expect(t.new_top_vendor).not.toBe('VF');
  });
});
