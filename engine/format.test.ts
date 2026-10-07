import { describe, expect, it } from 'vitest';
import { formatIndian, formatInrCompact } from './format';

describe('formatIndian', () => {
  it('groups in lakh and crore positions', () => {
    expect(formatIndian(40129300)).toBe('4,01,29,300.00');
    expect(formatIndian(120000, 0)).toBe('1,20,000');
    expect(formatIndian(999)).toBe('999.00');
    expect(formatIndian(1000)).toBe('1,000.00');
  });
  it('handles negatives and rounding for display', () => {
    expect(formatIndian(-2500000.456)).toBe('-25,00,000.46');
  });
  it('never renders a missing value as zero', () => {
    expect(formatIndian(Number.NaN)).toBe('Not available');
  });
});

describe('formatInrCompact', () => {
  it('uses crore, lakh, then plain rupees', () => {
    expect(formatInrCompact(40129300)).toBe('₹4.01 crore');
    expect(formatInrCompact(2500000)).toBe('₹25.00 lakh');
    expect(formatInrCompact(4200)).toBe('₹4,200.00');
  });
});
