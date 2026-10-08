// A pasted chat export through Try your file with a scripted model (no real API): tax basis (G1), box sizes (G2),
// validity in another language (G4) and the format label (G5). The numbers and words here are the test's own.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Assumptions } from '../../../engine/types.js';
import { shortValidityWarning, validityDays } from '../../../engine/terms.js';
import type { CallDeps } from '../llm/call.js';
import type { LlmClient, LlmRequest } from '../llm/client.js';
import { memoryStore } from '../llm/store.js';
import { deriveLines, type RfxLineRow } from '../extract/persist.js';
import type { Prepared } from '../extract/prepare.js';
import { ExtractionSchema, parseJsonLoose } from '../../../src/lib/schemas/extraction.js';
import { looksLikeChatExport, runSandbox, type SandboxContext } from './run.js';

const usage = { input_tokens: 400, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const rfx = (code: string, description: string, uom: RfxLineRow['uom'] = 'piece', ly = 10): RfxLineRow => ({ id: code, code, section: 'S', description, uom, annual_qty: 1000, last_year_rate_inr: ly });
const lines: RfxLineRow[] = [
  rfx('BX-3P-01', '3 ply RSC carton 300x200x150 mm, BF 18'),
  rfx('BX-3P-02', '3 ply RSC carton 350x250x200 mm, BF 18'),
  rfx('BX-3P-03', '3 ply RSC carton 400x300x250 mm, BF 18'),
  rfx('BX-5P-01', '5 ply RSC carton 350x250x200 mm, BF 22'),
  rfx('SH-5P-01', '5 ply corrugated sheet 1100x1500 mm', 'kg', 44),
];
const assumptions: Assumptions = { usd_inr: 96, gst_pct: 18 };
const ctx: SandboxContext = { lines, questions: [], assumptions, validity_days: 90 };

const CHAT = [
  '[03/11/2026, 09:01:10] Anil Rao (Rao Cartons): all prices plus GST please note',
  '3ply boxes',
  '14x10x8 inch - 9.5 each',
  '12x8x6 - 6.3 each',
  '[03/11/2026, 09:05:41] Anil Rao (Rao Cartons): sheet 5ply 1100x1500 - 46 per kg',
  '[03/11/2026, 09:09:02] Anil Rao (Rao Cartons): correction, box rates include GST at 5%. Offer valid for 21 dino only',
].join('\n');

const line = (over: Record<string, unknown>) => ({
  rfx_line_code: 'BX-3P-02', match_confidence: 0.95, match_reason: 'size', vendor_description: '3ply box 14x10x8 inch', price: 105, currency: 'INR', uom_text: 'each', per_n: 1,
  inherits_last_year: false, conditions: ['GST included 5% per correction'], evidence: { source_type: 'email', locator: 'L3', quote: '14x10x8 inch - 105 each', read_confidence: 'high' }, read_confidence: 'high', notes: '', ...over,
});
const extraction = (ls: object[], doc: Record<string, unknown> = {}) =>
  JSON.stringify({
    document: { kind: 'quote', vendor_name_as_written: 'Rao Cartons', tax_basis: 'unknown', validity_text: 'Offer valid for 21 dino only', global_notes: ['all prices plus GST', 'correction: box rates include GST at 5%'], ...doc },
    lines: ls, unmatched_lines: [], questionnaire: [],
  });

function runWith(reply: string, text = CHAT, filename = 'chat.txt') {
  const replies = [JSON.stringify({ kind: 'quote', confidence: 0.97, reason: 't' }), reply];
  let n = 0;
  const client: LlmClient = { complete: async (_r: LlmRequest) => ({ text: replies[Math.min(n++, 1)] as string, stop_reason: 'end_turn', usage }) };
  const deps: CallDeps = { client, store: memoryStore() };
  return runSandbox({ filename, mime: 'text/plain', bytes: new TextEncoder().encode(text) }, ctx, deps, { route: 'api:sandbox', session_id: 's', models: { fast: 'claude-haiku-4-5-20251001', extract: 'claude-sonnet-5-5' } });
}

describe('tax basis through the sandbox (G1)', () => {
  it('105 including 5 percent is shown as 100.00 excluding GST, Assumed at most because the document also says all prices plus GST', async () => {
    const r = await runWith(extraction([line({})]));
    const l = r.lines[0]!;
    expect(l.normalized_inr).toBeCloseTo(100, 10);
    expect(l.tax).toMatchObject({ basis: 'incl_gst', rate_pct: 5, rate_source: 'stated', conflict: true });
    expect(l.steps).toEqual([{ op: 'divide', factor: 1.05, reason: expect.stringMatching(/stated 5 percent/) }]);
    expect(l.status).not.toBe('confirmed');
    expect(r.terms?.tax_basis).toBe('conflicting');
    const item = r.review.find((x) => x.kind === 'tax_conflict');
    expect(item?.severity).toBe('warn');
    expect(item?.message).toContain('all prices plus GST');
    expect(item?.message).toContain('GST included 5% per correction');
  });
  it('a line stated excluding GST in the same document is not capped by the conflict and keeps its price', async () => {
    const sheet = line({ rfx_line_code: 'SH-5P-01', vendor_description: 'sheet 5ply 1100x1500', price: 46, uom_text: 'per kg', conditions: ['GST extra'], evidence: { source_type: 'email', locator: 'L5', quote: 'sheet 5ply 1100x1500 - 46 per kg', read_confidence: 'high' } });
    const r = await runWith(extraction([line({}), sheet]));
    const s = r.lines.find((x) => x.code === 'SH-5P-01')!;
    expect(s.normalized_inr).toBe(46);
    expect(s.tax).toMatchObject({ basis: 'excl_gst', conflict: false });
    expect(s.assumptions).not.toContain('tax_basis_conflict');
  });
  it('inclusive with no rate stated anywhere divides by the default and says it is assumed', async () => {
    const r = await runWith(extraction([line({ conditions: ['rate is inclusive of GST'] })], { global_notes: [] }));
    const l = r.lines[0]!;
    expect(l.normalized_inr).toBeCloseTo(105 / 1.18, 10);
    expect(l.tax).toMatchObject({ rate_source: 'assumed', rate_pct: 18 });
    expect(l.assumptions).toContain('gst_pct');
    expect(r.terms?.tax_basis).toBe('unknown');
    expect(r.review.some((x) => x.kind === 'tax_conflict')).toBe(false);
  });
  it('a model that returns a structured document basis of excl still has a line that says included flagged, not silently converted as excl', async () => {
    const r = await runWith(extraction([line({})], { tax_basis: 'excl_gst', global_notes: [] }));
    expect(r.lines[0]?.normalized_inr).toBeCloseTo(100, 10);
    expect(r.terms?.tax_basis).toBe('conflicting');
  });
});

describe('box size through the sandbox (G2)', () => {
  const wrong = line({ rfx_line_code: 'BX-3P-03', match_confidence: 0.6, vendor_description: '3ply box 14x10x8 (inch assumed)', conditions: [], price: 9.5, evidence: { source_type: 'email', locator: 'L3', quote: '14x10x8 - 9.5 each', read_confidence: 'high' } });
  it('14x10x8 inch matched to the 400x300x250 line is flagged, names the 350x250x200 line, and is not re-mapped', async () => {
    const r = await runWith(extraction([wrong], { tax_basis: 'excl_gst', global_notes: [] }));
    const l = r.lines[0]!;
    expect(l.code).toBe('BX-3P-03');
    expect(l.status).toBe('needs_review');
    expect(l.flags).toContain('dimension_mismatch');
    expect(l.reasons.join(' ')).toMatch(/BX-3P-02 at 200 x 250 x 350 mm fits better and has no price in this document/);
    expect(l.reasons.join(' ')).not.toMatch(/BX-5P-01/); // same ply only
    expect(r.not_quoted).toContain('BX-3P-02');
  });
  it('a line whose size matches carries positive evidence and is still not promoted by it', async () => {
    const good = line({ rfx_line_code: 'BX-3P-02', match_confidence: 0.7, conditions: [], price: 9.5, vendor_description: '3ply box 14x10x8 (inch assumed)' });
    const r = await runWith(extraction([good], { tax_basis: 'excl_gst', global_notes: [] }));
    const l = r.lines[0]!;
    expect(l.notes.join(' ')).toMatch(/Size check: the vendor's 14x10x8/);
    expect(l.status).toBe('needs_review'); // match confidence 0.7 is below the bar; the size match does not lift it
  });
  it('two vendor lines on the same RFx line are flagged on both and named in a review item', async () => {
    const a = line({ rfx_line_code: 'BX-3P-02', conditions: [], vendor_description: '3ply box 14x10x8 inch' });
    const b = line({ rfx_line_code: 'BX-3P-02', conditions: [], vendor_description: '3ply box 13.5x10x8 inch', price: 9.7 });
    const r = await runWith(extraction([a, b], { tax_basis: 'excl_gst', global_notes: [] }));
    expect(r.lines.map((l) => l.flags.includes('duplicate_rfx_match'))).toEqual([true, true]);
    expect(r.lines.every((l) => l.status === 'needs_review')).toBe(true);
    expect(r.review.find((x) => x.kind === 'duplicate_rfx_match')?.message).toContain('BX-3P-02');
  });
});

describe('validity in another language (G4)', () => {
  it.each([
    ['Offer valid for 21 dino only', 21],
    ['Rates 10 din ke liye valid', 10],
    ['quote good for 2 hafte', 14],
    ['validez 15 dias', 15],
    ['valid for 3 months', 90],
    ['valid till 31 Dec', null],
  ])('%s', (text, days) => {
    expect(validityDays(text)).toBe(days);
  });
  it('21 days warns against 90, and the result shows the days it read', async () => {
    const r = await runWith(extraction([line({ conditions: [] })], { tax_basis: 'excl_gst', global_notes: [] }));
    expect(r.terms?.validity).toBe('Offer valid for 21 dino only');
    expect(r.terms?.validity_days).toBe(21);
    expect(r.review.find((x) => x.kind === 'short_validity')?.message).toBe(shortValidityWarning('Offer valid for 21 dino only', 90));
  });
});

describe('format label (G5)', () => {
  it('a timestamped chat is a chat export (text); behaviour is otherwise unchanged', async () => {
    const r = await runWith(extraction([line({ conditions: [] })], { tax_basis: 'excl_gst', global_notes: [] }));
    expect(r.format_label).toBe('chat export (text)');
    expect(r.source_type).toBe('email');
    expect(r.ok).toBe(true);
  });
  it('plain notes and an email are not', async () => {
    const r = await runWith(extraction([line({ conditions: [] })], { tax_basis: 'excl_gst', global_notes: [] }), 'Dear sir\nCarton 14x10x8 at 9.5 each\nRegards');
    expect(r.format_label).toBe('email');
  });
  it('detects WhatsApp styles and rejects a normal text', () => {
    expect(looksLikeChatExport('[L1] 3/11/26, 9:05 pm - Ravi: hello\n[L2] 3/11/26, 9:06 pm - Ravi: rates below\n[L3] 3/11/26, 9:07 pm - Sam: ok')).toBe(true);
    expect(looksLikeChatExport('[L1] Subject: rates\n[L2] 12.03.2026 we quote 5 items\n[L3] Regards')).toBe(false);
  });
});

describe('the captured Gupta style reply replayed with no model (regression fixture)', () => {
  const fx = JSON.parse(readFileSync(new URL('../../../eval/fixtures/sandbox-gupta-whatsapp.raw.json', import.meta.url), 'utf8')) as { replies: { text: string }[] };
  const x = ExtractionSchema.parse(parseJsonLoose(fx.replies.find((r) => /"document"\s*:/.test(r.text))?.text ?? ''));
  const seed = JSON.parse(readFileSync(new URL('../../../seed/rfx.json', import.meta.url), 'utf8')) as { lines: { code: string; section: string; description: string; uom: RfxLineRow['uom']; annual_qty: number; ly_rate: number | null }[] };
  const rfxLines: RfxLineRow[] = seed.lines.map((l, i) => ({ id: `s${i}`, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate }));
  const derived = deriveLines({ source_type: 'email', observations: [] } as unknown as Prepared, x, rfxLines, assumptions);
  const by = (code: string) => derived.find((d) => d.rfx?.code === code)!;

  it('the model captured the inclusive statement only as text, so the engine reads the line conditions', () => {
    expect(x.document.tax_basis).toBe('unknown');
    expect(by('CRT-5P-01').line.conditions.join(' ')).toMatch(/GST included 12%/);
  });
  it('28.4 including 12 percent is 25.36 excluding GST, divided by 1.12 and never above Assumed', () => {
    const d = by('CRT-5P-01');
    expect(d.normalized).toBeCloseTo(28.4 / 1.12, 10);
    expect(d.normalized?.toFixed(2)).toBe('25.36');
    expect(d.result?.steps.map((s) => s.factor)).toEqual([1.12]);
    expect(d.status).not.toBe('confirmed');
    expect(d.flags).toContain('tax_conflict');
  });
  it('every box line is converted at 12 percent; sheet, tape, film and strap stay excluding GST', () => {
    for (const d of derived.filter((x2) => x2.rfx?.code.startsWith('CRT-'))) expect(d.result?.tax?.rate_pct, d.rfx?.code).toBe(12);
    for (const code of ['SHT-5P-01', 'STP-PET-01', 'FLM-STR-01']) expect(by(code).result?.tax?.basis, code).toBe('excl_gst');
    expect(by('STP-PET-01').normalized).toBe(126);
  });
  it('10 din is read as 10 days and warns against the RFx 90', () => {
    expect(validityDays(x.document.validity_text)).toBe(10);
    expect(shortValidityWarning(x.document.validity_text, 90)).toBe('Offer valid for 10 days, shorter than the 90 days the RFx asks for.');
  });
  it('payment and delivery were captured by the model in informal words', () => {
    expect(x.document.payment_terms_text).toMatch(/Payment 15 days/);
    expect(x.questionnaire.find((q) => q.question_code === 'Q6')?.answer_value).toBe(7);
    expect(x.questionnaire.find((q) => q.question_code === 'Q8')?.answer_value).toBe(15);
  });
});
