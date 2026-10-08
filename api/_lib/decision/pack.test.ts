// The decision pack. The fixture is in testdata.ts and every expected number below was worked out by hand.
//
// FR-8.2 is the point of this file: the memo must list EVERY assumption and EVERY unresolved item for the
// scenario. The expectations here are taken from the fixture, not from the pack builder, so a builder that
// forgets something fails these tests.
import ExcelJS from 'exceljs';
import { PDFArray, PDFDocument, decodePDFRawStream, type PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildAppendix } from './appendix.js';
import { blocksText, memoBlocks, missingFromMemo, pdfSafe, renderMemo, type Block } from './memo.js';
import { templateResult } from './note.js';
import { buildPack, requiredMemoStrings, scenarioFromRequest, scenarioSlug, type PackData, type PackRequest } from './pack.js';
import { fixtureData, fixtureItems, INJECTION, NOW } from './testdata.js';

const base: PackRequest = { strategy: 'cheapest_per_line', include_pending: false, apply_discounts: false, price_basis: 'confirmed_assumed' };
const make = (over: Partial<PackRequest> = {}): PackData => buildPack(fixtureData(), { ...base, ...over }, NOW);
const render = (p: PackData) => memoBlocks(p, templateResult(p));

/** Every text run the PDF draws, in order. pdf-lib writes standard font text as hex strings in the page content streams. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const runs: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    for (const st of streams) {
      const text = Buffer.from(decodePDFRawStream(st as PDFRawStream).decode()).toString('latin1');
      for (const m of text.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) runs.push(Buffer.from(m[1] as string, 'hex').toString('latin1'));
    }
  }
  return runs.join(' ').replace(/\s+/g, ' ');
}
const norm = (s: string) => pdfSafe(s).replace(/\s+/g, ' ').trim();

describe('scenario numbers (worked by hand)', () => {
  it('default scenario: cleared vendors, cheapest per line, confirmed and assumed prices', () => {
    // L1 V1 9.50 x 100 = 950.  L2 V2 4.50 x 200 = 900.  L3 V2 19 x 50 = 950 (assumed).  L4: V1 needs review is not usable and V2 did not quote it, so a gap.
    // Goods 2,800. Last year on the 3 awarded lines 3,000, saving 200 (6.667 percent). V2 holds 1,850 of 2,800.
    const r = make().result;
    expect(r.totals.goods_total_inr).toBeCloseTo(2800, 6);
    expect(r.totals.ly_value_of_awarded_lines_inr).toBeCloseTo(3000, 6);
    expect(r.totals.savings_vs_ly_inr).toBeCloseTo(200, 6);
    expect(r.totals.lines_awarded).toBe(3);
    expect(r.coverage_gaps.map((g) => g.line_code)).toEqual(['FLM-1']);
    expect(r.concentration.top_vendor_key).toBe('V2');
    expect(r.concentration.top_share).toBeCloseTo(1850 / 2800, 9);
    expect(r.totals.landed_complete).toBe(false);
  });
  it('is not ready, with the V1 cell that needs review as a blocker', () => {
    const p = make();
    expect(p.readiness.label).toBe('Not ready');
    expect(p.readiness.blockers.map((b) => b.vendor_key)).toEqual(['V1']);
  });
  it('including Pending vendors adds V4, whose last year price fills the gap', () => {
    // L4 now goes to V4 at 100 x 10 = 1,000 (assumed). Goods 950 + 900 + 950 + 1,000 = 3,800. V4 is Pending, so it is a blocker too.
    const p = make({ include_pending: true });
    expect(p.result.totals.goods_total_inr).toBeCloseTo(3800, 6);
    expect(p.result.coverage_gaps).toHaveLength(0);
    expect(p.readiness.blockers.map((b) => `${b.vendor_key}:${b.kind}`)).toContain('V4:knockout_pending');
  });
  it('confirmed only drops the assumed V2 price on L3', () => {
    // L3 has no Confirmed price from a cleared vendor (V1 and V2 are both Assumed), so it joins the gaps. Goods 950 + 900 = 1,850.
    const p = make({ price_basis: 'confirmed' });
    expect(p.result.totals.goods_total_inr).toBeCloseTo(1850, 6);
    expect(p.result.coverage_gaps.map((g) => g.line_code)).toEqual(['TPE-1', 'FLM-1']);
  });
  it('names the scenario in the file slug', () => {
    expect(scenarioSlug(scenarioFromRequest(base))).toBe('cheapest-per-line_cleared-only');
    expect(scenarioSlug(scenarioFromRequest({ ...base, include_pending: true, apply_discounts: true, price_basis: 'confirmed' }))).toBe('cheapest-per-line_incl-pending_confirmed-prices_with-discounts');
    expect(scenarioSlug(scenarioFromRequest({ ...base, strategy: 'single_vendor', vendor: 'V1' }))).toBe('single-vendor-v1_cleared-only');
  });
});

describe('FR-8.2: the memo lists every assumption and every unresolved item', () => {
  const scenarios: [string, Partial<PackRequest>][] = [
    ['default', {}],
    ['including Pending vendors', { include_pending: true }],
    ['confirmed prices only', { price_basis: 'confirmed' }],
    ['with discounts', { apply_discounts: true }],
    ['split with a 60 percent cap', { strategy: 'split_cap', max_share: 0.6, include_pending: true }],
    ['cheapest per section', { strategy: 'cheapest_per_section' }],
    ['single vendor V2', { strategy: 'single_vendor', vendor: 'V2' }],
  ];

  for (const [name, over] of scenarios) {
    it(`prints everything the scenario data holds: ${name}`, () => {
      const p = make(over);
      const printed = norm(blocksText(render(p)));
      const expectIn = (what: string, s: string) => expect(printed.includes(norm(s)), `${what} is missing from the memo: ${s}`).toBe(true);
      const included = new Set(p.readiness.included_vendors);

      // Every global assumption.
      for (const a of fixtureData().compare.assumptions) {
        expectIn('assumption label', a.label);
        expectIn('assumption value', String(a.value));
      }
      // Every open review item of an included vendor (taken from the fixture, with vendor text scrubbed).
      const keyOf = (id: string) => `V${id.split('-')[1]}`;
      for (const i of fixtureItems().filter((x) => included.has(keyOf(x.vendor_id)))) {
        if (i.kind === 'suspicious_content') expectIn('suspicious item', 'Instruction-like text was found in a vendor document');
        else expectIn(`item ${i.kind}`, i.message);
      }
      // Every readiness blocker and open item.
      for (const b of p.readiness.blockers) expectIn('blocker', b.message);
      for (const o of p.readiness.open_items) expectIn('open item', o.message);
      // Every awarded Assumed price: the line is named under its vendor's assumption.
      for (const row of p.result.allocation.filter((a) => a.vendor_key && a.status === 'assumed')) expectIn('assumed line', row.line_code);
      // Every Needs review or Conflict cell of an included vendor.
      for (const c of fixtureData().compare.cells.filter((x) => x.status === 'needs_review' || x.status === 'conflict')) {
        const k = keyOf(c.vendor_id);
        if (included.has(k)) expectIn('unresolved cell', `${k} ${fixtureData().compare.lines.find((l) => l.id === c.rfx_line_id)?.code}: Needs review`);
      }
      // Every certificate, and an expired one is marked.
      for (const a of fixtureData().compare.attachments) expectIn('certificate', a.filename.replace('.pdf', '').length ? `CERT-${a.vendor_id.split('-')[1]}` : '');
      expect(printed).toContain('(EXPIRED)');
      // The guard agrees.
      expect(missingFromMemo(render(p), requiredMemoStrings(p))).toEqual([]);
    });
  }

  it('lists the lines behind each assumed price, per vendor', () => {
    // Including V4: all four of its prices are last year inheritance and all four are awarded or not. V2 L3 is a USD price.
    const p = make({ include_pending: true });
    const texts = p.risk.applied_assumptions.map((a) => a.text).join('\n');
    expect(texts).toMatch(/V2 Beta Board Mills, Priced in USD.*TPE-1/);
    expect(texts).toMatch(/V4 Delta Pack Imports, Same as last year.*FLM-1/);
  });

  it('words each next step as an action, with the vendor named', () => {
    const steps = make({ include_pending: true }).next_steps.map((n) => n.text);
    expect(steps).toContain('Ask V2 for its USD to INR rate in writing, or agree one, for its 1 line priced in US dollars.');
    expect(steps.join(' ')).not.toMatch(/\busd\b/);
    expect(steps.some((x) => /^Ask V4 to confirm in writing that last year's price holds for its 1 line/.test(x))).toBe(true);
  });

  it('fails when an assumption or an open item is dropped from the memo', () => {
    const p = make({ include_pending: true });
    const blocks = render(p);
    expect(missingFromMemo(blocks, requiredMemoStrings(p))).toEqual([]);
    const drop = (match: RegExp): Block[] => blocks.filter((b) => !(b.t === 'item' && match.test(b.text)));
    // An assumption group, an unresolved item, a needs review cell and a global assumption.
    expect(missingFromMemo(drop(/Priced in USD/), requiredMemoStrings(p))).toHaveLength(1);
    expect(missingFromMemo(drop(/Freight is extra and no amount/), requiredMemoStrings(p))).toHaveLength(1);
    expect(missingFromMemo(drop(/V1 FLM-1: Needs review/), requiredMemoStrings(p))).toHaveLength(1);
    expect(missingFromMemo(drop(/USD to INR rate: INR 96/), requiredMemoStrings(p))).toHaveLength(1);
  });

  it('refuses nothing in the scenario data without the memo showing it: a new item reaches the memo', () => {
    const data = fixtureData();
    data.items.push({ id: 'item-x', vendor_id: 'vendor-1', quote_line_id: null, line_code: null, kind: 'new_kind_nobody_planned_for', severity: 'warn', message: 'A brand new open item with a unique marker 7Q9Z', value_at_stake_inr: null });
    const p = buildPack(data, base, NOW);
    expect(norm(blocksText(render(p)))).toContain('A brand new open item with a unique marker 7Q9Z');
  });

  it('is in the PDF itself, not only in the block list', async () => {
    const p = make({ include_pending: true });
    const pdf = await renderMemo(render(p), { title: 't', subject: 's', header: 'h', footer: 'f', now: NOW });
    const text = await pdfText(pdf);
    const missing = requiredMemoStrings(p).filter((s) => !text.includes(norm(s)));
    expect(missing).toEqual([]);
    expect(text).toContain('Award decision memo');
    expect(text).toMatch(/Page 1 of \d+/);
  });
});

describe('what the memo must never contain', () => {
  it('has no em dash or en dash, even when a vendor document had one', async () => {
    const p = make({ include_pending: true });
    expect(fixtureItems().some((i) => i.message.includes('\u2014'))).toBe(true);
    const blocks = render(p);
    expect(blocksText(blocks)).not.toMatch(/[\u2013\u2014]/);
    const text = await pdfText(await renderMemo(blocks, { title: 't', subject: 's', header: 'h', footer: 'f', now: NOW }));
    expect(text).not.toMatch(/[\u2013\u2014\u0096\u0097]/);
    expect(text).toContain('outsourced, confirm in house testing');
  });
  it('does not print injected vendor instructions', () => {
    const p = make();
    expect(blocksText(render(p))).not.toContain(INJECTION);
    expect(JSON.stringify(p.risk)).not.toContain(INJECTION);
  });
  it('uses Rs, not the rupee sign a standard font cannot draw', () => {
    expect(blocksText(render(make()))).not.toContain('₹');
  });
  it('paginates a long register and splits an unbreakable word instead of failing', async () => {
    const data = fixtureData();
    for (let i = 0; i < 80; i++) data.items.push({ id: `bulk-${i}`, vendor_id: 'vendor-2', quote_line_id: null, line_code: null, kind: 'bulk', severity: 'warn', message: `Bulk item ${i} ${'x'.repeat(i === 3 ? 400 : 10)} some more words to wrap across the line`, value_at_stake_inr: null });
    const p = buildPack(data, { ...base, include_pending: true }, NOW);
    const pdf = await renderMemo(render(p), { title: 't', subject: 's', header: 'h', footer: 'f', now: NOW });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThan(5);
  });
});

describe('the appendix workbook', () => {
  it('carries the allocation, assumptions, open items and the questionnaire matrix', async () => {
    const p = make({ include_pending: true });
    const buf = await buildAppendix(p, templateResult(p));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Read me', 'Allocation by line', 'By vendor', 'Assumptions', 'Open items', 'Before a PO', 'Questionnaire matrix', 'Sensitivity', 'Certificates']);
    const alloc = wb.getWorksheet('Allocation by line')!;
    expect(alloc.rowCount).toBe(1 + 4);
    const l4 = alloc.getRow(5);
    expect(l4.getCell(1).value).toBe('FLM-1');
    expect(l4.getCell(6).value).toBe('V4');
    expect(l4.getCell(11).value).toBeCloseTo(1000, 6);
    const q = wb.getWorksheet('Questionnaire matrix')!;
    // 4 questions plus the result row, and 4 fixed columns plus 3 per vendor.
    expect(q.rowCount).toBe(1 + 4 + 1);
    expect(q.columnCount).toBe(4 + 3 * 4);
    const all: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => typeof c.value === 'string' && all.push(c.value))));
    const joined = all.join('\n');
    // The appendix carries the same assumptions and unresolved items as the memo.
    for (const s of [...p.risk.global_assumptions, ...p.risk.applied_assumptions, ...p.risk.unconfirmed_cells, ...p.risk.unresolved, ...p.next_steps].map((x) => x.text)) expect(joined.includes(pdfSafe(s)), `appendix lacks: ${s}`).toBe(true);
    expect(joined).not.toMatch(/[\u2013\u2014]/);
    expect(joined).not.toContain(INJECTION);
    expect(all.filter((v) => /^[=+@]/.test(v))).toEqual([]);
  });
});
