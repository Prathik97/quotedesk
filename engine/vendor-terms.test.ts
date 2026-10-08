// Regression tests for the unit, condition and board grade rules found by running two unseen files through Try your file.
import { describe, expect, it } from 'vitest';
import { normalizePrice, parseUnit, specLengthMm } from './convert';
import { recomputeLine, type StoredLine } from './recompute';
import { alternatePrice, boardGrades, gradeMismatch, readTerms, vendorBaseGrade } from './terms';
import { unitSuspectMessage } from './verify';
import type { Assumptions, BaseUom } from './types';

const A: Assumptions = { usd_inr: 96, gst_pct: 18 };

function line(over: Partial<StoredLine> = {}): StoredLine {
  return {
    price: 10, currency: 'INR', uom_text: 'per piece', per_n: 1, tax_basis: 'excl_gst', inherits_last_year: false, base_uom: 'piece',
    last_year_rate_inr: 10, unit_definitions: [], read_confidence: 'high', match_confidence: 0.95, source_type: 'xlsx',
    evidence_quote: 'E15: 10', evidence_locator: "Sheet 'Quote'!E15", sticky_flags: [], overrides: {}, conditions: [], annual_qty: 4000, rfx_text: '', vendor_notes: [], ...over,
  };
}

const norm = (price: number, uom: string | null, per_n: number | null, base: BaseUom = 'piece', extra: Partial<Parameters<typeof normalizePrice>[0]> = {}) =>
  normalizePrice({ price, currency: 'INR', uom_text: uom, per_n, tax_basis: 'excl_gst', base_uom: base, last_year_rate_inr: null, ...extra }, A);

describe('F1: the pack divisor is derived once', () => {
  const cases: [string, string | null, number | null][] = [
    ['per 100', 'per 100', 1],
    ['per 100 pcs', 'per 100 pcs', 1],
    ['per hundred', 'per hundred', 1],
    ['/100', '/100', 1],
    ['per 100 written in both places', 'per 100', 100],
    ['per 100 pcs written in both places', 'per 100 pcs', 100],
    ['count only in per_n', 'piece', 100],
    ['count only in per_n with per', 'per pc', 100],
  ];
  it.each(cases)('615 %s is 6.15 per piece', (_n, uom, perN) => {
    const r = norm(615, uom, perN);
    expect(r.ok && r.value_inr).toBeCloseTo(6.15, 10);
    expect(r.ok && r.steps.length).toBe(1);
  });
  it('per 1000 and per thousand give a thousandth', () => {
    for (const [uom, perN] of [['per 1000', 1], ['per 1000', 1000], ['per thousand', 1], ['pcs', 1000]] as const) {
      const r = norm(6150, uom, perN);
      expect(r.ok && r.value_inr).toBeCloseTo(6.15, 10);
    }
  });
  it('two different counts are not guessed between', () => {
    const r = norm(615, 'per 100', 10);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('unit_unknown');
    expect(!r.ok && r.detail).toMatch(/ambiguous/);
  });
  it('per box with a footnote pack size divides by the vendor pack size once', () => {
    const defs = [{ term: 'box*', means_quantity: 50, means_unit: 'pcs', quote: '* 1 box = 50 pcs' }];
    const r = norm(300, 'per box*', 1, 'piece', { unit_definitions: defs });
    expect(r.ok && r.value_inr).toBe(6);
    expect(r.ok && r.pack_size).toBe(50);
  });
  it('per 10 boxes divides by the box size times ten', () => {
    const defs = [{ term: 'box', means_quantity: 50, means_unit: 'pcs', quote: null }];
    const r = norm(3000, 'per 10 box', 1, 'piece', { unit_definitions: defs });
    expect(r.ok && r.value_inr).toBe(6);
  });
  it('a carton line at 615 per 100 is a clean Confirmed 6.15, not 0.0615', () => {
    const r = recomputeLine(line({ price: 615, uom_text: 'per 100', per_n: 100, last_year_rate_inr: 6.4, evidence_quote: 'E15: 615' }), A);
    expect(r.normalized_inr).toBeCloseTo(6.15, 10);
    expect(r.status).toBe('confirmed');
    expect(r.flags).not.toContain('unit_suspect');
  });
});

