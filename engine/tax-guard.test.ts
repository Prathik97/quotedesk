// H1 and H2 at engine level. These fixtures use their own numbers and wording on purpose (100 including 5 percent, a
// statement that exists only in the notes), so they pin the rule and not one vendor file.
import { describe, expect, it } from 'vitest';
import { recomputeLine, type StoredLine } from './recompute';
import { quoteInText, resolveTax, scopeCovers, scopeOf, taxStatements, type ModelTax } from './tax';

const base: StoredLine = {
  price: 100, currency: 'INR', uom_text: 'per piece', per_n: 1, tax_basis: 'unknown', inherits_last_year: false, base_uom: 'piece', last_year_rate_inr: 95,
  unit_definitions: [], read_confidence: 'high', match_confidence: 0.95, source_type: 'email', evidence_quote: 'Carton 100 each', evidence_locator: 'L2', sticky_flags: [], overrides: {},
  conditions: [], annual_qty: 1000, rfx_text: 'Corrugated carton 300x200x150 mm', vendor_notes: [],
  scope_text: 'Carton 100 each ; Corrugated carton 300x200x150 mm ; Cartons',
};
const a = { usd_inr: 96, gst_pct: 18 };
const NOTES = ['Taxes extra on all items.', 'Update: carton prices already include 5 percent tax. Sheet and tape still taxes extra.'];

describe('which products a statement speaks about', () => {
  it('reads nouns and ply numbers; a ply number only narrows', () => {
    expect(scopeOf('carton prices include tax')).toEqual({ nouns: ['box'], plies: [], all: false });
    expect(scopeOf('only 3 ply and 5 ply boxes').plies.sort()).toEqual(['3', '5']);
    expect(scopeOf('Taxes extra on all items')).toEqual({ nouns: [], plies: [], all: true });
  });
  it('a pack unit is not a product: "per carton" on a tape line does not make it a box line', () => {
    expect(scopeOf('BOPP tape 4500 per carton (1 carton = 100 rolls)').nouns.sort()).toEqual(['roll', 'tape']);
    expect(scopeCovers(scopeOf('only sheet, tape, film and strap GST extra'), 'BOPP tape 4500 per carton')).toBe(true);
    expect(scopeCovers(scopeOf('box rates include tax'), 'BOPP tape 4500 per carton')).toBe(false);
  });
  it('covers a line only when the product words agree; a line of unknown family could be anything', () => {
    expect(scopeCovers(scopeOf('box rates'), 'Brown carton 12x8x6')).toBe(true);
    expect(scopeCovers(scopeOf('box rates'), 'BOPP tape 48 mm')).toBe(false);
    expect(scopeCovers(scopeOf('3 ply box rates'), '5 ply box 18x12x10')).toBe(false);
    expect(scopeCovers(scopeOf('box rates'), 'Item 77')).toBe(true);
    expect(scopeCovers(scopeOf('all rates'), 'anything')).toBe(true);
  });
  it('a quote is found only when it is really in the text (addresses and spacing ignored)', () => {
    expect(quoteInText('carton prices   include 5 percent tax', '[L4] Update: Carton prices include 5 percent tax.')).toBe(true);
    expect(quoteInText('carton prices include 9 percent tax', '[L4] Update: Carton prices include 5 percent tax.')).toBe(false);
    expect(quoteInText('x', 'x')).toBe(false);
    expect(quoteInText(null, 'x')).toBe(false);
  });
});

describe('one clause with two statements is split, so each keeps its own product words', () => {
  it('"box rates GST included (12%), GST extra only on sheet, tape" is an inclusive box statement and an exclusive sheet and tape statement', () => {
    const [i, e] = taxStatements('Update: box rates GST included (12%), GST extra only on sheet, tape');
    expect(i).toMatchObject({ basis: 'incl', rate_pct: 12 });
    expect(scopeOf(i!.text).nouns).toEqual(['box']);
    expect(e?.basis).toBe('excl');
    expect(scopeOf(e!.text).nouns.sort()).toEqual(['sheet', 'tape']);
  });
});

