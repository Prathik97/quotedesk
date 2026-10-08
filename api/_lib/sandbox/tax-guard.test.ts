// H1, H2 and H3 through the real Try your file path with a scripted model (no test can reach the real API), on a
// fixture with its own numbers and wording, plus the three Gupta raw replies replayed with no model call.
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

const usage = { input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const lines: RfxLineRow[] = [
  { id: 'l1', code: 'CRT-5P-01', section: 'Cartons', description: '5 ply RSC carton 450x300x250 mm', uom: 'piece', annual_qty: 120000, last_year_rate_inr: 100 },
  { id: 'l2', code: 'SHT-5P-01', section: 'Sheets', description: '5 ply corrugated sheet 1100x1500 mm', uom: 'kg', annual_qty: 60000, last_year_rate_inr: 55 },
  { id: 'l3', code: 'TPE-BOPP-01', section: 'Tapes', description: 'BOPP tape 48 mm x 100 m, brown', uom: 'roll', annual_qty: 60000, last_year_rate_inr: 52 },
];
const assumptions: Assumptions = { usd_inr: 96, gst_pct: 18 };
const ctx: SandboxContext = { lines, questions: [], assumptions };

// The document is a plain text reply. The correction exists only as one sentence, not on any line.
const TEXT = [
  'Rates for RFQ 77',
  'Taxes extra on all items.',
  'Carton 450x300x250 : 100 each',
  'Sheet 1100x1500 : 55 per kg',
  'BOPP tape 48mm x 100m : 52 per roll',
  'Update: carton prices already include 5 percent tax. Sheet and tape still taxes extra.',
].join('\n');
const CORRECTION = 'carton prices already include 5 percent tax';
const NOTES = ['Taxes extra on all items.', 'Update: carton prices already include 5 percent tax. Sheet and tape still taxes extra.'];

type LineOver = Record<string, unknown>;
const line = (code: string, desc: string, price: number, uom: string, locator: string, over: LineOver = {}) => ({
  rfx_line_code: code, match_confidence: 0.95, match_reason: 'size', vendor_description: desc, price, currency: 'INR', uom_text: uom, per_n: 1, inherits_last_year: false, conditions: [],
  evidence: { source_type: 'email', locator, quote: `${desc} : ${price}`, read_confidence: 'high' }, read_confidence: 'high', notes: '', ...over,
});
const reply = (perLine: Record<string, LineOver> = {}, doc: Record<string, unknown> = {}) =>
  JSON.stringify({
    document: { kind: 'quote', vendor_name_as_written: 'Test Vendor', freight_terms: 'extra', tax_basis: 'unknown', global_notes: NOTES, ...doc },
    lines: [
      line('CRT-5P-01', 'Carton 450x300x250', 100, 'each', 'L3', perLine['CRT-5P-01']),
      line('SHT-5P-01', 'Sheet 1100x1500', 55, 'per kg', 'L4', perLine['SHT-5P-01']),
      line('TPE-BOPP-01', 'BOPP tape 48mm x 100m', 52, 'per roll', 'L5', perLine['TPE-BOPP-01']),
    ],
  });

function scripted(extraction: string): LlmClient & { reqs: LlmRequest[] } {
  const c = {
    reqs: [] as LlmRequest[],
    async complete(req: LlmRequest) {
      c.reqs.push(req);
      return { text: c.reqs.length === 1 ? JSON.stringify({ kind: 'quote', confidence: 0.96, reason: 'test' }) : extraction, stop_reason: 'end_turn', usage };
    },
  };
  return c;
}
const run = (extraction: string) => {
  const client = scripted(extraction);
  const deps: CallDeps = { client, store: memoryStore() };
  const p = runSandbox({ filename: 'reply.txt', mime: 'text/plain', bytes: new TextEncoder().encode(TEXT) }, ctx, deps, { route: 'api:sandbox', session_id: 'budget', models: { fast: 'claude-haiku-4-5-20251001', extract: 'claude-sonnet-5-5' } });
  return { client, p };
};

describe('H1 on a statement that exists only in the notes (model returned no per line tax)', () => {
  it('no line gets a derived excluding GST price; the carton shows the price as written with both readings as text', async () => {
    const r = await run(reply()).p;
    for (const l of r.lines) {
      expect(l.normalized_inr, l.code ?? '').toBeNull();
      expect(l.status, l.code ?? '').toBe('needs_review');
      expect(l.flags, l.code ?? '').toContain('tax_unresolved');
    }
    const carton = r.lines.find((l) => l.code === 'CRT-5P-01');
    expect(carton?.quoted).toBe('100 INR each');
    expect(carton?.reasons.join(' ')).toContain('if excluding GST: 100.00; if including 5 percent: 95.24');
    expect(carton?.steps ?? []).toEqual([]);
  });
  it('H3: the warning says what happened and does not claim prices are shown without tax', async () => {
    const r = await run(reply()).p;
    const w = r.review.find((x) => x.kind === 'tax_conflict');
    expect(w?.message).toMatch(/3 lines are shown as Not derived/);
    expect(w?.message).not.toMatch(/shown without it|converted to a price excluding GST/);
    expect(w?.message).toContain('None is Confirmed');
  });
  it('the request carries the version of the prompt that asks for tax_statements, and the document stays inside the data block', async () => {
    const { client, p } = run(reply());
    await p;
    const system = JSON.stringify(client.reqs[1]?.system);
    expect(system).toContain('tax_source_quote');
    expect(system).toContain('tax_statements');
  });
});

describe('H1 does not depend on the model reporting the statement anywhere', () => {
  // The live shape that exposed this: the model sets a document basis of excl, leaves the notes empty of GST and returns
  // nothing on the lines. The only evidence of the correction is the document text.
  it('statements only in the document text still make every unsettled line Not derived', async () => {
    const r = await run(reply({}, { tax_basis: 'excl_gst', global_notes: ['Delivery in 7 days'] })).p;
    for (const l of r.lines) {
      expect(l.normalized_inr, l.code ?? '').toBeNull();
      expect(l.flags, l.code ?? '').toContain('tax_unresolved');
    }
    expect(r.lines.find((l) => l.code === 'CRT-5P-01')?.reasons.join(' ')).toContain('if excluding GST: 100.00; if including 5 percent: 95.24');
    expect(r.terms?.tax_basis).toBe('conflicting');
  });
  it('a quote the model reports is used only when it is in the text; one that is not, is ignored', async () => {
    const r = await run(reply({}, { tax_basis: 'excl_gst', tax_statements: [{ quote: 'all carton rates include 28 percent tax', basis: 'incl', rate_pct: 28, scope: 'carton' }] })).p;
    expect(r.lines.find((l) => l.code === 'CRT-5P-01')?.reasons.join(' ')).not.toContain('28');
  });
});

describe('H2 through the real path', () => {
  const carton = { tax_basis: 'incl', tax_rate_pct: 5, tax_source_quote: CORRECTION };
  const sheetTape = { tax_basis: 'excl', tax_source_quote: 'Sheet and tape still taxes extra' };
  const statements = [
    { quote: 'Taxes extra on all items.', basis: 'excl', scope: 'all items', is_correction: false },
    { quote: CORRECTION, basis: 'incl', rate_pct: 5, scope: 'carton prices', is_correction: true },
  ];

  it('verified resolutions: the carton is divided by the stated 5 percent and is Assumed; sheet and tape are read as excl, Assumed', async () => {
    const r = await run(reply({ 'CRT-5P-01': carton, 'SHT-5P-01': sheetTape, 'TPE-BOPP-01': sheetTape }, { tax_statements: statements })).p;
    const by = (c: string) => r.lines.find((l) => l.code === c);
    expect(by('CRT-5P-01')?.normalized_inr).toBeCloseTo(100 / 1.05, 10);
    expect(by('CRT-5P-01')?.status).toBe('assumed');
    expect(by('CRT-5P-01')?.tax).toMatchObject({ basis: 'incl_gst', rate_pct: 5, rate_source: 'stated' });
    expect(by('SHT-5P-01')?.normalized_inr).toBe(55);
    expect(by('SHT-5P-01')?.status).toBe('assumed');
    expect(by('TPE-BOPP-01')?.normalized_inr).toBe(52);
    for (const l of r.lines) expect(l.assumptions).toEqual(expect.arrayContaining(['tax_basis_model', 'tax_basis_conflict']));
    const w = r.review.find((x) => x.kind === 'tax_conflict');
    expect(w?.message).toMatch(/3 lines were settled by the model's reading/);
    expect(w?.message).toMatch(/1 line is converted to a price excluding GST \(1 at the vendor's stated rate\)/);
    expect(w?.message).not.toMatch(/Not derived/);
  });
  it('a quote the document does not contain falls back to H1 for that line only', async () => {
    const r = await run(reply({ 'CRT-5P-01': { ...carton, tax_source_quote: 'carton prices include 9 percent tax' }, 'SHT-5P-01': sheetTape, 'TPE-BOPP-01': sheetTape }, { tax_statements: statements })).p;
    const by = (c: string) => r.lines.find((l) => l.code === c);
    expect(by('CRT-5P-01')?.normalized_inr).toBeNull();
    expect(by('SHT-5P-01')?.normalized_inr).toBe(55);
    expect(r.review.find((x) => x.kind === 'tax_conflict')?.message).toMatch(/1 line is shown as Not derived/);
  });
  it('a model basis that contradicts the document statements falls back to H1', async () => {
    const wrong = { tax_basis: 'excl', tax_source_quote: 'carton prices already include 5 percent tax' };
    const r = await run(reply({ 'CRT-5P-01': wrong, 'SHT-5P-01': sheetTape, 'TPE-BOPP-01': sheetTape }, { tax_statements: statements })).p;
    expect(r.lines.find((l) => l.code === 'CRT-5P-01')?.normalized_inr).toBeNull();
  });
  it('an unreadable tax field never invalidates the reply', async () => {
    const r = await run(reply({ 'CRT-5P-01': { tax_basis: 7, tax_rate_pct: 'lots', tax_source_quote: 12 } }, { tax_statements: [{ nonsense: true }, 'x'] })).p;
    expect(r.ok).toBe(true);
    expect(r.lines).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The Gupta raw replies, replayed with no model call. Two captured samples of the same chat and one derived variance.
const seed = JSON.parse(readFileSync(new URL('../../../seed/rfx.json', import.meta.url), 'utf8')) as {
  lines: { code: string; section: string; description: string; uom: RfxLineRow['uom']; annual_qty: number; ly_rate: number | null }[];
};
const rfx: RfxLineRow[] = seed.lines.map((l, i) => ({ id: `seed-${i}`, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate }));
function replay(name: string, edit?: (x: Extraction) => void, text?: string) {
  const fx = JSON.parse(readFileSync(new URL(`../../../eval/fixtures/${name}.raw.json`, import.meta.url), 'utf8')) as { replies: { text: string }[] };
  const x: Extraction = ExtractionSchema.parse(parseJsonLoose(fx.replies.find((r) => /"document"\s*:/.test(r.text))?.text ?? ''));
  edit?.(x);
  const derived = deriveLines({ source_type: 'email', observations: [], text } as unknown as Prepared, x, rfx, assumptions);
  return { x, derived, by: (code: string) => derived.find((d) => d.rfx?.code === code) };
}
const BOX = ['CRT-5P-01', 'CRT-5P-02', 'CRT-5P-03', 'CRT-5P-05', 'CRT-3P-01', 'CRT-3P-02', 'CRT-3P-03'];
const GROSS: Record<string, number> = { 'CRT-5P-01': 28.4, 'CRT-5P-02': 24.1, 'CRT-5P-03': 37.6, 'CRT-5P-05': 16.2, 'CRT-3P-01': 6.3, 'CRT-3P-02': 9.5, 'CRT-3P-03': 4.8 };

describe.each([
  ['first captured sample (statement on every box line)', 'sandbox-gupta-whatsapp'],
  ['second captured sample (statement on every box line, other wording)', 'sandbox-gupta-whatsapp-b'],
  ['DERIVED variance fixture (per line tax conditions removed, notes kept)', 'sandbox-gupta-whatsapp-b-variance'],
])('Gupta replay: %s', (_label, name) => {
  const r = replay(name);
  it('no box line shows its GST inclusive price in the excluding GST value, whatever shape the reply has', () => {
    for (const code of BOX) {
      const d = r.by(code);
      if (!d) continue;
      expect(d.normalized === null || Math.abs((d.normalized as number) - GROSS[code]!) > 1e-9, `${code} must not carry the gross price as excl GST`).toBe(true);
    }
  });
  it('no line is Confirmed while the tax statements conflict', () => {
    for (const d of r.derived) expect(d.status).not.toBe('confirmed');
  });
  it('a line is either Not derived or has a statement of its own that was read', () => {
    for (const d of r.derived) {
      if (d.normalized != null) expect(d.result?.tax?.source, d.rfx?.code ?? '').toBe('line');
      else if (d.result?.tax?.guard) expect(d.reasons.join(' '), d.rfx?.code ?? '').toMatch(/^Not derived: /);
    }
  });
});

describe('Gupta replay: before and after for the shapes that failed', () => {
  it('statement on each line (both samples): box lines keep the stated 12 percent conversion; the edge protector, which has no statement, is Not derived', () => {
    for (const name of ['sandbox-gupta-whatsapp', 'sandbox-gupta-whatsapp-b']) {
      const r = replay(name);
      expect(r.by('CRT-5P-01')?.normalized, name).toBeCloseTo(28.4 / 1.12, 10);
      expect(r.by('CRT-3P-03')?.normalized, name).toBeCloseTo(4.8 / 1.12, 10);
      expect(r.by('INS-EDG-01')?.normalized, name).toBeNull();
    }
  });
  it('variance fixture: every line is Not derived, price as written, both readings at 12 percent for the box lines', () => {
    const r = replay('sandbox-gupta-whatsapp-b-variance');
    for (const code of BOX) {
      const d = r.by(code);
      expect(d?.normalized, code).toBeNull();
      expect(d?.status, code).toBe('needs_review');
      expect(d?.reasons.join(' '), code).toContain(`if excluding GST: ${GROSS[code]!.toFixed(2)}; if including 12 percent: ${(GROSS[code]! / 1.12).toFixed(2)}`);
    }
    expect(r.by('PLT-WD-01')?.normalized).toBeNull();
  });
  it('variance fixture plus a verified model resolution (constructed): H2 settles the box lines at the stated 12 percent, Assumed', () => {
    const quote = 'revised: box rates include 12 percent tax, sheet and tape taxes extra';
    const text = `[L1] Rates for the RFQ\n[L18] Revised: box rates include 12 percent tax, sheet and tape taxes extra.\n`;
    const r = replay('sandbox-gupta-whatsapp-b-variance', (x) => {
      for (const l of x.lines) if (BOX.includes(l.rfx_line_code ?? '')) { l.tax_basis = 'incl'; l.tax_source_quote = quote; l.match_confidence = 0.95; }
    }, text);
    for (const code of BOX) {
      const d = r.by(code);
      expect(d?.normalized, code).toBeCloseTo(GROSS[code]! / 1.12, 10);
      expect(d?.status, code).toBe('assumed');
      expect(d?.assumption_keys, code).toContain('tax_basis_model');
    }
    expect(r.by('INS-EDG-01')?.normalized).toBeNull();
  });
});

describe('the live reply of the production run that exposed the gap (fixture C, extract.v4)', () => {
  // The document text is rebuilt from the vendor words the reply itself quotes (statements and line evidence). The vendor
  // file is not in the repo, so this reproduces only the property that matters: the quotes ARE in the document.
  const fx = JSON.parse(readFileSync(new URL('../../../eval/fixtures/sandbox-gupta-whatsapp-c-v4.raw.json', import.meta.url), 'utf8')) as { replies: { text: string }[] };
  const raw = ExtractionSchema.parse(parseJsonLoose(fx.replies.find((r) => /"document"\s*:/.test(r.text))?.text ?? ''));
  const text = ['[L1] ' + raw.document.tax_statements.map((t) => t.quote).join('\n[L2] '), ...raw.lines.map((l, i) => `[L${i + 3}] ${l.evidence.quote ?? ''}`)].join('\n');
  const r = replay('sandbox-gupta-whatsapp-c-v4', undefined, text);
  it('the model set the document basis to excl, kept the box correction out of the notes and out of every line\'s conditions, and put it only in tax_statements and the line fields', () => {
    expect(r.x.document.tax_basis).toBe('excl_gst');
    expect(r.x.document.global_notes.join(' ')).not.toMatch(/box|included|incl/i);
    expect(r.x.lines.every((l) => l.conditions.every((c) => !/gst/i.test(c)))).toBe(true);
    expect(r.x.lines.filter((l) => l.tax_basis === 'incl')).toHaveLength(7);
  });
  it('H2 settles the seven box lines at the vendor\'s stated 12 percent, Assumed at most, never the gross price', () => {
    for (const code of BOX) {
      const d = r.by(code);
      expect(d?.normalized, code).toBeCloseTo(GROSS[code]! / 1.12, 10);
      expect(d?.result?.tax?.source, code).toBe('model');
      expect(d?.assumption_keys, code).toEqual(expect.arrayContaining(['tax_basis_model', 'tax_basis_conflict']));
      expect(d?.status, code).not.toBe('confirmed');
    }
  });
  it('the edge protector, which has no statement and which no resolution covers, is Not derived', () => {
    expect(r.by('INS-EDG-01')?.normalized).toBeNull();
    expect(r.by('INS-EDG-01')?.flags).toContain('tax_unresolved');
  });
  it('the same reply with the model\'s tax answers removed (the other possible variance) is safe: no line derives a price', () => {
    const t = replay('sandbox-gupta-whatsapp-c-v4', (x) => {
      x.document.tax_statements = [];
      for (const l of x.lines) { l.tax_basis = null; l.tax_source_quote = null; l.tax_rate_pct = null; }
    }, text);
    for (const d of t.derived) expect(d.normalized, d.rfx?.code ?? '').toBeNull();
  });
});
