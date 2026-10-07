// Award engine tests. The fixtures are small and invented here, and every expected number
// below was worked out by hand (the arithmetic is in the comments), not copied from output.
import { describe, expect, it } from 'vitest';
import { AwardError, DEFAULT_SCENARIO, mergeScenario, simulateAward, type AwardCell, type AwardInput, type AwardVendor, type Scenario } from './award';
import type { CellStatus } from './certainty';

const FREE: AwardVendor['freight'] = { terms: 'included', amount_inr: null };

function vendor(key: string, q: AwardVendor['questionnaire'], freight = FREE, extra: Partial<AwardVendor> = {}): AwardVendor {
  return { id: `id-${key}`, key, name: `Vendor ${key}`, questionnaire: q, freight, discounts: [], open_items: [], ...extra };
}

function line(n: number, section: string, qty: number, ly: number) {
  return { id: `L${n}`, code: `L${n}`, section, description: `Line ${n}`, uom: 'piece', annual_qty: qty, ly_rate: ly, sort: n };
}

function cell(v: string, l: number, price: number | null, status: CellStatus = 'confirmed', conditions: string[] = []): AwardCell {
  return { vendor_id: `id-${v}`, line_id: `L${l}`, quote_line_id: price == null ? null : `q-${v}-${l}`, price, status: price == null ? 'missing' : status, conditions };
}

type ScnOver = { strategy?: Scenario['strategy']; filters?: Partial<Scenario['filters']>; constraints?: Partial<Scenario['constraints']> };
const scn = (over: ScnOver = {}): Scenario => ({
  strategy: over.strategy ?? DEFAULT_SCENARIO.strategy,
  filters: { ...DEFAULT_SCENARIO.filters, ...over.filters },
  constraints: { ...DEFAULT_SCENARIO.constraints, ...over.constraints },
});

// Four lines in two sections. LY value of each line is exactly 1,000, so LY total is 4,000.
//   L1 A qty 100 ly 10 | L2 A qty 200 ly 5 | L3 B qty 50 ly 20 | L4 B qty 10 ly 100
// VA cleared, freight included.   VB cleared, freight extra Rs 500.
// VC FAILED, cheapest, freight extra with no amount.   VD Pending, quoted nothing.
const lines = [line(1, 'A', 100, 10), line(2, 'A', 200, 5), line(3, 'B', 50, 20), line(4, 'B', 10, 100)];
const base: AwardInput = {
  vendors: [
    vendor('VA', 'Cleared'),
    vendor('VB', 'Cleared', { terms: 'extra', amount_inr: 500 }),
    vendor('VC', 'Failed', { terms: 'extra', amount_inr: null }),
    vendor('VD', 'Pending'),
  ],
  lines,
  cells: [
    cell('VA', 1, 9), cell('VA', 2, 5), cell('VA', 3, 21), cell('VA', 4, 90),
    cell('VB', 1, 10, 'assumed'), cell('VB', 2, 4, 'assumed'), cell('VB', 3, 19), cell('VB', 4, null),
    cell('VC', 1, 8), cell('VC', 2, 3), cell('VC', 3, 15), cell('VC', 4, 80),
    cell('VD', 1, null), cell('VD', 2, null), cell('VD', 3, null), cell('VD', 4, null),
  ],
};