describe('F1: the implausible price message is directional', () => {
  it('too high says a pack or tonne price may not be converted', () => {
    expect(unitSuspectMessage(2830, 28.5)).toMatch(/far above last year/);
    expect(unitSuspectMessage(2830, 28.5)).toMatch(/pack or tonne price may not be converted/);
  });
  it('too low says it may have been converted twice or the unit is wrong', () => {
    expect(unitSuspectMessage(0.0615, 6.4)).toMatch(/far below last year/);
    expect(unitSuspectMessage(0.0615, 6.4)).toMatch(/converted twice, or the unit is wrong/);
  });
  it('names a 100 or 1000 correction within 35 percent of last year, and says it was not applied', () => {
    expect(unitSuspectMessage(0.0615, 6.4)).toMatch(/Multiplying by 100 would give 6\.15, within 35 percent/);
    expect(unitSuspectMessage(0.0615, 6.4)).toMatch(/Not applied/);
    expect(unitSuspectMessage(2830, 28.5)).toMatch(/Dividing by 100 would give 28\.30/);
    expect(unitSuspectMessage(41000, 41)).toMatch(/Dividing by 1000/);
  });
  it('gives no hint when no scale lands near last year', () => {
    expect(unitSuspectMessage(900, 5)).not.toMatch(/would give/);
  });
  it('never applies the correction automatically', () => {
    const r = recomputeLine(line({ price: 640, uom_text: 'per piece', last_year_rate_inr: 6.4, evidence_quote: 'E15: 640' }), A);
    expect(r.normalized_inr).toBe(640);
    expect(r.status).toBe('needs_review');
    expect(r.reasons.join(' ')).toMatch(/Dividing by 100 would give 6\.40/);
  });
});

describe('F2: common unit phrases map', () => {
  it.each([
    ['a roll', 'roll'], ['per roll', 'roll'], ['/roll', 'roll'], ['each', 'count'], ['ea', 'count'], ['per pc', 'count'], ['pcs', 'count'], ['nos', 'count'],
    ['per mtr', 'metre'], ['per metre', 'metre'], ['per sq m', 'sq m'], ['sqm', 'sq m'], ['per kg', 'kg'], ['/kg', 'kg'], ['a kg', 'kg'],
  ])('"%s" reads as %s', (text, kind) => {
    expect(parseUnit(text).kind).toBe(kind);
  });
  it('44.5 INR a roll is 44.5 per roll', () => {
    const r = norm(44.5, 'a roll', 1, 'roll');
    expect(r.ok && r.value_inr).toBe(44.5);
  });
  it('per mtr maps to a piece as Assumed when the RFx spec states a length, with the note', () => {
    const r = recomputeLine(line({ price: 13.8, uom_text: 'per mtr', last_year_rate_inr: 14, rfx_text: 'Paper edge protector 50x50x4 mm, 1000 mm length', evidence_quote: 'E25: 13.8' }), A);
    expect(r.normalized_inr).toBeCloseTo(13.8, 10);
    expect(r.status).toBe('assumed');
    expect(r.assumption_keys).toContain('unit_length');
    expect(r.notes).toContain('1 m equals 1 piece of 1000 mm (from the RFx spec).');
  });
  it('a 2 m piece doubles the per metre price', () => {
    const r = recomputeLine(line({ price: 13.8, uom_text: 'per metre', last_year_rate_inr: 27, rfx_text: 'Edge protector, length 2 m', evidence_quote: 'E25: 13.8' }), A);
    expect(r.normalized_inr).toBeCloseTo(27.6, 10);
  });
  it('per mtr without a stated length is Needs review and says the price was read', () => {
    const r = recomputeLine(line({ price: 13.8, uom_text: 'per mtr', last_year_rate_inr: 14, rfx_text: 'Paper edge protector 50x50x4 mm', evidence_quote: 'E25: 13.8' }), A);
    expect(r.normalized_inr).toBeNull();
    expect(r.status).toBe('needs_review');
    expect(r.reasons[0]).toBe('Price read (13.80 per mtr). The unit could not be mapped to piece. Quoted per metre and the RFx spec does not state the length of one piece.');
    expect(r.reasons.join(' ')).not.toMatch(/No readable price/);
  });
  it('an unmappable unit with a price never says no readable price', () => {
    const r = recomputeLine(line({ price: 20, uom_text: 'per lot', evidence_quote: 'E15: 20' }), A);
    expect(r.reasons).toEqual(['Price read (20.00 per lot). The unit could not be mapped to piece.']);
  });
  it('a missing price still says no readable price', () => {
    const r = recomputeLine(line({ price: null }), A);
    expect(r.reasons).toContain('No readable price.');
  });
  it('dimensions are not a length statement', () => {
    expect(specLengthMm('Paper edge protector 50x50x4 mm')).toBeNull();
    expect(specLengthMm('Paper edge protector 50x50x4 mm, 1000 mm length')).toBe(1000);
    expect(specLengthMm('Rod, 1.5 m long')).toBe(1500);
    expect(specLengthMm('Rod, length of 200 cm')).toBe(2000);
  });
});

