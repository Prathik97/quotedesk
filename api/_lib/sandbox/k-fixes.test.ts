// K1 to K4 through deriveLines and the real Try your file path (scripted model, no API), on fixtures with their own
// numbers and wording, and the stored Metro Kraft reply with the document text the live run showed.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Assumptions } from '../../../engine/types.js';
import { ExtractionSchema, parseJsonLoose, type Extraction } from '../../../src/lib/schemas/extraction.js';
import { deriveLines, type RfxLineRow } from '../extract/persist.js';
import type { Prepared } from '../extract/prepare.js';
import type { CallDeps } from '../llm/call.js';
import type { LlmClient, LlmRequest } from '../llm/client.js';
import { memoryStore } from '../llm/store.js';
import { runSandbox, type SandboxContext } from './run.js';

const A: Assumptions = { usd_inr: 96, gst_pct: 18 };
const usage = { input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const rfx: RfxLineRow[] = [
  { id: 'a', code: 'CRT-A', section: 'Cartons', description: '5 ply RSC carton 450x300x250 mm', uom: 'piece', annual_qty: 1000, last_year_rate_inr: 30 },
  { id: 'b', code: 'CRT-B', section: 'Cartons', description: '5 ply RSC carton 400x300x200 mm', uom: 'piece', annual_qty: 1000, last_year_rate_inr: 25 },
  { id: 'c', code: 'FLM-A', section: 'Films', description: 'Stretch film 500 mm x 17 micron', uom: 'kg', annual_qty: 1000, last_year_rate_inr: 100 },
  { id: 'd', code: 'TPE-A', section: 'Tapes', description: 'BOPP tape 48 mm x 100 m, brown', uom: 'roll', annual_qty: 1000, last_year_rate_inr: 50 },
];

const line = (code: string, desc: string, price: number, uom: string, locator: string, quote: string, over: Record<string, unknown> = {}) => ({
  rfx_line_code: code, match_confidence: 0.95, match_reason: 'size', vendor_description: desc, price, currency: 'INR', uom_text: uom, per_n: 1, inherits_last_year: false, conditions: [],
  evidence: { source_type: 'xlsx', locator, quote, read_confidence: 'high' }, read_confidence: 'high', notes: '', ...over,
});
const extraction = (doc: Record<string, unknown> = {}, over: Record<string, Record<string, unknown>> = {}): Extraction =>
  ExtractionSchema.parse({
    document: { kind: 'quote', vendor_name_as_written: 'Test Vendor', freight_terms: 'extra', tax_basis: 'excl_gst', global_notes: [], ...doc },
    lines: [
      line('CRT-A', 'Carton 450x300x250', 3100, 'per 100', 'D5', 'D5: 3100', { per_n: 100, ...over['CRT-A'] }),
      line('CRT-B', 'Carton 400x300x200', 2500, 'per 100', 'D6', 'D6: 2500', { per_n: 100, ...over['CRT-B'] }),
      line('FLM-A', 'Stretch film 500mm', 120, 'per kg', 'D7', 'D7: 120', over['FLM-A']),
      line('TPE-A', 'BOPP tape 48mm x 100m', 2400, 'per carton', 'D8', 'D8: 2400', { evidence: { source_type: 'xlsx', locator: 'D8', quote: '2400 per carton (1 carton = 48 rolls)', read_confidence: 'high' }, ...over['TPE-A'] }),
    ],
  });

// Different column labels from the live file: "Excl tax rate" and "Rate with GST".
const SHEET = (note: string) => [
  "=== Sheet 'Rates' ===",
  'A1: ZENITH PACK',
  'A3: No | B3: Particulars | C3: Pack | D3: Excl tax rate (Rs) | E3: Rate with GST (Rs) | F3: Remarks',
  'A5: 1 | B5: Carton 450x300x250 | C5: per 100 | D5: 3100 | E5: 3472',
  'A6: 2 | B6: Carton 400x300x200 | C6: per 100 | D6: 2500 | E6: 2800',
  'A7: 3 | B7: Stretch film 500mm | C7: per kg | D7: 120',
  'A8: 4 | B8: BOPP tape 48mm x 100m | C8: per carton | D8: 2400',
  `A10: ${note}`,
].join('\n');

function derive(text: string, x: Extraction) {
  const derived = deriveLines({ source_type: 'xlsx', observations: [], text } as unknown as Prepared, x, rfx, A);
  return { derived, by: (code: string) => derived.find((d) => d.rfx?.code === code) };
}

describe('K1: a dual column sheet with an informational note derives every line at the basic column', () => {
  const header = 'A3: No | B3: Particulars | C3: Pack | D3: Excl tax rate (Rs) | E3: Rate with GST (Rs) | F3: Remarks';
  const x = extraction({
    global_notes: ['Rates with GST are listed for cartons for reference.', header],
    tax_statements: [{ quote: header, basis: 'incl', rate_pct: null, scope: 'cartons', is_correction: false }, { quote: 'E3: Rate with GST (Rs)', basis: 'incl', rate_pct: null, scope: '', is_correction: false }],
  });
  const r = derive(SHEET('Rates with GST are listed for cartons for reference.'), x);
  it('all four lines derive, the cartons per 100, none Not derived', () => {
    expect(r.by('CRT-A')?.normalized).toBeCloseTo(31, 10);
    expect(r.by('CRT-B')?.normalized).toBeCloseTo(25, 10);
    expect(r.by('FLM-A')?.normalized).toBe(120);
    for (const d of r.derived) expect(d.flags, d.rfx?.code).not.toContain('tax_unresolved');
  });
  it('the same holds when the note is worded with "listed" only, because the sheet has an including tax column', () => {
    const y = derive(SHEET('Inclusive of GST rates are listed in column E.'), extraction({ global_notes: ['Inclusive of GST rates are listed in column E.'] }));
    for (const d of y.derived) expect(d.normalized, d.rfx?.code).not.toBeNull();
  });
  it('a pack definition in the same line holds', () => {
    expect(r.by('TPE-A')?.normalized).toBeCloseTo(50, 10);
    expect(r.by('TPE-A')?.assumption_keys).toContain('pack_size');
    expect(r.by('TPE-A')?.status).toBe('assumed');
  });
});

describe('K1: a sheet whose note really says the quoted prices include tax', () => {
  it('is not made informational: the carton lines the note covers are Not derived against a document basis of excl', () => {
    const note = 'Carton prices quoted here include 12 percent GST.';
    const r = derive(SHEET(note), extraction({ global_notes: [note] }));
    expect(r.by('CRT-A')?.normalized).toBeNull();
    expect(r.by('CRT-A')?.flags).toContain('tax_unresolved');
    expect(r.by('FLM-A')?.normalized).toBe(120);
    expect(r.by('TPE-A')?.normalized).toBeCloseTo(50, 10);
  });
  it('a document that says so and whose basis is incl converts the lines at the stated rate', () => {
    const note = 'All prices quoted include 12 percent GST.';
    const r = derive(SHEET(note), extraction({ tax_basis: 'incl_gst', global_notes: [note] }));
    expect(r.by('FLM-A')?.normalized).toBeCloseTo(120 / 1.12, 10);
    expect(r.by('FLM-A')?.result?.tax?.rate_pct).toBe(12);
  });
  it('a true conflict (excl everywhere, then all prices incl) is Not derived for lines with no statement', () => {
    const r = derive(SHEET('All prices quoted include 12 percent GST.'), extraction({ global_notes: ['All rates are GST extra.', 'All prices quoted include 12 percent GST.'] }));
    for (const d of r.derived) expect(d.normalized, d.rfx?.code).toBeNull();
  });
});

describe('K4: a tax statement is quoted once, in a document warning, and each line points to it', () => {
  const note = 'Carton prices quoted here include 12 percent GST, confirmed by our accounts team on the second page of this offer, which is valid only for the quantities and the delivery dates written above in this sheet and nowhere else.';
  const TEXT = SHEET(note);
  function scripted(reply: string): LlmClient {
    let n = 0;
    return { async complete(_req: LlmRequest) { n++; return { text: n === 1 ? JSON.stringify({ kind: 'quote', confidence: 0.96, reason: 't' }) : reply, stop_reason: 'end_turn', usage }; } } as LlmClient;
  }
  it('27 repeated warnings become one document warning with a clipped quote and short line references', async () => {
    const deps: CallDeps = { client: scripted(JSON.stringify(extraction({ global_notes: [note] }))), store: memoryStore() };
    const ctx: SandboxContext = { lines: rfx, questions: [], assumptions: A };
    const res = await runSandbox({ filename: 'offer.txt', mime: 'text/plain', bytes: new TextEncoder().encode(TEXT) }, ctx, deps, { route: 'api:sandbox', session_id: 's', models: { fast: 'claude-haiku-4-5-20251001', extract: 'claude-sonnet-5-5' } });
    const doc = res.review.filter((v) => v.kind === 'tax_not_derived');
    expect(doc).toHaveLength(1);
    expect(doc[0]?.message).toContain('Carton prices quoted here include 12 percent GST');
    expect(doc[0]?.message).not.toContain('nowhere else');
    const perLine = res.review.filter((v) => v.kind === 'line_needs_review');
    expect(perLine.length).toBeGreaterThanOrEqual(2);
    for (const v of perLine) {
      expect(v.message).toMatch(/tax unresolved, see the document warning/);
      expect(v.message).not.toContain('Carton prices quoted here');
    }
  });
});

describe('K1 on the stored Metro Kraft reply with the document text the live run showed', () => {
  const seed = JSON.parse(readFileSync(new URL('../../../seed/rfx.json', import.meta.url), 'utf8')) as { lines: { code: string; section: string; description: string; uom: RfxLineRow['uom']; annual_qty: number; ly_rate: number | null }[] };
  const real: RfxLineRow[] = seed.lines.map((l, i) => ({ id: `s${i}`, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate }));
  const fx = JSON.parse(readFileSync(new URL('../../../eval/fixtures/sandbox-metro-kraft.raw.json', import.meta.url), 'utf8')) as { replies: { text: string }[] };
  const x = ExtractionSchema.parse(parseJsonLoose(fx.replies.find((r) => /"document"\s*:/.test(r.text))?.text ?? ''));
  // The header row and the note as the live run quoted them, around the evidence quotes of the priced lines.
  const header = 'A8: Sr | B8: Description of goods | C8: Size / specification | D8: Unit | E8: Basic rate (Rs) | F8: Rate incl GST (Rs) | G8: Remarks';
  const text = [header, ...x.lines.map((l, i) => `A${9 + i}: ${i + 1} | B${9 + i}: ${l.vendor_description} | ${l.evidence.quote ?? ''} | F${9 + i}: 1234.5`), 'A40: Rates incl GST shown for cartons for your convenience'].join('\n');
  x.document.tax_statements = [{ quote: header, basis: 'incl', rate_pct: null, scope: '', is_correction: false }, { quote: 'Rates incl GST shown for cartons for your convenience', basis: 'incl', rate_pct: null, scope: 'cartons', is_correction: false }] as Extraction['document']['tax_statements'];
  const derived = deriveLines({ source_type: 'xlsx', observations: [], text } as unknown as Prepared, x, real, A);
  it('no line is Not derived, the 5 ply lines keep the BF 20 text and the 3 ply lines carry no grade flag', () => {
    expect(derived).toHaveLength(24);
    for (const d of derived) expect(d.flags, d.rfx?.code).not.toContain('tax_unresolved');
    const by = (c: string) => derived.find((d) => d.rfx?.code === c);
    expect(by('CRT-3P-01')?.normalized).toBeCloseTo(6.15, 10);
    expect(by('CRT-5P-01')?.status).toBe('needs_review');
    expect(by('CRT-5P-01')?.reasons.join(' ')).toContain('add Rs 0.80 per carton for BF 22');
    for (const c of ['CRT-3P-01', 'CRT-3P-02', 'CRT-3P-03', 'CRT-3P-04', 'CRT-3P-05']) expect(by(c)?.flags).not.toContain('board_grade_mismatch');
  });
});

// The two live runs made after the K fixes (extract.v4, real model, run locally with no database). The vendor files are
// not in the repo; the document text is rebuilt from the quotes the replies themselves carry.
describe('live reruns after the K fixes, replayed with no model call', () => {
  const seed = JSON.parse(readFileSync(new URL('../../../seed/rfx.json', import.meta.url), 'utf8')) as { lines: { code: string; section: string; description: string; uom: RfxLineRow['uom']; annual_qty: number; ly_rate: number | null }[] };
  const real: RfxLineRow[] = seed.lines.map((l, i) => ({ id: `s${i}`, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate }));
  const load = (name: string) => {
    const fx = JSON.parse(readFileSync(new URL(`../../../eval/fixtures/${name}.raw.json`, import.meta.url), 'utf8')) as { replies: { text: string }[] };
    return ExtractionSchema.parse(parseJsonLoose(fx.replies.find((r) => /"document"\s*:/.test(r.text))?.text ?? ''));
  };
  const textOf = (x: Extraction) => ['[L1] ' + x.document.tax_statements.map((t) => t.quote).join('\n[L2] '), ...x.lines.map((l, i) => `[L${i + 3}] ${l.evidence.quote ?? ''}`)].join('\n');

  it('Metro Kraft: all 24 lines derive the basic price; the 5 ply lines stay Needs review with the BF 20 text and no adjusted price', () => {
    const x = load('sandbox-metro-kraft-v4');
    const d = deriveLines({ source_type: 'xlsx', observations: [], text: textOf(x) } as unknown as Prepared, x, real, A);
    expect(d).toHaveLength(24);
    for (const l of d) expect(l.flags, l.rfx?.code).not.toContain('tax_unresolved');
    expect(d.filter((l) => l.status === 'confirmed')).toHaveLength(18);
    for (const l of d.filter((v) => v.rfx?.code.startsWith('CRT-5P') && v.flags.includes('board_grade_mismatch'))) {
      expect(l.status).toBe('needs_review');
      expect(l.reasons.join(' ')).toMatch(/BF 20.*No adjusted price is computed/);
    }
    expect(d.filter((l) => l.rfx?.code.startsWith('CRT-3P')).every((l) => l.status === 'confirmed' && !l.flags.includes('board_grade_mismatch'))).toBe(true);
  });
  it('Gupta: the tape quoted per carton with the definition in its own line is 45 per roll, Assumed, pack size from the vendor', () => {
    const x = load('sandbox-gupta-whatsapp-d-v4');
    const d = deriveLines({ source_type: 'email', observations: [], text: textOf(x) } as unknown as Prepared, x, real, A);
    const t = d.find((l) => l.rfx?.code === 'TPE-BOPP-01');
    expect(t?.normalized).toBeCloseTo(45, 10);
    expect(t?.status).toBe('assumed');
    expect(t?.assumption_keys).toContain('pack_size');
  });
});