describe('cheapest per line, cleared vendors only', () => {
  const r = simulateAward(base, scn());
  it('picks the lowest price per line among cleared vendors', () => {
    // L1 VA 9 (900), L2 VB 4 (800), L3 VB 19 (950), L4 VA 90 (900)
    expect(r.allocation.map((a) => a.vendor_key)).toEqual(['VA', 'VB', 'VB', 'VA']);
    expect(r.totals.goods_total_inr).toBeCloseTo(3550, 6);
  });
  it('computes savings against last year on the awarded lines', () => {
    // LY 4,000 less 3,550 = 450, which is 11.25 percent
    expect(r.totals.ly_value_of_awarded_lines_inr).toBe(4000);
    expect(r.totals.savings_vs_ly_inr).toBeCloseTo(450, 6);
    expect(r.totals.savings_vs_ly_pct).toBeCloseTo(11.25, 6);
  });
  it('splits value and concentration by vendor', () => {
    // VA 900+900 = 1,800 of 3,550 = 50.70 percent; VB 800+950 = 1,750
    const va = r.by_vendor.find((v) => v.vendor_key === 'VA');
    expect(va?.goods_value_inr).toBeCloseTo(1800, 6);
    expect(va?.share).toBeCloseTo(1800 / 3550, 9);
    expect(r.concentration.top_vendor_key).toBe('VA');
    expect(r.concentration.vendor_count).toBe(2);
    expect(r.concentration.hhi).toBeCloseTo((1800 / 3550) ** 2 + (1750 / 3550) ** 2, 9);
  });
  it('adds a known freight amount and reports completeness', () => {
    // VA 1,800 included; VB 1,750 + 500 = 2,250; landed total 4,050
    expect(r.totals.landed_total_inr).toBeCloseTo(4050, 6);
    expect(r.totals.landed_complete).toBe(true);
  });
  it('counts the cells it relies on by status', () => {
    // VA L1, VB L3, VA L4 confirmed; VB L2 assumed worth 800
    expect(r.reliance.confirmed).toBe(3);
    expect(r.reliance.assumed).toBe(1);
    expect(r.reliance.assumed_value_inr).toBeCloseTo(800, 6);
    expect(r.reliance.not_confirmed).toEqual([expect.objectContaining({ vendor_key: 'VB', line_code: 'L2', status: 'assumed' })]);
  });
  it('shows what the left out vendor would have saved, as an upper bound', () => {
    // VC is cheaper on every line: (9-8)*100 + (4-3)*200 + (19-15)*50 + (90-80)*10 = 100+200+200+100 = 600
    expect(r.excluded_cheaper).toEqual([expect.objectContaining({ vendor_key: 'VC', lines_cheaper: 4, saving_if_taken_inr: 600 })]);
  });
  it('lists runner up prices', () => {
    expect(r.allocation[0]?.runner_up).toEqual({ vendor_key: 'VB', price: 10 });
  });
});

describe('eligibility', () => {
  it('all vendors lets the failed vendor win, and warns', () => {
    // VC wins every line: 800 + 600 + 750 + 800 = 2,950
    const r = simulateAward(base, scn({ filters: { eligibility: 'all' } }));
    expect(r.totals.goods_total_inr).toBeCloseTo(2950, 6);
    expect(r.warnings.some((w) => w.includes('VC failed a knockout'))).toBe(true);
    expect(r.readiness.level).toBe('not_ready');
  });
  it('freight extra with no amount makes the landed total incomplete, never zero', () => {
    const r = simulateAward(base, scn({ filters: { eligibility: 'all' } }));
    expect(r.totals.landed_complete).toBe(false);
    expect(r.by_vendor[0]?.landed_total_inr).toBeCloseTo(2950, 6);
    expect(r.by_vendor[0]?.landed_complete).toBe(false);
  });
  it('excluding a vendor by request removes it', () => {
    const r = simulateAward(base, scn({ filters: { exclude_vendors: ['VB'] } }));
    // Only VA is eligible. VA quoted all four lines: 900+1000+1050+900 = 3,850
    expect(r.totals.goods_total_inr).toBeCloseTo(3850, 6);
    expect(r.vendors_considered.find((v) => v.vendor_key === 'VB')?.eligible).toBe(false);
  });
  it('rejects an unknown vendor key', () => {
    expect(() => simulateAward(base, scn({ filters: { exclude_vendors: ['V9'] } }))).toThrow(AwardError);
  });
  it('cleared_and_pending includes a Pending vendor with a clear label', () => {
    const r = simulateAward(base, scn({ filters: { eligibility: 'cleared_and_pending' } }));
    expect(r.eligibility_label).toMatch(/Pending/);
    expect(r.vendors_considered.find((v) => v.vendor_key === 'VD')?.eligible).toBe(true);
  });
});

