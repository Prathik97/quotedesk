// K5: the tax basis a sheet states in its own column headers, through deriveLines (the one derivation the stored
// pipeline and Try your file share). Each fixture has its own numbers and wording. The model is never called.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Assumptions } from '../../../engine/types.js';
import { classifyHeader, headerTaxFor, parseGrid, parseLocator } from '../../../engine/tax-header.js';
import { ExtractionSchema, parseJsonLoose, type Extraction } from '../../../src/lib/schemas/extraction.js';
import { deriveLines, type RfxLineRow } from '../extract/persist.js';
import type { Prepared } from '../extract/prepare.js';

const A: Assumptions = { usd_inr: 96, gst_pct: 18 };
const rfx: RfxLineRow[] = [
  { id: 'a', code: 'CRT-A', section: 'Cartons', description: '5 ply RSC carton 450x300x250 mm', uom: 'piece', annual_qty: 1000, last_year_rate_inr: 30 },
  { id: 'b', code: 'CRT-B', section: 'Cartons', description: '5 ply RSC carton 400x300x200 mm', uom: 'piece', annual_qty: 1000, last_year_rate_inr: 25 },
  { id: 'c', code: 'FLM-A', section: 'Films', description: 'Stretch film 500 mm x 17 micron', uom: 'kg', annual_qty: 1000, last_year_rate_inr: 100 },
];

const line = (code: string, desc: string, price: number, uom: string, locator: string, over: Record<string, unknown> = {}) => ({
  rfx_line_code: code, match_confidence: 0.95, match_reason: 'size', vendor_description: desc, price, currency: 'INR', uom_text: uom, per_n: 1, inherits_last_year: false, conditions: [],
  evidence: { source_type: 'xlsx', locator, quote: `${locator.replace(/^.*!/, '')}: ${price}`, read_confidence: 'high' }, read_confidence: 'high', notes: '', ...over,
});
function extraction(cells: [string, string, number, string][], doc: Record<string, unknown> = {}, over: Record<string, Record<string, unknown>> = {}): Extraction {
  return ExtractionSchema.parse({
    document: { kind: 'quote', vendor_name_as_written: 'Test Vendor', freight_terms: 'extra', tax_basis: 'unknown', global_notes: [], ...doc },
    lines: cells.map(([code, desc, price, loc]) => line(code, desc, price, 'per 100', loc, { per_n: 100, ...over[code] })),
  });
}
function derive(text: string, x: Extraction, lines: RfxLineRow[] = rfx) {
  const derived = deriveLines({ source_type: 'xlsx', observations: [], text } as unknown as Prepared, x, lines, A);
  return { derived, by: (code: string) => derived.find((d) => d.rfx?.code === code) };
}

// Dual column sheet, header on row 4, sheet 'Offer'. Cartons priced per 100.
const DUAL = (h1: string, h2: string, extra = '') => [
  "=== Sheet 'Offer' ===",
  'A1: ZENITH PACK | B1: Offer for RFQ 55',
  `A4: No | B4: Particulars | C4: Pack | D4: ${h1} | E4: ${h2}`,
  'A5: 1 | B5: Carton 450x300x250 | C5: per 100 | D5: 3100 | E5: 3658',
  'A6: 2 | B6: Carton 400x300x200 | C6: per 100 | D6: 2500 | E6: 2950',
  ...(extra ? [`A9: ${extra}`] : []),
].join('\n');
const CELLS: [string, string, number, string][] = [['CRT-A', 'Carton 450x300x250', 3100, "Sheet 'Offer'!D5"], ['CRT-B', 'Carton 400x300x200', 2500, "Sheet 'Offer'!D6"]];