describe('H1: no derived excluding GST price where a statement may govern the line', () => {
  it('a statement only in the notes, none on the line: Not derived, price as written, both readings as text, Needs review', () => {
    const r = recomputeLine({ ...base, vendor_notes: NOTES }, a);
    expect(r.normalized_inr).toBeNull();
    expect(r.status).toBe('needs_review');
    expect(r.flags).toContain('tax_unresolved');
    const text = r.reasons.join(' ');
    expect(text).toMatch(/^Not derived: /);
    expect(text).toContain('The price is shown as the vendor wrote it (100 INR)');
    expect(text).toContain('if excluding GST: 100.00; if including 5 percent: 95.24');
    expect(text).toContain('As text only, not a value');
  });
  it('no rate stated: no readings are printed, still Not derived', () => {
    const r = recomputeLine({ ...base, vendor_notes: ['Taxes extra on all items.', 'Correction: carton prices include tax.'] }, a);
    expect(r.normalized_inr).toBeNull();
    expect(r.reasons.join(' ')).not.toMatch(/if including/);
  });
  it('a scoped inclusive statement against a document basis of excl, with no conflict word, still guards the covered line only', () => {
    const notes = ['Carton rates include 12 percent GST for convenience.'];
    const carton = recomputeLine({ ...base, tax_basis: 'excl_gst', vendor_notes: notes }, a);
    expect(carton.normalized_inr).toBeNull();
    const tape = recomputeLine({ ...base, tax_basis: 'excl_gst', vendor_notes: notes, scope_text: 'BOPP tape 48 mm ; Tapes', rfx_text: 'BOPP tape' }, a);
    expect(tape.normalized_inr).toBe(100);
    expect(tape.flags).not.toContain('tax_unresolved');
  });
  it('a scoped statement that agrees with the document basis changes nothing', () => {
    const r = recomputeLine({ ...base, tax_basis: 'excl_gst', vendor_notes: ['Carton rates are GST extra.'] }, a);
    expect(r.normalized_inr).toBe(100);
    expect(r.flags).not.toContain('tax_unresolved');
  });
  it('a line with a statement of its own is unchanged, conflict or not', () => {
    const r = recomputeLine({ ...base, conditions: ['GST included (5%)'], vendor_notes: NOTES }, a);
    expect(r.normalized_inr).toBeCloseTo(100 / 1.05, 10);
    expect(r.flags).not.toContain('tax_unresolved');
  });
  it('a buyer check cannot turn a Not derived line into a price', () => {
    const r = recomputeLine({ ...base, vendor_notes: NOTES, overrides: { verified: true } }, a);
    expect(r.normalized_inr).toBeNull();
    expect(r.status).toBe('needs_review');
  });
  it('a blanket inclusive statement with a stated rate and no opposing statement still converts, as before', () => {
    const r = recomputeLine({ ...base, vendor_notes: ['All rates inclusive of GST @ 12%.'] }, a);
    expect(r.normalized_inr).toBeCloseTo(100 / 1.12, 10);
  });
});

describe('H2: the model\'s resolution is accepted only when verified', () => {
  const good: ModelTax = { basis: 'incl', rate_pct: 5, quote: 'carton prices already include 5 percent tax', quote_found: true };
  const resolve = (model_tax: typeof good | null, over: Partial<StoredLine> = {}) => recomputeLine({ ...base, vendor_notes: NOTES, model_tax, ...over }, a);

  it('verified quote, scope matches, no contradiction: divided by the vendor\'s stated rate, Assumed, conflict kept', () => {
    const r = resolve(good);
    expect(r.normalized_inr).toBeCloseTo(100 / 1.05, 10);
    expect(r.status).toBe('assumed');
    expect(r.tax?.source).toBe('model');
    expect(r.assumption_keys).toEqual(expect.arrayContaining(['tax_basis_model', 'tax_basis_conflict']));
    expect(r.assumption_keys).not.toContain('gst_pct');
    expect(r.steps.map((s) => s.factor)).toEqual([1.05]);
  });
  it('the rate counts as stated only when it is in the vendor\'s quote: a rate only the model gave falls back to the default, Assumed', () => {
    const r = resolve({ ...good, quote: 'carton prices already include tax', rate_pct: 5 }, { vendor_notes: ['Taxes extra on all items.', 'Update: carton prices already include tax.'] });
    expect(r.normalized_inr).toBeCloseTo(100 / 1.18, 10);
    expect(r.assumption_keys).toContain('gst_pct');
    expect(r.status).toBe('assumed');
  });
  it('a quote that is not in the document falls back to H1', () => {
    const r = resolve({ ...good, quote_found: false });
    expect(r.normalized_inr).toBeNull();
    expect(r.flags).toContain('tax_unresolved');
  });
  it('a quote about other products falls back to H1', () => {
    const r = resolve({ basis: 'excl', rate_pct: null, quote: 'Sheet and tape still taxes extra', quote_found: true });
    expect(r.normalized_inr).toBeNull();
  });
  it('a basis that contradicts a specific statement covering the line falls back to H1', () => {
    const r = resolve({ basis: 'excl', rate_pct: null, quote: 'carton prices are taxes extra', quote_found: true });
    expect(r.normalized_inr).toBeNull();
    expect(r.flags).toContain('tax_unresolved');
  });
  it('a quote with no product words must be the line\'s own text', () => {
    const notes = ['Taxes extra on all items.', 'Update: sheet prices include 5 percent tax.'];
    const text = 'Carton 100 each incl 5 percent tax ; Corrugated carton 300x200x150 mm ; Cartons';
    const own = resolve({ basis: 'incl', rate_pct: 5, quote: '100 each incl 5 percent tax', quote_found: true }, { vendor_notes: notes, scope_text: text });
    expect(own.tax?.source).toBe('model');
    expect(own.normalized_inr).toBeCloseTo(100 / 1.05, 10);
    const elsewhere = resolve({ basis: 'excl', rate_pct: null, quote: 'Taxes extra on all items', quote_found: true });
    expect(elsewhere.normalized_inr).toBeNull();
  });
  it('resolveTax: a missing or unreadable model answer never resolves', () => {
    const i = { doc_basis: 'unknown' as const, conditions: [], notes: NOTES, scope_text: base.scope_text };
    expect(resolveTax(i).guard).not.toBeNull();
    expect(resolveTax({ ...i, model_tax: { basis: null, rate_pct: null, quote: null, quote_found: false } }).guard).not.toBeNull();
    expect(resolveTax({ ...i, model_tax: good }).guard).toBeNull();
  });
});