describe('price basis and unresolved cells', () => {
  it('confirmed only drops Assumed prices and names the Assumed cell that would change the result', () => {
    // Without VB L2 (assumed 4), L2 goes to VA at 5: total 900 + 1000 + 950 + 900 = 3,750
    const r = simulateAward(base, scn({ filters: { price_basis: 'confirmed' } }));
    expect(r.totals.goods_total_inr).toBeCloseTo(3750, 6);
    expect(r.assumed_excluded_that_change_result).toEqual([expect.objectContaining({ vendor_key: 'VB', line_code: 'L2' })]);
  });

  const unresolved: AwardInput = { ...base, cells: base.cells.map((c) => (c.vendor_id === 'id-VA' && c.line_id === 'L1' ? { ...c, price: 8.5, status: 'needs_review' as const } : c)) };
  it('leaves a Needs review price out and says it would change the result', () => {
    // L1 goes to VB assumed 10 (1,000) instead of VA 9. Total 1000+800+950+900 = 3,650.
    const r = simulateAward(unresolved, scn());
    expect(r.allocation[0]?.vendor_key).toBe('VB');
    expect(r.totals.goods_total_inr).toBeCloseTo(3650, 6);
    expect(r.unresolved_that_change_result).toEqual([expect.objectContaining({ vendor_key: 'VA', line_code: 'L1', status: 'needs_review' })]);
    // Taken as read: L1 VA 8.5 = 850; total 850+800+950+900 = 3,500
    expect(r.total_if_unresolved_taken_as_read_inr).toBeCloseTo(3500, 6);
  });
  it('basis all uses it and counts it as relied on', () => {
    const r = simulateAward(unresolved, scn({ filters: { price_basis: 'all' } }));
    expect(r.totals.goods_total_inr).toBeCloseTo(3500, 6);
    expect(r.reliance.needs_review).toBe(1);
    expect(r.reliance.unresolved_value_inr).toBeCloseTo(850, 6);
  });
  it('a Needs review cell blocks readiness for an included vendor only', () => {
    expect(simulateAward(unresolved, scn()).readiness.level).toBe('not_ready');
    // VA excluded: its unresolved cell no longer matters.
    const r = simulateAward(unresolved, scn({ filters: { exclude_vendors: ['VA'] } }));
    expect(r.readiness.blockers.find((b) => b.vendor_key === 'VA')).toBeUndefined();
  });
});

describe('other strategies', () => {
  it('single vendor leaves lines the vendor did not quote as gaps, never zero', () => {
    // VB: L1 1000 + L2 800 + L3 950 = 2,750, L4 not quoted
    const r = simulateAward(base, scn({ strategy: 'single_vendor', constraints: { vendor: 'VB' } }));
    expect(r.totals.goods_total_inr).toBeCloseTo(2750, 6);
    expect(r.totals.lines_awarded).toBe(3);
    expect(r.coverage_gaps.map((g) => g.line_code)).toEqual(['L4']);
    expect(r.totals.ly_value_of_gap_lines_inr).toBe(1000);
    // Like for like: LY of awarded lines 3,000 less 2,750 = 250
    expect(r.totals.savings_vs_ly_inr).toBeCloseTo(250, 6);
    expect(r.reliance.missing).toBe(1);
  });
  it('single vendor refuses an ineligible vendor and says how to look anyway', () => {
    expect(() => simulateAward(base, scn({ strategy: 'single_vendor', constraints: { vendor: 'VC' } }))).toThrow(/not eligible/);
    expect(simulateAward(base, scn({ strategy: 'single_vendor', constraints: { vendor: 'VC' }, filters: { eligibility: 'all' } })).totals.goods_total_inr).toBeCloseTo(2950, 6);
  });
  it('single vendor needs a vendor', () => {
    expect(() => simulateAward(base, scn({ strategy: 'single_vendor' }))).toThrow(/needs constraints.vendor/);
  });
  it('cheapest per section awards a section to one vendor that quoted all of it', () => {
    // Section A: VA 900+1000 = 1,900; VB 1000+800 = 1,800 so VB. Section B: VB did not quote L4, so VA: 1050+900 = 1,950.
    const r = simulateAward(base, scn({ strategy: 'cheapest_per_section' }));
    expect(r.allocation.map((a) => a.vendor_key)).toEqual(['VB', 'VB', 'VA', 'VA']);
    expect(r.totals.goods_total_inr).toBeCloseTo(3750, 6);
  });
  it('split cap reports honestly when the cap cannot be met', () => {
    // VA holds 50.7 percent. Moving L1 to VB would put VB at 75 percent. Nothing can move.
    const r = simulateAward(base, scn({ strategy: 'split_cap', constraints: { max_share: 0.5 } }));
    expect(r.warnings.join(' ')).toMatch(/could not be met/);
    expect(r.totals.goods_total_inr).toBeCloseTo(3550, 6);
  });
  it('split cap leaves a compliant award untouched', () => {
    const r = simulateAward(base, scn({ strategy: 'split_cap', constraints: { max_share: 0.6 } }));
    expect(r.totals.goods_total_inr).toBeCloseTo(3550, 6);
    expect(r.warnings.join(' ')).toMatch(/cap 60 percent met/i);
  });
  it('split cap moves business to respect the cap and never beats the unconstrained total', () => {
    const r = simulateAward(base, scn({ strategy: 'split_cap', constraints: { max_share: 0.5 }, filters: { eligibility: 'all' } }));
    const free = simulateAward(base, scn({ filters: { eligibility: 'all' } }));
    expect(r.totals.goods_total_inr).toBeGreaterThanOrEqual(free.totals.goods_total_inr - 1e-9);
    for (const v of r.by_vendor) expect(v.share).toBeLessThanOrEqual(0.5 + 1e-6);
  });
  it('split cap needs a cap', () => {
    expect(() => simulateAward(base, scn({ strategy: 'split_cap' }))).toThrow(/max_share/);
  });
});