describe('F3: a price that depends on a condition is not Confirmed', () => {
  const slab = 'Rs 43.2/kg for 40 MT and above in a single dispatch, otherwise Rs 45.6/kg';
  it('slab with an alternate price is Assumed, flagged, and shows the alternate', () => {
    const r = recomputeLine(line({ price: 43.2, uom_text: '/kg', base_uom: 'kg', last_year_rate_inr: 44, conditions: [slab], annual_qty: 500000, evidence_quote: slab }), A);
    expect(r.status).toBe('assumed');
    expect(r.flags).toContain('conditional_price');
    expect(r.reasons.join(' ')).toMatch(/Alternate price stated: Rs 45\.6/);
  });
  it('an "or more / below that" slab shows the alternate', () => {
    const c = 'Rs 44.8/kg for 40 MT or more, Rs 46.9/kg below that';
    expect(readTerms([c], { price: 44.8, annual_qty: 1e6, base_uom: 'kg' }).conditional?.alternate).toBe(46.9);
  });
  it('"if taken together, otherwise add Re 1" reads the alternate as the price plus 1', () => {
    const t = readTerms(['Rs 27 if both tapes taken together, otherwise add Re 1'], { price: 27, annual_qty: 1000, base_uom: 'roll' });
    expect(t.conditional?.alternate).toBe(28);
  });
  it('flat is not a condition', () => {
    const r = recomputeLine(line({ conditions: ['flat'] }), A);
    expect(r.status).toBe('confirmed');
    expect(r.flags).not.toContain('conditional_price');
  });
  it('a note such as subject to availability is not a condition on the price', () => {
    expect(readTerms(['Subject to availability', 'Board BF not stated'], { price: 10, annual_qty: 1, base_uom: 'kg' }).conditional).toBeNull();
  });
  it('a discount condition is the V2 mechanism and does not make the line conditional', () => {
    const r = recomputeLine(line({ conditions: ['4% discount if single PO above Rs. 25,00,000 excl. GST'] }), A);
    expect(r.status).toBe('confirmed');
    expect(r.flags).not.toContain('conditional_price');
  });
  it('a minimum the annual quantity satisfies stays Confirmed with a note', () => {
    const r = recomputeLine(line({ conditions: ['minimum 1000 pcs'], annual_qty: 4000 }), A);
    expect(r.status).toBe('confirmed');
    expect(r.notes.join(' ')).toMatch(/Minimum order 1000 pcs is met by the annual quantity of 4000 pieces/);
  });
  it('a minimum above the annual quantity is Needs review', () => {
    const r = recomputeLine(line({ conditions: ['minimum 5000 pcs'], annual_qty: 4000 }), A);
    expect(r.status).toBe('needs_review');
    expect(r.reasons.join(' ')).toMatch(/above the annual quantity of 4000/);
  });
  it('a minimum in tonnes is compared in kg', () => {
    expect(readTerms(['minimum 5 MT'], { price: 40, annual_qty: 4000, base_uom: 'kg' }).minimum?.met).toBe(false);
    expect(readTerms(['minimum 5 MT'], { price: 40, annual_qty: 40000, base_uom: 'kg' }).minimum?.met).toBe(true);
  });
  it('a minimum that cannot be compared is treated as an unverified condition', () => {
    const r = recomputeLine(line({ conditions: ['minimum 5 MT'], annual_qty: 4000 }), A);
    expect(r.status).toBe('assumed');
    expect(r.flags).toContain('conditional_price');
  });
  it('a buyer who verified the cell has accepted the condition', () => {
    const r = recomputeLine(line({ conditions: [slab], price: 43.2, evidence_quote: slab, overrides: { verified: true } }), A);
    expect(r.status).toBe('confirmed');
  });
  it('alternatePrice ignores the price itself', () => {
    expect(alternatePrice('Rs 43.2/kg above 40 MT', 43.2)).toBeNull();
  });
});

