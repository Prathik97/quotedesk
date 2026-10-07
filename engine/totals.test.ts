import { describe, expect, it } from 'vitest';
import { lowestIndices, vendorTotal, type TotalCell } from './totals';

const cells: TotalCell[] = [
  { annual_qty: 1000, last_year_rate_inr: 10, price: 10, status: 'confirmed' },
  { annual_qty: 500, last_year_rate_inr: 20, price: 22, status: 'assumed' },
  { annual_qty: 100, last_year_rate_inr: 50, price: 40, status: 'needs_review' },
  { annual_qty: 10, last_year_rate_inr: 1000, price: null, status: 'missing' },
];

describe('vendorTotal', () => {
  it('sums priced lines only and never treats a missing line as zero cost', () => {
    const t = vendorTotal(cells, { terms: 'included', amount_inr: null });
    expect(t.goods_total_inr).toBe(10000 + 11000 + 4000);
    expect(t.lines_priced).toBe(3);
    expect(t.lines_missing).toBe(1);
    expect(t.missing_value_at_ly_inr).toBe(10000);
    expect(t.complete).toBe(false);
    expect(t.incomplete_reasons.join(' ')).toContain('1 line is not quoted');
  });
  it('splits value by status', () => {
    const t = vendorTotal(cells, { terms: 'included', amount_inr: null });
    expect(t.confirmed_value_inr).toBe(10000);
    expect(t.assumed_value_inr).toBe(11000);
    expect(t.unresolved_value_inr).toBe(4000);
  });
  it('freight included adds nothing and keeps the total complete when all lines are quoted', () => {
    const t = vendorTotal(cells.slice(0, 3), { terms: 'included', amount_inr: null });
    expect(t.landed_total_inr).toBe(25000);
    expect(t.complete).toBe(true);
  });
  it('freight extra with a known amount is added', () => {
    const t = vendorTotal(cells.slice(0, 3), { terms: 'extra', amount_inr: 1500 });
    expect(t.landed_total_inr).toBe(26500);
    expect(t.complete).toBe(true);
  });
  it('freight extra with no amount makes the total incomplete and does not assume zero', () => {
    const t = vendorTotal(cells.slice(0, 3), { terms: 'extra', amount_inr: null });
    expect(t.complete).toBe(false);
    expect(t.incomplete_reasons[0]).toContain('Freight extra with no amount');
    expect(t.landed_total_inr).toBe(25000);
  });
  it('unknown freight terms are also incomplete', () => {
    const t = vendorTotal(cells.slice(0, 3), { terms: 'unknown', amount_inr: null });
    expect(t.complete).toBe(false);
  });
});

describe('lowestIndices', () => {
  it('picks the lowest among eligible cells only', () => {
    expect(lowestIndices([10, 8, 9], [true, false, true])).toEqual([2]);
    expect(lowestIndices([10, 8, 9], [true, true, true])).toEqual([1]);
  });
  it('returns ties and ignores missing prices', () => {
    expect(lowestIndices([5, null, 5], [true, true, true])).toEqual([0, 2]);
    expect(lowestIndices([null, null], [true, true])).toEqual([]);
  });
});