describe('K5a: classifying a header', () => {
  const cls = (t: string) => classifyHeader(t).basis;
  it('excluding headers', () => {
    for (const t of ['Basic rate (Rs)', 'Price (excl. tax)', 'Rate excl GST', 'Net rate', 'Rate ex-GST', 'Rate before tax', 'Rate (Rs) - ex tax', 'Unit price excluding GST']) expect(cls(t), t).toBe('excl');
  });
  it('including headers', () => {
    for (const t of ['Rate incl. GST (Rs)', 'Price (incl. tax)', 'Gross rate', 'Rate with GST', 'Rate inclusive', 'Price including GST @ 12%']) expect(cls(t), t).toBe('incl');
  });
  it('neutral headers, and headers that are not about tax', () => {
    for (const t of ['Rate', 'Price (Rs)', 'Amount', 'Gross weight', 'Net weight (kg)', 'Freight (excl.)', 'Rate excl. freight', 'Description', 'Rate incl. packing']) expect(cls(t), t).toBeNull();
  });
  it('a header that says both ways states nothing', () => {
    expect(cls('Rate incl. GST (excl. GST in col D)')).toBeNull();
  });
  it('reads the rate named in an including header', () => {
    expect(classifyHeader('Price incl. 12% GST').rate_pct).toBe(12);
    expect(classifyHeader('Rate incl. GST').rate_pct).toBeNull();
  });
  it('reads cell locators in every shape the model writes', () => {
    expect(parseLocator("Sheet 'Quote'!E15")).toEqual({ sheet: 'Quote', row: 15, col: 5 });
    expect(parseLocator("'Rates 2'!AB7")).toEqual({ sheet: 'Rates 2', row: 7, col: 28 });
    expect(parseLocator('D5')).toEqual({ sheet: null, row: 5, col: 4 });
    expect(parseLocator(null, 'E9: 2740')).toEqual({ sheet: null, row: 9, col: 5 });
  });
});

describe('K5a: dual column sheets whose price column header states the basis', () => {
  it('"Price (excl. tax)" and "Price (incl. tax)": the excluding cell is the quote, with the header as the source, even against a document basis of incl', () => {
    const r = derive(DUAL('Price (excl. tax)', 'Price (incl. tax)'), extraction(CELLS, { tax_basis: 'incl_gst' }));
    expect(r.by('CRT-A')?.normalized).toBeCloseTo(31, 10);
    expect(r.by('CRT-B')?.normalized).toBeCloseTo(25, 10);
    expect(r.by('CRT-A')?.result?.tax?.source).toBe('header');
    expect(r.by('CRT-A')?.result?.tax?.statement).toContain('Price (excl. tax)');
    expect(r.by('CRT-A')?.status).toBe('confirmed');
  });
  it('"Net rate" and "Gross rate"', () => {
    const r = derive(DUAL('Net rate', 'Gross rate'), extraction(CELLS));
    expect(r.by('CRT-A')?.normalized).toBeCloseTo(31, 10);
    expect(r.by('CRT-A')?.result?.tax?.source).toBe('header');
  });
  it('a two level merged header: the top level is neutral, the second level states the basis', () => {
    const text = [
      "=== Sheet 'Offer' ===", 'Merged regions: D3:E3', 'A3: Particulars | D3: Rate per 100 (Rs)', 'A4: Item | D4: Excl. GST | E4: Incl. GST',
      'A5: Carton 450x300x250 | D5: 3100 | E5: 3658', 'A6: Carton 400x300x200 | D6: 2500 | E6: 2950',
    ].join('\n');
    const r = derive(text, extraction(CELLS));
    expect(r.by('CRT-A')?.normalized).toBeCloseTo(31, 10);
    expect(r.by('CRT-A')?.result?.tax?.source).toBe('header');
  });
  it('a two level merged header: the merged top level states the basis for every column under it', () => {
    const text = [
      "=== Sheet 'Offer' ===", 'Merged regions: C2:E2', 'A2: Item | C2: Prices excluding GST (Rs)', 'A3: Item | C3: Per 100 | D3: Per kg | E3: Per roll',
      'A5: Carton 450x300x250 | C5: 3100', 'A6: Carton 400x300x200 | C6: 2500', 'A7: Stretch film | D7: 120',
    ].join('\n');
    const x = extraction([['CRT-A', 'Carton 450x300x250', 3100, 'C5'], ['CRT-B', 'Carton 400x300x200', 2500, 'C6']]);
    const r = derive(text, x);
    expect(r.by('CRT-A')?.normalized).toBeCloseTo(31, 10);
    expect(r.by('CRT-A')?.result?.tax?.source).toBe('header');
  });
  it('a header that is not on row 1 and has data rows between it and the cell', () => {
    const text = ["=== Sheet 'S' ===", 'A1: Title', 'A2: Date', 'A6: Item | B6: Rate (excl GST)', 'A7: Carton 450x300x250 | B7: 3100', 'A8: Carton 400x300x200 | B8: 2500'].join('\n');
    const r = derive(text, extraction([['CRT-A', 'Carton 450x300x250', 3100, 'B7'], ['CRT-B', 'Carton 400x300x200', 2500, 'B8']]));
    expect(r.by('CRT-B')?.result?.tax?.source).toBe('header');
    expect(r.by('CRT-B')?.normalized).toBeCloseTo(25, 10);
  });
});