describe('coverage gaps', () => {
  it('a line only an ineligible vendor quoted is a gap that names the vendor', () => {
    const input: AwardInput = { ...base, cells: base.cells.map((c) => (c.line_id === 'L4' && c.vendor_id === 'id-VA' ? { ...c, price: null, status: 'missing' as const, quote_line_id: null } : c)) };
    const r = simulateAward(input, scn());
    expect(r.coverage_gaps).toHaveLength(1);
    expect(r.coverage_gaps[0]?.quoted_by_ineligible).toEqual([{ vendor_key: 'VC', price: 80 }]);
    expect(r.totals.goods_total_inr).toBeCloseTo(2650, 6); // 900 + 800 + 950
  });
});

describe('conditional discounts and the fixed point', () => {
  const disc = (threshold: string): AwardVendor['discounts'] => [{ id: 'd1', percent: 4, condition: `single PO value above Rs. ${threshold}`, text: `4 percent discount for a single PO above Rs. ${threshold}` }];
  const COND = ['4% special discount on this line for single PO above threshold'];
  // X: 10 on every line. Y: 10.20 on L1 and L2 (discountable), 11 on L3. Each line qty 100.
  const mk = (threshold: string): AwardInput => ({
    vendors: [vendor('X', 'Cleared'), vendor('Y', 'Cleared', FREE, { discounts: disc(threshold) })],
    lines: [line(1, 'S', 100, 12), line(2, 'S', 100, 12), line(3, 'S', 100, 12)],
    cells: [cell('X', 1, 10), cell('X', 2, 10), cell('X', 3, 10), cell('Y', 1, 10.2, 'confirmed', COND), cell('Y', 2, 10.2, 'confirmed', COND), cell('Y', 3, 11)],
  });
  const on = scn({ filters: { apply_discounts: true } });

  it('never applies a discount unless asked', () => {
    const r = simulateAward(mk('1,500'), scn());
    expect(r.totals.goods_total_inr).toBeCloseTo(3000, 6); // X wins everything
    expect(r.discounts[0]?.applied).toBe(false);
  });
  it('finds the consistent answer where the discount makes the vendor win enough to earn it', () => {
    // With the discount Y is 10.20 * 0.96 = 9.792 on L1 and L2 and wins both (979.20 each). X keeps L3 (1,000).
    // Y list PO = 1,020 + 1,020 = 2,040, above 1,500, so the discount holds. Total 979.2 + 979.2 + 1000 = 2,958.4.
    const r = simulateAward(mk('1,500'), on);
    expect(r.totals.goods_total_inr).toBeCloseTo(2958.4, 6);
    expect(r.allocation.map((a) => a.vendor_key)).toEqual(['Y', 'Y', 'X']);
    expect(r.allocation[0]?.price).toBeCloseTo(9.792, 9);
    expect(r.allocation[0]?.discount_pct).toBe(4);
    const d = r.discounts[0];
    expect(d?.applied).toBe(true);
    expect(d?.met).toBe(true);
    expect(d?.vendor_po_value_inr).toBeCloseTo(2040, 6);
    expect(d?.saving_inr).toBeCloseTo(81.6, 6); // 4 percent of 2,040
    expect(r.fixed_point.converged).toBe(true);
    expect(r.fixed_point.tried).toHaveLength(2);
    expect(r.fixed_point.tried.map((t) => t.total_goods_inr).sort((a, b) => a - b)[0]).toBeCloseTo(2958.4, 6);
    expect(r.fixed_point.note).toMatch(/Two consistent answers/);
  });
  it('does not apply a discount whose threshold the award cannot reach', () => {
    // Y would hold 2,040 at list, below 3,000, so the discount cannot be earned and X wins everything.
    const r = simulateAward(mk('3,000'), on);
    expect(r.totals.goods_total_inr).toBeCloseTo(3000, 6);
    expect(r.discounts[0]?.applied).toBe(false);
    expect(r.discounts[0]?.gap_to_threshold_inr).toBeCloseTo(3000, 6); // Y holds nothing in the final answer
  });
  it('is strict about "above": equal to the threshold does not qualify', () => {
    const r = simulateAward(mk('2,040'), on);
    expect(r.discounts[0]?.met).toBe(false);
    expect(r.totals.goods_total_inr).toBeCloseTo(3000, 6);
  });
  it('an unreadable threshold is never applied', () => {
    const input = mk('1,500');
    input.vendors[1]!.discounts = [{ id: 'd1', percent: 4, condition: 'on large orders', text: '4 percent discount on large orders' }];
    const r = simulateAward(input, on);
    expect(r.discounts[0]?.threshold_inr).toBeNull();
    expect(r.discounts[0]?.applied).toBe(false);
    expect(r.totals.goods_total_inr).toBeCloseTo(3000, 6);
  });
  it('the discount touches only the lines that carry it', () => {
    const r = simulateAward(mk('1,500'), on);
    expect(r.allocation[2]?.discount_pct).toBeNull();
    expect(r.allocation[2]?.vendor_key).toBe('X');
  });
});

