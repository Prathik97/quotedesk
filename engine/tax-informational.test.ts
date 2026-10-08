// K1 and K2 at engine level, on fixtures with their own numbers and wording.
import { describe, expect, it } from 'vitest';
import { readPackDefinitions } from './convert';
import { recomputeLine, type StoredLine } from './recompute';
import { cleanTaxQuotes, clipQuote, headerLines, isDualRateGrid, isHeaderQuote, statementsInText, taxStatements } from './tax';

const SHEET = [
  "=== Sheet 'Offer' ===",
  'A1: ACME PACKS PVT LTD',
  'A4: No | B4: Item | C4: Pack | D4: Price excl tax (INR) | E4: Price incl tax (INR) | F4: Notes',
  'A5: 1 | B5: Mailer box small | C5: per 50 | D5: 410 | E5: 459.2',
  'A6: 2 | B6: Lamination film | C6: per kg | D6: 150 | E6: 168 | F6: stock item',
  'A8: Figures in the tax inclusive column are listed for reference only.',
].join('\n');

describe('K1a: a header row is never a tax statement', () => {
  it('finds the header row above the data rows, and not the prose note', () => {
    const h = headerLines(SHEET).lines;
    expect([...h]).toEqual([2]);
  });
  it('the header cell "Price incl tax (INR)" and the whole header row are not statements', () => {
    expect(statementsInText(SHEET, [])).toEqual([]);
    expect(isHeaderQuote('E4: Price incl tax (INR)', SHEET)).toBe(true);
    expect(isHeaderQuote('A4: No | B4: Item | C4: Pack | D4: Price excl tax (INR) | E4: Price incl tax (INR) | F4: Notes', SHEET)).toBe(true);
    expect(isHeaderQuote('A8: Figures in the tax inclusive column are listed for reference only.', SHEET)).toBe(false);
  });
  it('a plain text header line made of column words is a header; a sentence is not', () => {
    const pdf = ['Quote 12', 'Sr Description Unit Rate excl GST Rate incl GST Remarks', '1 Tray 10 each 20 22.4', 'Rates incl GST given to help comparison, payable price is the excl GST rate.'].join('\n');
    expect(headerLines(pdf).lines.has(1)).toBe(true);
    expect(headerLines(pdf).lines.has(3)).toBe(false);
    expect(statementsInText(pdf, []).every((x) => !x.quote.startsWith('Sr '))).toBe(true);
  });
  it('a note placed in a row of a table is still read when it is a sentence of a table body row', () => {
    const t = ['A1: Item | B1: Rate | C1: Remarks', 'A2: Tape | B2: 40 | C2: GST extra'].join('\n');
    expect(statementsInText(t, []).map((s) => s.basis)).toEqual(['excl']);
  });
});

describe('K1b and d: an inclusive figure shown for information is not a statement about the quoted price', () => {
  it('the sheet has a basic column and an including tax column', () => {
    expect(isDualRateGrid(SHEET)).toBe(true);
    expect(isDualRateGrid('A1: Item | B1: Rate | C1: Remarks\nA2: Tape | B2: 40 | C2: x')).toBe(false);
  });
  it('"listed for reference only" about the inclusive column makes no statement', () => {
    expect(statementsInText(SHEET, [])).toEqual([]);
    expect(taxStatements('Prices incl tax given for reference only')).toEqual([]);
    expect(taxStatements('Inclusive prices are provided for your convenience; basic rate is the quoted price')).toEqual([]);
  });
  it('"shown" alone is not enough on a sheet with no including column: it can be the real statement', () => {
    expect(taxStatements('Prices shown are GST inclusive').map((s) => s.basis)).toEqual(['incl']);
    expect(taxStatements('Prices shown are GST inclusive', true)).toEqual([]);
    expect(cleanTaxQuotes(['Inclusive of GST figures are listed in the last column.'], SHEET)).toEqual([]);
  });
  it('a note that really says the quoted prices include tax is a statement', () => {
    expect(taxStatements('All prices quoted include 12% GST').map((s) => s.basis)).toEqual(['incl']);
    expect(statementsInText('A9: All prices above include 12 percent GST', []).map((s) => s.basis)).toEqual(['incl']);
  });
});

const base: StoredLine = {
  price: 410, currency: 'INR', uom_text: 'per 50', per_n: 50, tax_basis: 'excl_gst', inherits_last_year: false, base_uom: 'piece', last_year_rate_inr: 8,
  unit_definitions: [], read_confidence: 'high', match_confidence: 0.95, source_type: 'xlsx', evidence_quote: 'D5: 410', evidence_locator: "Sheet 'Offer'!D5", sticky_flags: [], overrides: {},
  conditions: [], annual_qty: 1000, rfx_text: 'Mailer box small', vendor_notes: [], scope_text: 'Mailer box small ; Mailer box small ; Boxes',
};
const A = { usd_inr: 96, gst_pct: 18 };