describe('K5a: a single column "Rate incl. GST"', () => {
  const text = ["=== Sheet 'S' ===", 'A3: Item | B3: Rate incl. GST (Rs)', 'A4: Carton 450x300x250 | B4: 3540', 'A5: Carton 400x300x200 | B5: 2360'].join('\n');
  const cells: [string, string, number, string][] = [['CRT-A', 'Carton 450x300x250', 3540, 'B4'], ['CRT-B', 'Carton 400x300x200', 2360, 'B5']];
  it('is incl at the default rate, Assumed, naming the gst_pct assumption', () => {
    const r = derive(text, extraction(cells, { tax_basis: 'excl_gst' }));
    expect(r.by('CRT-A')?.normalized).toBeCloseTo(30, 10);
    expect(r.by('CRT-A')?.result?.tax?.source).toBe('header');
    expect(r.by('CRT-A')?.assumption_keys).toContain('gst_pct');
    expect(r.by('CRT-A')?.status).toBe('assumed');
  });
  it('uses the rate named in the header', () => {
    const r = derive(text.replace('Rate incl. GST (Rs)', 'Rate incl. 12% GST (Rs)'), extraction(cells));
    expect(r.by('CRT-A')?.normalized).toBeCloseTo(3540 / 1.12 / 100, 10);
    expect(r.by('CRT-A')?.result?.tax?.rate_pct).toBe(12);
  });
  it('a neutral header leaves the line to the existing logic (document basis)', () => {
    const r = derive(text.replace('Rate incl. GST (Rs)', 'Rate (Rs)'), extraction(cells, { tax_basis: 'excl_gst' }));
    expect(r.by('CRT-A')?.result?.tax?.source).toBe('document');
    expect(r.by('CRT-A')?.normalized).toBeCloseTo(35.4, 10);
  });
});

describe('K5b: dual column rows compare the model price with each cell', () => {
  it('the price equals the including cell: Needs review, says so, nothing derived', () => {
    const x = extraction([['CRT-A', 'Carton 450x300x250', 3658, "Sheet 'Offer'!E5"], ['CRT-B', 'Carton 400x300x200', 2500, "Sheet 'Offer'!D6"]]);
    const r = derive(DUAL('Price (excl. tax)', 'Price (incl. tax)'), x);
    const a = r.by('CRT-A');
    expect(a?.normalized).toBeNull();
    expect(a?.status).toBe('needs_review');
    expect(a?.flags).toContain('tax_unresolved');
    expect(a?.reasons.join(' ')).toMatch(/Read from the including-tax column.*the basic column .* shows 3100/);
    expect(r.by('CRT-B')?.normalized).toBeCloseTo(25, 10);
  });
  it('the price equals neither cell: an evidence mismatch flag, nothing derived', () => {
    const x = extraction([['CRT-A', 'Carton 450x300x250', 3333, "Sheet 'Offer'!D5"]]);
    const a = derive(DUAL('Price (excl. tax)', 'Price (incl. tax)'), x).by('CRT-A');
    expect(a?.normalized).toBeNull();
    expect(a?.flags).toEqual(expect.arrayContaining(['evidence_mismatch', 'tax_unresolved']));
    expect(a?.status).toBe('needs_review');
  });
  it('the price equals the excluding cell while the locator names the including cell: still the excluding cell', () => {
    const x = extraction([['CRT-A', 'Carton 450x300x250', 3100, "Sheet 'Offer'!E5"]]);
    expect(derive(DUAL('Price (excl. tax)', 'Price (incl. tax)'), x).by('CRT-A')?.normalized).toBeCloseTo(31, 10);
  });
});