describe('scenario readiness', () => {
  const input: AwardInput = {
    ...base,
    vendors: base.vendors.map((v) => (v.key === 'VB' ? { ...v, open_items: [{ kind: 'total_mismatch', severity: 'warn' as const, message: 'Stated total does not add up.' }] } : v)),
  };
  it('open items alone give Ready with open items, not Not ready', () => {
    const r = simulateAward(input, scn());
    expect(r.readiness.level).toBe('ready_with_open_items');
    expect(r.readiness.label).toBe('Ready with open items');
    expect(r.readiness.open_items.some((i) => i.kind === 'total_mismatch')).toBe(true);
  });
  it('a pending knockout among included vendors makes it Not ready', () => {
    const r = simulateAward(input, scn({ filters: { eligibility: 'cleared_and_pending' } }));
    expect(r.readiness.level).toBe('not_ready');
    expect(r.readiness.blockers).toEqual([expect.objectContaining({ vendor_key: 'VD', kind: 'knockout_pending' })]);
  });
  it('a Pending vendor outside the scenario does not block it', () => {
    expect(simulateAward(input, scn()).readiness.blockers).toHaveLength(0);
  });
  it('freight extra with no amount is an open item, not a blocker', () => {
    const r = simulateAward({ ...input, vendors: input.vendors.map((v) => (v.key === 'VB' ? { ...v, freight: { terms: 'extra' as const, amount_inr: null } } : v)) }, scn());
    expect(r.readiness.blockers).toHaveLength(0);
    expect(r.readiness.open_items.some((i) => i.kind === 'freight_amount_unknown' && i.vendor_key === 'VB')).toBe(true);
  });
});

describe('mergeScenario', () => {
  it('a follow up changes only what it names', () => {
    const prev = scn({ strategy: 'split_cap', constraints: { max_share: 0.6 }, filters: { exclude_vendors: ['VA'], apply_discounts: true } });
    const next = mergeScenario(prev, { filters: { exclude_vendors: ['VA', 'VC'] } });
    expect(next.strategy).toBe('split_cap');
    expect(next.constraints.max_share).toBe(0.6);
    expect(next.filters.apply_discounts).toBe(true);
    expect(next.filters.exclude_vendors).toEqual(['VA', 'VC']);
  });
  it('null clears a constraint', () => {
    const prev = scn({ constraints: { vendor: 'VA' } });
    expect(mergeScenario(prev, { constraints: { vendor: null } }).constraints.vendor).toBeNull();
  });
});