describe('K1c and e: scope, and the safe default', () => {
  it('an informational note about boxes leaves a box line and a film line derived at the document basis', () => {
    const notes = ['Box rates incl tax are given for reference only.'];
    const box = recomputeLine({ ...base, vendor_notes: notes }, A);
    expect(box.normalized_inr).toBeCloseTo(8.2, 10);
    const film = recomputeLine({ ...base, price: 150, uom_text: 'per kg', per_n: 1, base_uom: 'kg', rfx_text: 'Lamination film', scope_text: 'Lamination film ; Films', vendor_notes: notes }, A);
    expect(film.normalized_inr).toBe(150);
  });
  it('a note that really says box prices include tax still makes a box line Not derived, and leaves a film line alone', () => {
    const notes = ['Box rates include 5 percent GST.'];
    const box = recomputeLine({ ...base, vendor_notes: notes }, A);
    expect(box.normalized_inr).toBeNull();
    expect(box.flags).toContain('tax_unresolved');
    const film = recomputeLine({ ...base, price: 150, uom_text: 'per kg', per_n: 1, base_uom: 'kg', rfx_text: 'Lamination film', scope_text: 'Lamination film ; Films', vendor_notes: notes }, A);
    expect(film.normalized_inr).toBe(150);
  });
  it('a note with no product words that says all quoted prices include tax, against a document basis of excl, is a conflict on every line', () => {
    const r = recomputeLine({ ...base, vendor_notes: ['All quoted prices include 5 percent GST.'] }, A);
    expect(r.normalized_inr).toBeNull();
    expect(r.flags).toContain('tax_unresolved');
  });
  it('a document whose basis is incl and says so is converted at the stated rate', () => {
    const r = recomputeLine({ ...base, tax_basis: 'incl_gst', price: 459.2, vendor_notes: ['All prices include 12% GST.'] }, A);
    expect(r.normalized_inr).toBeCloseTo(8.2, 10);
  });
});

describe('K2: a pack definition in the same line or in the notes is applied', () => {
  it('reads the usual wordings, with other numbers', () => {
    expect(readPackDefinitions(['3000 per box (1 box = 60 rolls)'])).toMatchObject([{ term: 'box', means_quantity: 60, means_unit: 'rolls' }]);
    expect(readPackDefinitions(['carton of 24 pcs'])).toMatchObject([{ term: 'carton', means_quantity: 24, means_unit: 'pcs' }]);
    expect(readPackDefinitions(['36 rolls per carton'])).toMatchObject([{ term: 'carton', means_quantity: 36, means_unit: 'rolls' }]);
    expect(readPackDefinitions(['2 cartons = 200 rolls'])).toMatchObject([{ term: 'cartons', means_quantity: 100, means_unit: 'rolls' }]);
    expect(readPackDefinitions(['box 12 x 8 x 6', 'carton rate 400'])).toEqual([]);
  });
  it('a line quoted per box with the definition in its own evidence quote stays Assumed and divides', () => {
    const r = recomputeLine({ ...base, price: 3000, uom_text: 'per box', per_n: 1, base_uom: 'roll', last_year_rate_inr: 48, rfx_text: 'BOPP tape 48 mm x 100 m', scope_text: 'tape', evidence_quote: '3000 per box (1 box = 60 rolls)' }, A);
    expect(r.normalized_inr).toBeCloseTo(50, 10);
    expect(r.status).toBe('assumed');
    expect(r.assumption_keys).toContain('pack_size');
    expect(r.notes.join(' ')).toMatch(/Pack size taken from the vendor's note/);
  });
  it('the definition in the vendor notes holds too, and no definition anywhere stays unknown', () => {
    const withNote = recomputeLine({ ...base, price: 3000, uom_text: 'per box', per_n: 1, base_uom: 'roll', rfx_text: 'tape', evidence_quote: '3000 per box', vendor_notes: ['Note: 1 box = 60 rolls'] }, A);
    expect(withNote.normalized_inr).toBeCloseTo(50, 10);
    const none = recomputeLine({ ...base, price: 3000, uom_text: 'per box', per_n: 1, base_uom: 'roll', rfx_text: 'tape', evidence_quote: '3000 per box' }, A);
    expect(none.normalized_inr).toBeNull();
    expect(none.flags).toContain('pack_size_unknown');
  });
  it('two different definitions of the same pack stay unresolved', () => {
    const r = recomputeLine({ ...base, price: 3000, uom_text: 'per box', per_n: 1, base_uom: 'roll', rfx_text: 'tape', evidence_quote: '3000 per box (1 box = 60 rolls)', vendor_notes: ['1 box = 50 rolls'] }, A);
    expect(r.normalized_inr).toBeNull();
  });
});

describe('K4: a quoted statement is shortened', () => {
  it('clips at 160 characters', () => {
    expect(clipQuote('x'.repeat(300)).length).toBe(160);
    expect(clipQuote('short')).toBe('short');
  });
});
