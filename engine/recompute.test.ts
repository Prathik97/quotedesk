import { describe, expect, it } from 'vitest';
import { INTERPRETATION_KEYS, recomputeLine, traceConversion, type StoredLine } from './recompute';
import type { Assumptions } from './types';

const A: Assumptions = { usd_inr: 96, gst_pct: 18 };

function line(over: Partial<StoredLine> = {}): StoredLine {
  return {
    price: 10,
    currency: 'INR',
    uom_text: 'per piece',
    per_n: 1,
    tax_basis: 'excl_gst',
    inherits_last_year: false,
    base_uom: 'piece',
    last_year_rate_inr: 10,
    unit_definitions: [],
    read_confidence: 'high',
    match_confidence: 0.95,
    source_type: 'xlsx',
    evidence_quote: 'F14: 10',
    evidence_locator: "Sheet 'X'!F14",
    sticky_flags: [],
    overrides: {},
    ...over,
  };
}

describe('recomputeLine: plain and converted prices', () => {
  it('confirms a clean INR per piece price', () => {
    const r = recomputeLine(line(), A);
    expect(r.normalized_inr).toBe(10);
    expect(r.status).toBe('confirmed');
    expect(r.assumption_keys).toEqual([]);
    expect(r.confidence).toBe(0.95);
  });

  it('converts a per tonne price to per kg, explicit unit stays Confirmed, factor recorded', () => {
    const r = recomputeLine(line({ price: 42000, uom_text: 'per MT', base_uom: 'kg', last_year_rate_inr: 41, evidence_quote: 'C7: 42000' }), A);
    expect(r.normalized_inr).toBe(42);
    expect(r.status).toBe('confirmed');
    expect(r.steps).toEqual([{ op: 'divide', factor: 1000, reason: '1 tonne = 1000 kg' }]);
  });

  it('converts USD with the assumed rate and marks it Assumed', () => {
    const r = recomputeLine(line({ price: 1.28, currency: 'USD', uom_text: 'per kg', base_uom: 'kg', last_year_rate_inr: 120, evidence_quote: 'USD 1.28 per kg' }), A);
    expect(r.normalized_inr).toBeCloseTo(122.88, 10);
    expect(r.status).toBe('assumed');
    expect(r.assumption_keys).toEqual(['usd_inr']);
  });

  it('recomputes the same line when the FX assumption changes', () => {
    const l = line({ price: 1.28, currency: 'USD', uom_text: 'per kg', base_uom: 'kg', last_year_rate_inr: 120, evidence_quote: 'USD 1.28 per kg' });
    const at96 = recomputeLine(l, A).normalized_inr as number;
    const at90 = recomputeLine(l, { ...A, usd_inr: 90 }).normalized_inr as number;
    expect(at96).toBeCloseTo(122.88, 10);
    expect(at90).toBeCloseTo(115.2, 10);
    expect(at90).toBeLessThan(at96);
  });

  it('removes GST at the assumed percentage and recomputes when it changes', () => {
    const l = line({ price: 118, tax_basis: 'incl_gst', last_year_rate_inr: 100, evidence_quote: 'Rs 118' });
    expect(recomputeLine(l, A).normalized_inr).toBeCloseTo(100, 10);
    expect(recomputeLine(l, { ...A, gst_pct: 12 }).normalized_inr).toBeCloseTo(118 / 1.12, 10);
    expect(recomputeLine(l, A).assumption_keys).toContain('gst_pct');
    expect(recomputeLine(l, A).status).toBe('assumed');
  });

  it('assumes excluding GST when the document is silent, and says so', () => {
    const r = recomputeLine(line({ tax_basis: 'unknown' }), A);
    expect(r.assumption_keys).toContain('tax_basis_assumed_excl');
    expect(r.status).toBe('assumed');
  });
});