describe('K5c: model written notes never decide a line that has a header basis', () => {
  const WORDINGS: { name: string; doc: Record<string, unknown> }[] = [
    { name: 'none', doc: {} },
    { name: 'carton rows have basic and incl GST columns', doc: { global_notes: ['Carton rows have basic and incl GST columns'], tax_basis: 'unknown' } },
    { name: 'incl GST shown for convenience', doc: { global_notes: ['incl GST shown for convenience'], tax_basis: 'excl_gst' } },
    { name: 'an unrelated sentence', doc: { global_notes: ['Delivery within ten days of the purchase order'], tax_basis: 'unknown' } },
    { name: 'a note that says the opposite, with a statement the sheet does not contain', doc: { global_notes: ['All prices include 12 percent GST'], tax_basis: 'incl_gst', tax_statements: [{ quote: 'All prices include 12 percent GST', basis: 'incl', rate_pct: 12, scope: '', is_correction: false }] } },
  ];
  it('the same sheet gives identical derived results under every wording', () => {
    const outs = WORDINGS.map((w) => {
      const r = derive(DUAL('Price (excl. tax)', 'Price (incl. tax)', 'Terms: delivery in 10 days'), extraction(CELLS, w.doc));
      return r.derived.map((d) => ({ code: d.rfx?.code, n: d.normalized, status: d.status, flags: d.flags, reasons: d.reasons, keys: d.assumption_keys, src: d.result?.tax?.source }));
    });
    for (const o of outs) expect(o).toEqual(outs[0]);
    expect(outs[0]?.[0]).toMatchObject({ n: expect.closeTo(31, 10), status: 'confirmed', src: 'header' });
  });
  it('a prose cell in the sheet that really says the quoted prices include tax still counts: the header and the prose conflict, so Not derived', () => {
    const r = derive(DUAL('Price (excl. tax)', 'Price (incl. tax)', 'Terms: all prices quoted include 12 percent GST.'), extraction(CELLS));
    const a = r.by('CRT-A');
    expect(a?.normalized).toBeNull();
    expect(a?.flags).toContain('tax_unresolved');
    expect(a?.status).toBe('needs_review');
    expect(a?.reasons.join(' ')).toMatch(/Price \(excl\. tax\).*all prices quoted include 12 percent GST/i);
  });
  it('a prose cell that agrees with the header changes nothing', () => {
    const r = derive(DUAL('Price (excl. tax)', 'Price (incl. tax)', 'Terms: GST extra as applicable. Incl. tax prices shown for convenience.'), extraction(CELLS));
    expect(r.by('CRT-A')?.status).toBe('confirmed');
    expect(r.by('CRT-A')?.flags).not.toContain('tax_conflict');
  });
  it('lines without a header basis keep the existing document level logic', () => {
    const text = ["=== Sheet 'S' ===", 'A3: Item | B3: Rate (Rs)', 'A4: Stretch film | B4: 120'].join('\n');
    const x = extraction([['FLM-A', 'Stretch film', 120, 'B4']], { tax_basis: 'unknown', global_notes: ['All prices include 5 percent GST'] }, { 'FLM-A': { per_n: 1 } });
    const f = derive(text, x).by('FLM-A');
    expect(f?.result?.tax?.source).not.toBe('header');
  });
  it('header tax is read from the sheet text, so the grid parser round-trips what prepareXlsx writes', () => {
    const g = parseGrid(DUAL('Price (excl. tax)', 'Price (incl. tax)'));
    expect(g.sheets[0]?.name).toBe('Offer');
    const h = headerTaxFor({ text: null, locator: "Sheet 'Offer'!D5", price: 3100, per_n: 100, prose: [] }, g);
    expect(h?.basis).toBe('excl');
    expect(h?.cell).toBe('D5');
  });
});

