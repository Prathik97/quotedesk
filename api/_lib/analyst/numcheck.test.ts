import { describe, expect, it } from 'vitest';
import { checkNumbers, extractFigures } from './numcheck';

const tool = JSON.stringify({ totals: { goods_total_inr: 39812345.67, savings_vs_ly_inr: 450.5, savings_vs_ly_pct: 7.25 }, share: 0.507, vendor: 'V2', note: 'discount above Rs. 25 lakh', lines: 30 });

describe('checkNumbers', () => {
  it('accepts figures that appear in a tool result, including lakh and crore forms', () => {
    const r = checkNumbers('The award costs ₹3.98 crore (₹39,812,345.67 exactly) and saves 7.25%.', [tool]);
    expect(r.unmatched).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('accepts a lakh figure the model rewrote from rupees', () => {
    expect(checkNumbers('That is about 398.12 lakh.', [tool]).ok).toBe(true);
  });
  it('accepts a share stored as a fraction when written as a percent', () => {
    expect(checkNumbers('One vendor holds 50.7 percent.', [tool]).ok).toBe(true);
  });
  it('flags a figure the tools never produced', () => {
    const r = checkNumbers('The saving is ₹1,234.00.', [tool]);
    expect(r.ok).toBe(false);
    expect(r.unmatched[0]?.value).toBe(1234);
  });
  it('flags arithmetic the model did itself (a sum of two tool numbers)', () => {
    const r = checkNumbers('Total with freight is 40,012,345.67.', [tool]);
    expect(r.ok).toBe(false);
  });
  it('accepts numbers from the question and the static context', () => {
    expect(checkNumbers('At 85 the total moves.', ['What if the rate is 85 and 92?']).ok).toBe(true);
  });
  it('accepts truncation as well as rounding of a displayed figure', () => {
    expect(checkNumbers('About 3.98 crore.', [JSON.stringify({ t: 39850000 })]).ok).toBe(true);
  });
  it('skips years, vendor codes, list markers and line codes', () => {
    const f = extractFigures('1. V2 and Q1 on 31 Mar 2026 for CRT-5P-01 in 2026.');
    expect(f.map((x) => x.value)).toEqual([31]);
  });
  it('compares negatives by magnitude', () => {
    expect(checkNumbers('It costs 450.5 more.', [JSON.stringify({ d: -450.5 })]).ok).toBe(true);
  });
  it('reads Indian grouping', () => {
    expect(extractFigures('Rs 4,01,29,300')[0]?.value).toBe(40129300);
  });
  it('does not accept a near miss at the displayed precision', () => {
    expect(checkNumbers('Saves 7.5%.', [tool]).ok).toBe(false);
  });
});
