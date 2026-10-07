import { describe, expect, it } from 'vitest';
import { landedTotal, normalizePrice, parseUnit, type NormalizeInput } from './convert';

const A = { usd_inr: 96, gst_pct: 18 };
const base = (over: Partial<NormalizeInput>): NormalizeInput => ({
  price: 10,
  currency: 'INR',
  uom_text: 'per piece',
  tax_basis: 'excl_gst',
  base_uom: 'piece',
  last_year_rate_inr: 10,
  ...over,
});

function value(over: Partial<NormalizeInput>, a = A): number {
  const r = normalizePrice(base(over), a);
  if (!r.ok) throw new Error(`${r.reason}: ${r.detail}`);
  return r.value_inr;
}

describe('parseUnit', () => {
  it.each([
    ['per piece', 'count', 1],
    ['Nos', 'count', 1],
    ['each', 'count', 1],
    ['per 100', 'count', 100],
    ['per 1000 pcs', 'count', 1000],
    ['per kg', 'kg', 1],
    ['/kg', 'kg', 1],
    ['MT', 'tonne', 1],
    ['per tonne', 'tonne', 1],
    ['Sq.Mtr', 'sq m', 1],
    ['per sq m', 'sq m', 1],
    ['per roll', 'roll', 1],
  ])('%s', (text, kind, n) => {
    const u = parseUnit(text);
    expect(u.kind).toBe(kind);
    if ('n' in u) expect(u.n).toBe(n);
  });
  it('recognises pack units that need a definition', () => {
    expect(parseUnit('per box*')).toEqual({ kind: 'pack', term: 'box' });
  });
  it('reports unknown units instead of guessing', () => {
    expect(parseUnit('per lot').kind).toBe('unknown');
    expect(parseUnit('').kind).toBe('unknown');
  });
  it('applies per_n on top of the unit text', () => {
    expect(parseUnit('per piece', 100)).toEqual({ kind: 'count', n: 100 });
  });
});