describe('K5 on the real Metro Kraft sheet and the stored replies, with no model call', () => {
  const seed = JSON.parse(readFileSync(new URL('../../../seed/rfx.json', import.meta.url), 'utf8')) as { lines: { code: string; section: string; description: string; uom: RfxLineRow['uom']; annual_qty: number; ly_rate: number | null }[] };
  const real: RfxLineRow[] = seed.lines.map((l, i) => ({ id: `s${i}`, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate }));
  const sheet = readFileSync(new URL('../../../eval/fixtures/sandbox-metro-kraft.sheet.txt', import.meta.url), 'utf8');
  const load = (name: string) => {
    const fx = JSON.parse(readFileSync(new URL(`../../../eval/fixtures/${name}.raw.json`, import.meta.url), 'utf8')) as { replies: { text: string }[] };
    return ExtractionSchema.parse(parseJsonLoose(fx.replies.find((r) => /"document"\s*:/.test(r.text))?.text ?? ''));
  };
  // The document note that production's failed run had, and the other wordings the same reply could have carried.
  const NOTE = 'Carton rows have Basic rate (excl GST) and Rate incl GST columns';
  const variants: { name: string; notes: string[]; basis: Extraction['document']['tax_basis']; statements: Extraction['document']['tax_statements'] }[] = [
    { name: 'no tax note', notes: [], basis: 'unknown', statements: [] },
    { name: 'the production note', notes: [NOTE], basis: 'unknown', statements: [{ quote: NOTE, basis: 'incl', rate_pct: null, scope: 'cartons', is_correction: false }] as never },
    { name: 'incl GST shown for convenience', notes: ['incl GST shown for convenience'], basis: 'excl_gst', statements: [] },
    { name: 'an unrelated sentence', notes: ['Delivery as per schedule'], basis: 'unknown', statements: [] },
    { name: 'a note claiming incl', notes: ['Carton prices include GST'], basis: 'incl_gst', statements: [{ quote: 'Carton prices include GST', basis: 'incl', rate_pct: null, scope: 'cartons', is_correction: false }] as never },
  ];
  const BF = ['BF 20 (5 ply) board prices; BF 22 on 5 ply adds Rs 0.80 per carton'];
  const WANT: Record<string, number> = { 'CRT-3P-01': 6.15, 'CRT-3P-02': 9.4, 'CRT-3P-03': 4.7, 'CRT-3P-04': 14.3, 'CRT-3P-05': 2.85, 'INS-PRT-01': 9.5, 'CRT-5P-07': 16.9 };
  // The third reply is the live run made after K5 (the real model, local, in memory). Its model assigned match confidence 0.80
  // to a few lines, so those are Needs review for that reason and not for tax.
  for (const fixture of ['sandbox-metro-kraft', 'sandbox-metro-kraft-v4', 'sandbox-metro-kraft-k5']) {
    for (const v of variants) {
      it(`${fixture}, ${v.name}: all 24 lines derive their basic price, the BF 20 lines stay Needs review with no adjusted price`, () => {
        const x = load(fixture);
        x.document.global_notes = [...BF, ...v.notes];
        x.document.tax_basis = v.basis;
        x.document.tax_statements = v.statements;
        const d = deriveLines({ source_type: 'xlsx', observations: [], text: sheet } as unknown as Prepared, x, real, A);
        expect(d).toHaveLength(24);
        for (const l of d) { expect(l.flags, l.rfx?.code).not.toContain('tax_unresolved'); expect(l.normalized, l.rfx?.code).not.toBeNull(); }
        for (const [code, want] of Object.entries(WANT)) {
          const l = d.find((o) => o.rfx?.code === code);
          expect(l?.normalized, code).toBeCloseTo(want, 10);
          expect(l?.result?.tax?.source, code).toBe('header');
          if (fixture !== 'sandbox-metro-kraft-k5') expect(l?.status, code).toBe('confirmed');
        }
        const five = d.filter((o) => o.rfx?.code.startsWith('CRT-5P') && o.flags.includes('board_grade_mismatch'));
        expect(five).toHaveLength(5);
        for (const l of five) {
          expect(l.status).toBe('needs_review');
          expect(l.reasons.join(' ')).toMatch(/BF 20.*No adjusted price is computed/);
        }
      });
    }
  }
  it('the results are identical across every wording', () => {
    const outs = variants.map((v) => {
      const x = load('sandbox-metro-kraft-v4');
      x.document.global_notes = [...BF, ...v.notes]; x.document.tax_basis = v.basis; x.document.tax_statements = v.statements;
      return deriveLines({ source_type: 'xlsx', observations: [], text: sheet } as unknown as Prepared, x, real, A)
        .filter((d) => d.result?.tax?.source === 'header').map((d) => ({ code: d.rfx?.code, n: d.normalized, status: d.status, flags: d.flags, reasons: d.reasons }));
    });
    for (const o of outs) expect(o).toEqual(outs[0]);
    expect(outs[0]!.length).toBe(24);
  });
});