describe('recomputeLine: inheritance, packs and review', () => {
  it('resolves same as last year from the LY rate and marks it Assumed', () => {
    const r = recomputeLine(line({ price: null, inherits_last_year: true, last_year_rate_inr: 28.5, evidence_quote: 'same as last year' }), A);
    expect(r.normalized_inr).toBe(28.5);
    expect(r.status).toBe('assumed');
    expect(r.assumption_keys).toEqual(['last_year_inheritance']);
  });

  it('does not invent a price when same as last year has no LY rate', () => {
    const r = recomputeLine(line({ price: null, inherits_last_year: true, last_year_rate_inr: null }), A);
    expect(r.normalized_inr).toBeNull();
    expect(r.status).toBe('needs_review');
    expect(r.error?.reason).toBe('no_last_year_rate');
  });

  it('uses the vendor pack definition for a per box price and marks it Assumed', () => {
    const r = recomputeLine(
      line({
        price: 2719,
        uom_text: 'per box*',
        last_year_rate_inr: 28.5,
        evidence_quote: '2,719.00 per box*',
        unit_definitions: [{ term: 'box*', means_quantity: 100, means_unit: 'pcs', quote: '* 1 box = 100 pcs' }],
      }),
      A,
    );
    expect(r.normalized_inr).toBeCloseTo(27.19, 10);
    expect(r.status).toBe('assumed');
    expect(r.pack_size).toBe(100);
    expect(r.pack_source).toBe('vendor');
    expect(r.assumption_keys).toContain('pack_size');
  });

  it('keeps a photo value Assumed even with no other assumption', () => {
    const r = recomputeLine(line({ source_type: 'image', read_confidence: 'medium' }), A);
    expect(r.status).toBe('assumed');
  });

  it('sends an unconvertible pack price to review instead of guessing', () => {
    const r = recomputeLine(line({ price: 2719, uom_text: 'per box', last_year_rate_inr: 28.5, evidence_quote: '2719 per box' }), A);
    expect(r.normalized_inr).toBeNull();
    expect(r.status).toBe('needs_review');
    expect(r.flags).toContain('pack_size_unknown');
  });

  it('flags a price that looks like an unconverted tonne price', () => {
    const r = recomputeLine(line({ price: 44000, uom_text: 'per kg', base_uom: 'kg', last_year_rate_inr: 44, evidence_quote: '44000 per kg' }), A);
    expect(r.flags).toContain('unit_suspect');
    expect(r.status).toBe('needs_review');
  });

  it('flags a number that is not in its quoted evidence', () => {
    const r = recomputeLine(line({ evidence_quote: 'F14: 12' }), A);
    expect(r.flags).toContain('evidence_mismatch');
    expect(r.status).toBe('needs_review');
  });

  it('sends low match confidence to review', () => {
    const r = recomputeLine(line({ match_confidence: 0.7 }), A);
    expect(r.status).toBe('needs_review');
  });

  it('keeps sticky extraction flags and ignores unknown ones', () => {
    const r = recomputeLine(line({ sticky_flags: ['from_hidden_sheet', 'made_up'] }), A);
    expect(r.flags).toContain('from_hidden_sheet');
    expect(r.flags).not.toContain('made_up');
    expect(r.status).toBe('needs_review');
  });
});