describe('F4: a different board grade is Needs review with the vendor text and no adjusted price', () => {
  const surcharge = 'Quoted on BF 20; RFx needs BF 22: add Rs 0.80 per carton';
  it('reads board grades', () => {
    expect(boardGrades('5 ply RSC carton 450x300x250 mm, BF 22, brown')).toEqual([22]);
    expect(boardGrades('sheet BF22 and BF-25')).toEqual([22, 25]);
  });
  it('finds the vendor base grade and its surcharge from quote level notes', () => {
    const g = vendorBaseGrade(['Prices are on BF 20 board as standard. BF 22 board is charged extra.']);
    expect(g?.grade).toBe(20);
    expect(g?.surcharge).toMatch(/charged extra/);
  });
  it('a line whose RFx needs another grade becomes Needs review and keeps the vendor price unadjusted', () => {
    const r = recomputeLine(line({ price: 27.4, last_year_rate_inr: 28.5, rfx_text: '5 ply RSC carton, BF 22', conditions: [surcharge], evidence_quote: 'E9: 27.4' }), A);
    expect(r.status).toBe('needs_review');
    expect(r.normalized_inr).toBe(27.4);
    expect(r.flags).toContain('board_grade_mismatch');
    expect(r.reasons.join(' ')).toContain(surcharge);
    expect(r.reasons.join(' ')).toMatch(/No adjusted price is computed/);
  });
  it('quote level notes reach lines that carry no grade of their own', () => {
    const m = gradeMismatch('5 ply corrugated sheet 1100x1500 mm, BF 22', ['Base board grade BF 20. BF 22 on request at Rs 1 per kg extra.'], ['Board BF not stated']);
    expect(m?.vendor_grade).toBe(20);
    expect(m?.rfx_grade).toBe(22);
    expect(m?.text).toMatch(/extra/);
  });
  it('the same grade, or an RFx line with no grade, is not a mismatch', () => {
    expect(gradeMismatch('carton BF 22', ['Prices are for BF 22 board.'], [])).toBeNull();
    expect(gradeMismatch('mailer box', ['Base board grade BF 20.'], [])).toBeNull();
  });
  it('a buyer check leaves it Assumed at the vendor price, never Confirmed', () => {
    const r = recomputeLine(line({ price: 27.4, rfx_text: 'carton BF 22', conditions: [surcharge], overrides: { verified: true }, evidence_quote: 'E9: 27.4' }), A);
    expect(r.status).toBe('assumed');
  });
});