describe('normalizePrice', () => {
  it('tonne to kg divides by 1000 and records the step', () => {
    const r = normalizePrice(base({ price: 44310, uom_text: 'MT', base_uom: 'kg' }), A);
    expect(r.ok && r.value_inr).toBeCloseTo(44.31, 10);
    expect(r.ok && r.steps).toEqual([{ op: 'divide', factor: 1000, reason: '1 tonne = 1000 kg' }]);
    expect(r.ok && r.assumption_keys).toEqual([]);
  });

  it('per 100 and per 1000 convert to per unit', () => {
    expect(value({ price: 2830, uom_text: 'per 100' })).toBeCloseTo(28.3, 10);
    expect(value({ price: 28300, uom_text: 'per 1000 pcs' })).toBeCloseTo(28.3, 10);
    expect(value({ price: 2830, uom_text: 'per piece', per_n: 100 })).toBeCloseTo(28.3, 10);
  });

  it("per box uses the vendor's own pack size and marks the assumption", () => {
    const defs = [
      { term: 'box', means_quantity: 100, means_unit: 'pcs', quote: '* 1 box = 100 pcs' },
    ];
    const r = normalizePrice(base({ price: 2719, uom_text: 'per box*', unit_definitions: defs }), A);
    expect(r.ok && r.value_inr).toBeCloseTo(27.19, 10);
    expect(r.ok && r.assumption_keys).toEqual(['pack_size']);
    expect(r.ok && r.pack_size).toBe(100);
  });

  it('per box of rolls only applies to a roll line', () => {
    const defs = [{ term: '1 box', means_quantity: 72, means_unit: 'rolls', quote: '** 1 box = 72 rolls' }];
    expect(value({ price: 3040.56, uom_text: 'per box', base_uom: 'roll', unit_definitions: defs })).toBeCloseTo(42.23, 10);
    const r = normalizePrice(base({ price: 3040.56, uom_text: 'per box', base_uom: 'piece', unit_definitions: defs }), A);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('unit_incompatible');
  });

  it('reads units with a parenthetical qualifier', () => {
    expect(parseUnit('pcs (cartons, partitions, trays)')).toEqual({ kind: 'count', n: 1 });
    expect(parseUnit('rolls (tapes)')).toEqual({ kind: 'roll', n: 1 });
  });

  it('uses the footnote marker to pick between two box definitions', () => {
    const defs = [
      { term: 'box*', means_quantity: 100, means_unit: 'pcs (cartons, inserts)', quote: '* 1 box = 100 pcs (cartons, inserts)' },
      { term: 'box**', means_quantity: 72, means_unit: 'rolls (tapes)', quote: '** 1 box = 72 rolls (tapes)' },
    ];
    expect(value({ price: 2719, uom_text: 'per box*', unit_definitions: defs })).toBeCloseTo(27.19, 10);
    expect(value({ price: 3040.56, uom_text: 'per box**', base_uom: 'roll', unit_definitions: defs })).toBeCloseTo(42.23, 10);
    expect(value({ price: 941, uom_text: 'per box*', base_uom: 'set', unit_definitions: defs })).toBeCloseTo(9.41, 10);
  });

  it('without a marker, picks the only definition that fits the base unit', () => {
    const defs = [
      { term: 'box*', means_quantity: 100, means_unit: 'pcs', quote: null },
      { term: 'box**', means_quantity: 72, means_unit: 'rolls', quote: null },
    ];
    expect(value({ price: 720, uom_text: 'per box', base_uom: 'roll', unit_definitions: defs })).toBeCloseTo(10, 10);
  });

  it('refuses when two definitions fit and nothing says which applies', () => {
    const defs = [
      { term: 'box', means_quantity: 100, means_unit: 'pcs', quote: null },
      { term: 'box', means_quantity: 50, means_unit: 'pcs', quote: null },
    ];
    expect(normalizePrice(base({ price: 100, uom_text: 'per box', unit_definitions: defs }), A)).toMatchObject({ ok: false, reason: 'pack_size_unknown' });
  });

  it('per box without a definition is not guessed', () => {
    const r = normalizePrice(base({ price: 2719, uom_text: 'per box' }), A);
    expect(r).toMatchObject({ ok: false, reason: 'pack_size_unknown' });
  });

  it('USD to INR uses the assumption and marks it', () => {
    const r = normalizePrice(base({ price: 1.28, currency: 'USD', uom_text: 'per kg', base_uom: 'kg' }), A);
    expect(r.ok && r.value_inr).toBeCloseTo(122.88, 10);
    expect(r.ok && r.assumption_keys).toEqual(['usd_inr']);
    expect(value({ price: 1.28, currency: 'USD', uom_text: 'kg', base_uom: 'kg' }, { usd_inr: 85, gst_pct: 18 })).toBeCloseTo(108.8, 10);
  });

  it('GST inclusive prices are converted to exclusive with the assumed rate', () => {
    const r = normalizePrice(base({ price: 118, tax_basis: 'incl_gst' }), A);
    expect(r.ok && r.value_inr).toBeCloseTo(100, 10);
    expect(r.ok && r.assumption_keys).toEqual(['gst_pct']);
    expect(value({ price: 118, tax_basis: 'excl_gst' })).toBe(118);
    expect(value({ price: 118, tax_basis: 'unknown' })).toBe(118);
  });

  it('same as last year resolves to the last year rate and is an assumption', () => {
    const r = normalizePrice(base({ price: null, inherits_last_year: true, last_year_rate_inr: 28.5 }), A);
    expect(r).toMatchObject({ ok: true, value_inr: 28.5, assumption_keys: ['last_year_inheritance'] });
  });

  it('same as last year with no last year rate is an error, not zero', () => {
    const r = normalizePrice(base({ price: null, inherits_last_year: true, last_year_rate_inr: null }), A);
    expect(r).toMatchObject({ ok: false, reason: 'no_last_year_rate' });
  });

  it('missing price is never zero', () => {
    expect(normalizePrice(base({ price: null }), A)).toMatchObject({ ok: false, reason: 'no_price' });
  });

  it('rejects a weight unit on a piece line', () => {
    expect(normalizePrice(base({ uom_text: 'per kg' }), A)).toMatchObject({ ok: false, reason: 'unit_incompatible' });
  });

  it('rejects unknown currencies', () => {
    expect(normalizePrice(base({ currency: 'EUR' }), A)).toMatchObject({ ok: false, reason: 'currency_unknown' });
  });

  it('chains USD, GST and pack size in a fixed order', () => {
    const defs = [{ term: 'box', means_quantity: 10, means_unit: 'pcs', quote: null }];
    const r = normalizePrice(base({ price: 11.8, currency: 'USD', tax_basis: 'incl_gst', uom_text: 'box', unit_definitions: defs }), A);
    expect(r.ok && r.value_inr).toBeCloseTo((11.8 * 96) / 1.18 / 10, 10);
    expect(r.ok && r.assumption_keys).toEqual(['usd_inr', 'gst_pct', 'pack_size']);
  });
});

describe('landedTotal', () => {
  it('included freight adds nothing', () => {
    expect(landedTotal(100, { terms: 'included', amount_inr: null })).toMatchObject({ total_inr: 100, complete: true });
  });
  it('extra with an amount adds it', () => {
    expect(landedTotal(100, { terms: 'extra', amount_inr: 25 })).toMatchObject({ total_inr: 125, complete: true });
  });
  it('extra with no amount is incomplete, never zero freight', () => {
    expect(landedTotal(100, { terms: 'extra', amount_inr: null })).toMatchObject({ complete: false });
    expect(landedTotal(100, { terms: 'unknown', amount_inr: null })).toMatchObject({ complete: false });
  });
});