describe('recomputeLine: buyer overrides', () => {
  it('accept as read settles a read doubt and confirms the cell', () => {
    const l = line({ match_confidence: 0.7, overrides: { verified: true } });
    const r = recomputeLine(l, A);
    expect(r.status).toBe('confirmed');
    expect(r.buyer_verified).toBe(true);
    expect(r.confidence).toBe(1);
  });

  it('accept as read lifts the photo cap and accepts a vendor pack definition', () => {
    const r = recomputeLine(
      line({
        source_type: 'image',
        read_confidence: 'medium',
        price: 2719,
        uom_text: 'per box*',
        last_year_rate_inr: 28.5,
        evidence_quote: '2,719.00 per box*',
        unit_definitions: [{ term: 'box*', means_quantity: 100, means_unit: 'pcs', quote: '* 1 box = 100 pcs' }],
        overrides: { verified: true },
      }),
      A,
    );
    expect(r.status).toBe('confirmed');
    expect(r.accepted_keys).toEqual(['pack_size']);
    expect(r.assumption_keys).toEqual(['pack_size']);
  });

  it('accept as read does not accept an FX rate the vendor never gave', () => {
    const r = recomputeLine(
      line({ price: 1.28, currency: 'USD', uom_text: 'per kg', base_uom: 'kg', last_year_rate_inr: 120, evidence_quote: 'USD 1.28 per kg', overrides: { verified: true } }),
      A,
    );
    expect(r.status).toBe('assumed');
    expect(r.accepted_keys).toEqual([]);
  });

  it('edit value replaces the number, recomputes, and records buyer_edited without an evidence mismatch', () => {
    const r = recomputeLine(line({ evidence_quote: 'F14: 12', overrides: { verified: true, price: 12 } }), A);
    expect(r.normalized_inr).toBe(12);
    expect(r.flags).toContain('buyer_edited');
    expect(r.flags).not.toContain('evidence_mismatch');
    expect(r.status).toBe('confirmed');
  });

  it('an edited price replaces a same as last year inheritance', () => {
    const r = recomputeLine(line({ price: null, inherits_last_year: true, last_year_rate_inr: 28.5, overrides: { verified: true, price: 30 } }), A);
    expect(r.normalized_inr).toBe(30);
    expect(r.assumption_keys).toEqual([]);
  });

  it('set unit meaning resolves an unknown pack and is a decision, not an assumption', () => {
    const base = line({ price: 2719, uom_text: 'per box', last_year_rate_inr: 28.5, evidence_quote: '2719 per box' });
    expect(recomputeLine(base, A).status).toBe('needs_review');
    const r = recomputeLine({ ...base, overrides: { verified: true, pack: { quantity: 100, unit: 'piece' } } }, A);
    expect(r.normalized_inr).toBeCloseTo(27.19, 10);
    expect(r.pack_source).toBe('buyer');
    expect(r.status).toBe('confirmed');
    expect(r.steps[0]?.reason).toContain("Buyer's unit meaning");
  });

  it('set unit meaning wins over a vendor definition', () => {
    const r = recomputeLine(
      line({
        price: 3040.56,
        uom_text: 'per box**',
        base_uom: 'roll',
        last_year_rate_inr: 46,
        evidence_quote: '3,040.56 per box**',
        unit_definitions: [{ term: 'box**', means_quantity: 72, means_unit: 'rolls', quote: '** 1 box = 72 rolls' }],
        overrides: { verified: true, pack: { quantity: 60, unit: 'roll' } },
      }),
      A,
    );
    expect(r.normalized_inr).toBeCloseTo(3040.56 / 60, 10);
    expect(r.pack_size).toBe(60);
  });

  it('rejects a unit meaning that does not fit the RFx unit', () => {
    const r = recomputeLine(line({ price: 50, uom_text: 'per box', base_uom: 'kg', last_year_rate_inr: 5, evidence_quote: '50 per box', overrides: { verified: true, pack: { quantity: 10, unit: 'piece' } } }), A);
    expect(r.normalized_inr).toBeNull();
    expect(r.flags).toContain('unit_incompatible');
  });

  it('only interpretation keys can be accepted by the buyer', () => {
    expect(INTERPRETATION_KEYS).toEqual(['pack_size', 'tax_basis_assumed_excl', 'last_year_inheritance', 'unit_length']);
  });
});

describe('traceConversion', () => {
  it('walks 1.28 USD per kg through the factor and ends at the stored result', () => {
    const l = line({ price: 1.28, currency: 'USD', uom_text: 'per kg', base_uom: 'kg', last_year_rate_inr: 120, evidence_quote: 'USD 1.28 per kg' });
    const r = recomputeLine(l, A);
    const t = traceConversion(1.28, r.steps, r.normalized_inr);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ op: 'multiply', factor: 96, before: 1.28 });
    expect(t.end).toBeCloseTo(122.88, 10);
    expect(t.consistent).toBe(true);
  });

  it('shows 42,000 per tonne divided by 1000 as 42 per kg', () => {
    const r = recomputeLine(line({ price: 42000, uom_text: 'per tonne', base_uom: 'kg', last_year_rate_inr: 41, evidence_quote: '42000' }), A);
    const t = traceConversion(42000, r.steps, r.normalized_inr);
    expect(t.rows[0]).toMatchObject({ op: 'divide', factor: 1000, before: 42000, after: 42 });
    expect(t.consistent).toBe(true);
  });

  it('reports a trace that does not end at the stored value', () => {
    expect(traceConversion(10, [{ op: 'divide', factor: 2, reason: 'x' }], 6).consistent).toBe(false);
    expect(traceConversion(10, [], null).consistent).toBe(false);
  });
});
