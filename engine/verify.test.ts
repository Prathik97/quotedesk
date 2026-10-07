import { describe, expect, it } from 'vitest';
import { assignStatus, coversExactlyRemainder, detectConflicts, lineFlags, namesMatch, numbersIn, quoteContainsNumber, reconcileTotal, type StatusInput } from './verify';

describe('evidence number check', () => {
  it('reads Indian and western grouping', () => {
    expect(numbersIn('Rs. 4,20,57,101.22 and 1,234.5 and 44310')).toEqual([42057101.22, 1234.5, 44310]);
  });
  it('accepts the number in any grouping or trailing zeros', () => {
    expect(quoteContainsNumber('Rate Rs. 2,719.00 per box*', 2719)).toBe(true);
    expect(quoteContainsNumber('C7: 44310', 44310)).toBe(true);
    expect(quoteContainsNumber('at Rs. 4,122.88 each', 4122.88)).toBe(true);
  });
  it('rejects a number that is not in the quote', () => {
    expect(quoteContainsNumber('Rs. 27.63 per pc', 27.36)).toBe(false);
    expect(quoteContainsNumber(null, 1)).toBe(false);
  });
});

describe('lineFlags', () => {
  const ok = { price_as_written: 28, normalized_inr: 28, last_year_rate_inr: 28.5, evidence: { quote: 'Rs 28.00', locator: 'x' }, inherits_last_year: false };
  it('is clean when everything agrees', () => {
    expect(lineFlags(ok)).toEqual([]);
  });
  it('flags evidence mismatch', () => {
    expect(lineFlags({ ...ok, evidence: { quote: 'Rs 29.00', locator: 'x' } })).toContain('evidence_mismatch');
  });
  it('flags unusual vs last year above 35 percent as information', () => {
    expect(lineFlags({ ...ok, price_as_written: 40, normalized_inr: 40, evidence: { quote: '40', locator: 'x' } })).toEqual(['unusual_vs_last_year']);
  });
  it('flags a 100x price as unit suspect, not merely unusual', () => {
    expect(lineFlags({ ...ok, price_as_written: 2830, normalized_inr: 2830, evidence: { quote: '2,830.00', locator: 'x' } })).toEqual(['unit_suspect']);
  });
  it('skips the number check for last year inheritance', () => {
    expect(lineFlags({ ...ok, price_as_written: null, normalized_inr: 28.5, inherits_last_year: true, evidence: { quote: 'same as last year', locator: 'x' } })).toEqual([]);
  });
});

describe('assignStatus', () => {
  const clean: StatusInput = { source_type: 'xlsx', read_confidence: 'high', match_confidence: 0.95, flags: [], unit_known: true, assumption_keys: [], has_price: true };
  it('confirms only a fully clean line', () => {
    expect(assignStatus(clean).status).toBe('confirmed');
  });
  it('never confirms a photo line', () => {
    expect(assignStatus({ ...clean, source_type: 'image' }).status).toBe('assumed');
    expect(assignStatus({ ...clean, source_type: 'image', read_confidence: 'medium' }).status).toBe('assumed');
  });
  it('marks applied assumptions as assumed', () => {
    expect(assignStatus({ ...clean, assumption_keys: ['usd_inr'] }).status).toBe('assumed');
  });
  it.each([
    ['low read', { read_confidence: 'low' as const }],
    ['weak match', { match_confidence: 0.84 }],
    ['evidence mismatch', { flags: ['evidence_mismatch'] }],
    ['unit suspect', { flags: ['unit_suspect'] }],
    ['unit unknown', { unit_known: false }],
    ['no price', { has_price: false }],
    ['medium read on text', { read_confidence: 'medium' as const }],
  ])('needs review for %s', (_n, over) => {
    expect(assignStatus({ ...clean, ...over }).status).toBe('needs_review');
  });
  it('treats unusual vs last year as information only', () => {
    expect(assignStatus({ ...clean, flags: ['unusual_vs_last_year'] }).status).toBe('confirmed');
  });
});

describe('detectConflicts', () => {
  it('returns every disagreeing source', () => {
    expect(detectConflicts([{ id: 'a', normalized_inr: 10 }, { id: 'b', normalized_inr: 12 }])).toEqual(['a', 'b']);
  });
  it('ignores agreement within half a percent', () => {
    expect(detectConflicts([{ id: 'a', normalized_inr: 10 }, { id: 'b', normalized_inr: 10.04 }])).toEqual([]);
  });
});

describe('reconcileTotal', () => {
  it('flags a stated total more than 0.5 percent off', () => {
    const r = reconcileTotal([{ normalized_inr: 10, annual_qty: 1000 }], 10180);
    expect(r.mismatch).toBe(true);
    expect(r.delta_pct).toBeCloseTo(1.8, 10);
  });
  it('accepts rounding differences', () => {
    expect(reconcileTotal([{ normalized_inr: 10, annual_qty: 1000 }], 10003).mismatch).toBe(false);
  });
});

describe('namesMatch', () => {
  it('ignores entity suffixes and punctuation', () => {
    expect(namesMatch('Deccan Board Mills Pvt Ltd', 'DECCAN BOARD MILLS PRIVATE LIMITED')).toBe(true);
  });
  it('catches a different legal entity', () => {
    expect(namesMatch('Deccan Board Mills Pvt Ltd', 'Deccan Paperboard Industries Private Limited')).toBe(false);
  });
});

describe('coversExactlyRemainder', () => {
  const all = ['A', 'B', 'C', 'D'];
  it('is true when the group is exactly the unpriced lines', () => {
    expect(coversExactlyRemainder(['C', 'D'], new Set(['A', 'B']), all)).toBe(true);
  });
  it('is false when the group misses or over-reaches', () => {
    expect(coversExactlyRemainder(['C'], new Set(['A', 'B']), all)).toBe(false);
    expect(coversExactlyRemainder(['B', 'C', 'D'], new Set(['A', 'B']), all)).toBe(false);
    expect(coversExactlyRemainder(['X'], new Set(['A', 'B', 'C', 'D']), all)).toBe(false);
  });
});
