// The decision memo. Two layers:
//   memoBlocks(pack, note)  a plain list of headings, paragraphs and tables. Pure, so a test and the
//                           route can check that nothing the memo must show is missing (FR-8.2).
//   renderMemo(blocks)      draws the blocks with pdf-lib: pure JavaScript, no headless browser, so
//                           it runs inside a Vercel function and ships in the function bundle.
// Standard PDF fonts only. They cannot draw the rupee sign, so amounts are written "Rs".
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { STATUS_LABEL, toCellStatus } from '../../../engine/certainty.js';
import { formatIndian } from '../../../engine/format.js';
import { noDashes } from './text.js';
import type { NoteResult } from './note.js';
import { STRATEGY_NAME, rs, rsCompact, type PackData } from './pack.js';

// ---------------------------------------------------------------- blocks

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export type Block =
  | { t: 'title'; text: string; sub: string[] }
  | { t: 'h1' | 'h2' | 'h3'; text: string }
  | { t: 'p'; text: string; small?: boolean; muted?: boolean }
  | { t: 'item'; text: string; tag?: { text: string; tone: Tone } }
  | { t: 'kv'; rows: [string, string][] }
  | { t: 'metrics'; items: { label: string; value: string; sub?: string }[] }
  | { t: 'callout'; tone: Tone; title: string; text: string }
  | { t: 'table'; head: string[]; rows: string[][]; widths: number[]; align: ('l' | 'r')[]; size?: number }
  | { t: 'break' };

const none = (title: string): Block => ({ t: 'p', text: title, muted: true });

function statusWord(s: string | null): string {
  return s ? STATUS_LABEL[toCellStatus(s as never)] : 'Not quoted';
}

function eligibilityName(p: PackData): string {
  return p.scenario.filters.eligibility === 'cleared' ? 'Cleared vendors only' : 'Cleared vendors and Pending vendors (a Pending vendor may still fail)';
}

export function memoBlocks(p: PackData, note: NoteResult): Block[] {
  const r = p.result;
  const t = r.totals;
  const b: Block[] = [];
  const tone: Tone = p.readiness.level === 'ready' ? 'good' : p.readiness.level === 'ready_with_open_items' ? 'warn' : 'bad';
  const savingWord = t.savings_vs_ly_inr >= 0 ? 'Saving against last year' : 'Extra cost against last year';

  b.push({ t: 'title', text: 'Award decision memo', sub: [p.rfx.title, `${p.rfx.buyer_org}. Prepared ${p.generated_on}.`, `Scenario: ${STRATEGY_NAME[p.scenario.strategy]}. ${eligibilityName(p)}.`] });
  b.push({
    t: 'callout', tone, title: `Decision readiness: ${p.readiness.label}`,
    text: `${p.readiness.summary} ${p.readiness.blockers.length} ${p.readiness.blockers.length === 1 ? 'blocker' : 'blockers'} and ${p.readiness.open_items.length} open ${p.readiness.open_items.length === 1 ? 'item' : 'items'} for the vendors included. Every assumption and every unresolved item is listed in the risk register (section 7).`,
  });
  b.push({
    t: 'metrics',
    items: [
      { label: 'Goods total, excluding GST', value: rsCompact(t.goods_total_inr), sub: rs(t.goods_total_inr, 0) },
      { label: t.landed_complete ? 'Landed total (goods plus freight)' : 'Landed total, a floor', value: rsCompact(t.landed_total_inr), sub: t.landed_complete ? 'Freight is known for every vendor' : 'Freight is unknown for at least one vendor' },
      { label: 'Last year, same lines', value: rsCompact(t.ly_value_of_awarded_lines_inr), sub: rs(t.ly_value_of_awarded_lines_inr, 0) },
      { label: savingWord, value: rsCompact(Math.abs(t.savings_vs_ly_inr)), sub: t.savings_vs_ly_pct == null ? '' : `${Math.abs(t.savings_vs_ly_pct).toFixed(2)} percent` },
      { label: 'Lines awarded', value: `${t.lines_awarded} of ${t.lines_total}`, sub: r.coverage_gaps.length ? `${r.coverage_gaps.length} not covered` : 'No coverage gaps' },
      { label: 'Largest vendor share', value: r.concentration.top_vendor_key ? `${r.concentration.top_vendor_key} ${(r.concentration.top_share * 100).toFixed(1)} percent` : 'None', sub: `${r.concentration.vendor_count} ${r.concentration.vendor_count === 1 ? 'vendor' : 'vendors'} awarded` },
    ],
  });

  // 1. Scenario and rationale
  b.push({ t: 'h1', text: '1. Scenario and rationale' });
  b.push({
    t: 'kv',
    rows: [
      ['Strategy', STRATEGY_NAME[p.scenario.strategy]],
      ['Eligible vendors', eligibilityName(p)],
      ['Prices used', p.scenario.filters.price_basis === 'confirmed' ? 'Confirmed only' : 'Confirmed and Assumed'],
      ['Conditional discounts', p.scenario.filters.apply_discounts ? 'Applied where the threshold is met' : 'Not applied'],
      ['USD to INR rate', `${p.assumptions.usd_inr}`],
      ['GST', `${p.assumptions.gst_pct} percent, display only. All prices exclude GST.`],
      ...(p.scenario.constraints.vendor ? ([['Vendor', p.scenario.constraints.vendor]] as [string, string][]) : []),
      ...(p.scenario.constraints.max_share != null ? ([['Share cap', `${Math.round(p.scenario.constraints.max_share * 100)} percent`]] as [string, string][]) : []),
    ],
  });
  for (const s of p.rationale) b.push({ t: 'p', text: s });
  if (p.buyer_note) {
    b.push({ t: 'h3', text: "Buyer's note" });
    b.push({ t: 'p', text: p.buyer_note });
  }
  b.push({ t: 'h3', text: 'Vendors considered' });
  b.push({
    t: 'table', size: 7.5, widths: [0.26, 0.12, 0.1, 0.38, 0.14], align: ['l', 'l', 'l', 'l', 'r'],
    head: ['Vendor', 'Questionnaire', 'In scenario', 'Why', 'Lines awarded'],
    rows: r.vendors_considered.map((v) => [`${v.vendor_key} ${v.vendor_name}`, v.questionnaire ?? 'Not read', v.eligible ? 'Yes' : 'No', v.reason, String(r.by_vendor.find((x) => x.vendor_key === v.vendor_key)?.lines ?? 0)]),
  });

  // 2. Approval note
  b.push({ t: 'h1', text: '2. Draft approval note' });
  b.push({ t: 'p', text: note.text });
  b.push({ t: 'p', small: true, muted: true, text: note.label });

  // 3. Allocation by vendor
  b.push({ t: 'h1', text: '3. Allocation by vendor' });
  if (r.by_vendor.length === 0) b.push(none('No vendor receives any line under these filters.'));
  else {
    b.push({
      t: 'table', size: 7.5, widths: [0.24, 0.07, 0.15, 0.08, 0.16, 0.15, 0.15], align: ['l', 'r', 'r', 'r', 'l', 'r', 'l'],
      head: ['Vendor', 'Lines', 'Goods value (Rs)', 'Share', 'Freight', 'Landed total (Rs)', 'Questionnaire'],
      rows: r.by_vendor.map((v) => [
        `${v.vendor_key} ${v.vendor_name}`, String(v.lines), formatIndian(v.goods_value_inr, 0), `${(v.share * 100).toFixed(1)}%`,
        v.freight_terms === 'included' ? 'Included' : v.freight_terms === 'extra' ? (v.freight_amount_inr == null ? 'Extra, no amount' : `Extra, Rs ${formatIndian(v.freight_amount_inr, 0)}`) : 'Not stated',
        `${formatIndian(v.landed_total_inr, 0)}${v.landed_complete ? '' : ' (floor)'}`, v.questionnaire ?? 'Not read',
      ]),
    });
    for (const v of r.by_vendor.filter((x) => !x.landed_complete)) b.push({ t: 'p', small: true, muted: true, text: `${v.vendor_key} landed total is a floor. ${v.landed_note}` });
  }

  // 4. Allocation by line
  b.push({ t: 'h1', text: '4. Allocation by line' });
  b.push({
    t: 'table', size: 7, widths: [0.105, 0.225, 0.065, 0.13, 0.085, 0.1, 0.145, 0.145], align: ['l', 'l', 'l', 'r', 'r', 'l', 'r', 'r'],
    head: ['Line', 'Description', 'Vendor', 'Annual qty', 'Price (Rs)', 'Status', 'Annual value (Rs)', 'Saving vs last year (Rs)'],
    rows: r.allocation.map((a) => [
      a.line_code, p.descriptions[a.line_code] ?? '', a.vendor_key ?? 'None', `${formatIndian(a.annual_qty, 0)} ${a.uom}`,
      a.price == null ? 'n/a' : `${formatIndian(a.price, 2)}${a.discount_pct ? '*' : ''}`, a.vendor_key ? statusWord(a.status) : 'Not covered',
      a.annual_value_inr == null ? 'n/a' : formatIndian(a.annual_value_inr, 0), a.saving_vs_ly_inr == null ? 'n/a' : formatIndian(a.saving_vs_ly_inr, 0),
    ]),
  });
  b.push({ t: 'p', small: true, muted: true, text: 'Prices are INR per base unit excluding GST. A price marked * is after a conditional discount. A negative saving is a cost above last year. Not covered means no eligible vendor quoted a usable price; it is never counted as zero.' });

  // 5. Totals, savings, concentration
  b.push({ t: 'h1', text: '5. Totals, savings and concentration' });
  b.push({
    t: 'kv',
    rows: [
      ['Goods total, excluding GST', rs(t.goods_total_inr)],
      ['Landed total', `${rs(t.landed_total_inr)}${t.landed_complete ? '' : ' (a floor: freight is unknown for at least one vendor)'}`],
      ['Last year, same lines', rs(t.ly_value_of_awarded_lines_inr)],
      [t.savings_vs_ly_inr >= 0 ? 'Saving against last year' : 'Extra cost against last year', `${rs(Math.abs(t.savings_vs_ly_inr))}${t.savings_vs_ly_pct == null ? '' : ` (${Math.abs(t.savings_vs_ly_pct).toFixed(2)} percent)`}`],
      ['Lines not covered', `${r.coverage_gaps.length}${r.coverage_gaps.length ? `, worth ${rs(t.ly_value_of_gap_lines_inr, 0)} at last year's rates (information only, not in the totals)` : ''}`],
      ['Concentration', `Largest share ${(r.concentration.top_share * 100).toFixed(1)} percent (${r.concentration.top_vendor_key ?? 'none'}), ${r.concentration.vendor_count} ${r.concentration.vendor_count === 1 ? 'vendor' : 'vendors'}, Herfindahl index ${r.concentration.hhi.toFixed(3)}`],
      ['Prices relied on', `${r.reliance.confirmed} Confirmed (${rs(r.reliance.confirmed_value_inr, 0)}), ${r.reliance.assumed} Assumed (${rs(r.reliance.assumed_value_inr, 0)}), ${r.reliance.needs_review} Needs review, ${r.reliance.conflict} Conflict`],
    ],
  });
  if (r.discounts.length) {
    b.push({ t: 'h3', text: 'Conditional discounts' });
    b.push({
      t: 'table', size: 7.5, widths: [0.08, 0.07, 0.3, 0.14, 0.1, 0.1, 0.21], align: ['l', 'r', 'l', 'r', 'l', 'l', 'r'],
      head: ['Vendor', 'Percent', 'Condition as the vendor wrote it', 'Vendor PO at list (Rs)', 'Met', 'Applied', 'Saving if applied (Rs)'],
      rows: r.discounts.map((d) => [d.vendor_key, `${d.percent}`, d.condition, formatIndian(d.vendor_po_value_inr, 0), d.met == null ? 'Unreadable' : d.met ? 'Yes' : 'No', d.applied ? 'Yes' : 'No', formatIndian(d.applied ? d.saving_inr : d.potential_saving_inr, 0)]),
    });
    b.push({ t: 'p', small: true, muted: true, text: 'A discount is never part of a base price. It applies only when the vendor allocation, treated as one PO at list price, is above the threshold.' });
  }
  for (const w of p.warnings) b.push({ t: 'item', tag: { text: 'Engine note', tone: 'neutral' }, text: w });

  // 6. Sensitivity
  b.push({ t: 'h1', text: '6. Sensitivity' });
  b.push({ t: 'p', text: 'Each figure is the award engine run again with one thing changed. Goods totals exclude GST. Nothing here is estimated.' });
  b.push({
    t: 'table', size: 7.5, widths: [0.2, 0.26, 0.26, 0.28], align: ['l', 'r', 'r', 'l'],
    head: ['USD to INR rate', 'Goods total, no discount (Rs)', 'Goods total, with discount (Rs)', 'Note'],
    rows: p.sensitivity.fx.map((x) => [
      `${x.usd_inr}${x.is_current ? ' (current)' : ''}`,
      x.without_discount.ok ? formatIndian(x.without_discount.goods_inr, 0) : 'n/a', x.with_discount.ok ? formatIndian(x.with_discount.goods_inr, 0) : 'n/a',
      x.without_discount.ok && !x.without_discount.landed_complete ? 'Freight unknown: landed is a floor' : '',
    ]),
  });
  b.push({ t: 'p', small: true, muted: true, text: p.sensitivity.fx_note });
  b.push({ t: 'p', small: true, muted: true, text: p.sensitivity.discount_note });
  const lost = p.sensitivity.top_vendor_lost;
  b.push({ t: 'h3', text: 'If the top vendor is lost' });
  if (!lost) b.push(none('No vendor holds any award, so there is nothing to lose.'));
  else {
    if (lost.strategy_note) b.push({ t: 'p', text: lost.strategy_note });
    if (!lost.cell.ok) b.push({ t: 'p', text: `${lost.vendor_key} holds ${lost.share_pct.toFixed(1)} percent of the award. ${lost.note}` });
    else {
      b.push({
        t: 'p',
        text: `${lost.vendor_key} holds ${lost.share_pct.toFixed(1)} percent of the award. Without ${lost.vendor_key} the goods total is ${rs(lost.cell.goods_inr, 0)} for ${lost.cell.lines_awarded} of ${lost.cell.lines_total} lines${lost.goods_delta_inr == null ? '' : `, ${lost.goods_delta_inr >= 0 ? 'an increase' : 'a decrease'} of ${rs(Math.abs(lost.goods_delta_inr), 0)}${lost.goods_delta_pct == null ? '' : ` (${Math.abs(lost.goods_delta_pct).toFixed(2)} percent)`}`}. ${lost.note}${lost.new_top_vendor ? ` The largest vendor would then be ${lost.new_top_vendor}.` : ''}`,
      });
      if (lost.lines_uncovered.length) b.push({ t: 'p', text: `Lines left with no eligible vendor: ${lost.lines_uncovered.join(', ')}.` });
    }
  }

  // 7. Risk register
  const k = p.risk;
  b.push({ t: 'h1', text: '7. Risk register' });
  b.push({ t: 'p', muted: true, small: true, text: 'This register lists every assumption used and every unresolved item for the vendors included in this scenario. It cannot be shortened: the memo is not produced if an item is missing.' });
  b.push({ t: 'h2', text: '7.1 Assumptions in force' });
  for (const x of k.global_assumptions) b.push({ t: 'item', text: x.text });
  b.push({ t: 'h2', text: '7.2 Assumed prices the award relies on' });
  if (k.applied_assumptions.length === 0) b.push(none('No awarded price depends on an assumption.'));
  for (const x of k.applied_assumptions) b.push({ t: 'item', tag: { text: x.vendor_key, tone: 'warn' }, text: x.text });
  b.push({ t: 'h2', text: '7.3 Prices that need review or are in conflict' });
  if (k.unconfirmed_cells.length === 0) b.push(none('No included vendor has a Needs review or Conflict price.'));
  for (const x of k.unconfirmed_cells) b.push({ t: 'item', tag: { text: STATUS_LABEL[x.status], tone: 'bad' }, text: x.text });
  b.push({ t: 'h2', text: '7.4 Unresolved items' });
  if (k.unresolved.length === 0) b.push(none('Nothing is open for the vendors included.'));
  for (const x of k.unresolved) b.push({ t: 'item', tag: { text: x.severity === 'block' ? 'Blocker' : x.severity === 'warn' ? 'Open' : 'Note', tone: x.severity === 'block' ? 'bad' : x.severity === 'warn' ? 'warn' : 'neutral' }, text: x.text });
  b.push({ t: 'h2', text: '7.5 Flags on awarded prices' });
  if (k.flags.length === 0) b.push(none('No awarded price carries a flag.'));
  for (const x of k.flags) b.push({ t: 'item', text: x.text });
  b.push({ t: 'h2', text: '7.6 Certificates and attachments' });
  if (k.certificates.length === 0) b.push(none('No certificate was read.'));
  for (const x of k.certificates) b.push({ t: 'item', tag: x.state === 'expired' ? { text: 'Expired', tone: 'bad' } : x.state === 'expires_soon' ? { text: 'Soon', tone: 'warn' } : undefined, text: x.text });
  b.push({ t: 'h2', text: '7.7 Vendors left out and lines not covered' });
  if (k.excluded_vendors.length === 0 && k.coverage_gaps.length === 0) b.push(none('Every vendor is in this scenario and every line is covered.'));
  for (const x of k.excluded_vendors) b.push({ t: 'item', text: x.text });
  for (const x of k.coverage_gaps) b.push({ t: 'item', tag: { text: 'Gap', tone: 'warn' }, text: x.text });

  // 8. Questionnaire summary
  b.push({ t: 'h1', text: '8. Questionnaire summary' });
  b.push({ t: 'p', text: 'Cleared means the vendor passed all three knockout questions. Pending means no knockout failed but at least one is undecided. Failed means at least one knockout failed. The full matrix of twelve questions is in the appendix workbook.' });
  const qm = p.questionnaire;
  b.push({
    t: 'table', size: 7.5, widths: [0.34, ...qm.vendors.map(() => 0.66 / qm.vendors.length)], align: ['l', ...qm.vendors.map(() => 'l' as const)],
    head: ['Knockout question', ...qm.vendors.map((v) => v.key)],
    rows: [
      ...qm.questions.filter((q) => q.is_knockout).map((q) => [`${q.code} ${q.text}`, ...qm.vendors.map((v) => outcomeWord(q.cells[v.key]?.outcome ?? null))]),
      ['Questionnaire result', ...qm.vendors.map((v) => v.result)],
    ],
  });
  for (const q of qm.questions.filter((x) => x.is_knockout)) {
    for (const v of qm.vendors) {
      const c = q.cells[v.key];
      if (c && (c.outcome === 'fail' || c.outcome === 'pending') && c.reason) b.push({ t: 'item', tag: { text: `${v.key} ${q.code}`, tone: c.outcome === 'fail' ? 'bad' : 'warn' }, text: `${shortQuestion(q.text)}: ${c.reason}` });
    }
  }

  // 9. Open items before a PO
  b.push({ t: 'h1', text: '9. Open items before a PO goes out' });
  if (p.next_steps.length === 0) b.push(none('Nothing is open. The award can go to a PO once the approver signs.'));
  else b.push({ t: 'p', text: 'Items marked Blocks PO can change who wins or what the total is. The others do not change the award but should be closed or accepted in writing.' });
  p.next_steps.forEach((x, i) => b.push({ t: 'item', tag: { text: x.blocking ? 'Blocks PO' : 'Open', tone: x.blocking ? 'bad' : 'warn' }, text: `${i + 1}. ${x.text}` }));

  b.push({ t: 'h3', text: 'How this memo was made' });
  b.push({
    t: 'p', small: true, muted: true,
    text: `Every figure is computed by tested code from the stored extraction results and the assumptions above; the extraction itself was read by a model with the source quoted for each price. ${note.source === 'model' ? 'Only the approval note in section 2 was drafted by a model, from the scenario data alone, and its figures were checked against that data.' : 'The approval note in section 2 is a template filled from the scenario data. No model wrote any part of this memo.'} Statuses: Confirmed, Assumed, Needs review, Conflict, Not quoted.`,
  });
  return b.map(cleanBlock);
}

/** Generated copy never holds an em or en dash, whatever a vendor document said. */
function cleanBlock(x: Block): Block {
  const c = (v: string) => noDashes(v);
  switch (x.t) {
    case 'title': return { ...x, text: c(x.text), sub: x.sub.map(c) };
    case 'h1': case 'h2': case 'h3': return { ...x, text: c(x.text) };
    case 'p': return { ...x, text: c(x.text) };
    case 'item': return { ...x, text: c(x.text), tag: x.tag ? { ...x.tag, text: c(x.tag.text) } : undefined };
    case 'kv': return { ...x, rows: x.rows.map(([a, v]) => [c(a), c(v)] as [string, string]) };
    case 'metrics': return { ...x, items: x.items.map((i) => ({ label: c(i.label), value: c(i.value), sub: i.sub === undefined ? undefined : c(i.sub) })) };
    case 'callout': return { ...x, title: c(x.title), text: c(x.text) };
    case 'table': return { ...x, head: x.head.map(c), rows: x.rows.map((r) => r.map(c)) };
    default: return x;
  }
}

/** The first clause of a question, enough to tell which one a reason belongs to. */
function shortQuestion(t: string): string {
  return (t.split(/[?.]/)[0] ?? t).trim();
}

function outcomeWord(o: string | null): string {
  return o === 'pass' ? 'Pass' : o === 'fail' ? 'Fail' : o === 'pending' ? 'Pending' : 'Not answered';
}

/** All the text the memo prints, in order. Used by the completeness guard. */
export function blocksText(blocks: Block[]): string {
  const out: string[] = [];
  for (const x of blocks) {
    if (x.t === 'title') out.push(x.text, ...x.sub);
    else if (x.t === 'h1' || x.t === 'h2' || x.t === 'h3' || x.t === 'p') out.push(x.text);
    else if (x.t === 'item') out.push(x.tag?.text ?? '', x.text);
    else if (x.t === 'kv') x.rows.forEach(([a, c]) => out.push(a, c));
    else if (x.t === 'metrics') x.items.forEach((i) => out.push(i.label, i.value, i.sub ?? ''));
    else if (x.t === 'callout') out.push(x.title, x.text);
    else if (x.t === 'table') out.push(...x.head, ...x.rows.flat());
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- text safety

/** House style and font safety: no em or en dashes, no characters a standard PDF font cannot draw. */
export function pdfSafe(s: string, chars?: Set<number>): string {
  const t = noDashes(s.replace(/\u20b9/g, 'Rs '))
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00a0\u2009\u202f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ');
  if (!chars) return t;
  let out = '';
  for (const ch of t) out += chars.has(ch.codePointAt(0) as number) ? ch : '?';
  return out;
}

/** Required strings that the memo does not print. Whitespace and font safety are normalised on both sides. */
export function missingFromMemo(blocks: Block[], required: string[]): string[] {
  const norm = (x: string) => pdfSafe(x).replace(/\s+/g, ' ').trim();
  const printed = norm(blocksText(blocks));
  return required.filter((r) => !printed.includes(norm(r)));
}

// ---------------------------------------------------------------- rendering

const PAGE = { w: 595.28, h: 841.89, left: 46, right: 46, top: 58, bottom: 52 };
const CW = PAGE.w - PAGE.left - PAGE.right;
const C = {
  ink: rgb(0.059, 0.09, 0.165), ink2: rgb(0.2, 0.255, 0.333), muted: rgb(0.39, 0.455, 0.545), line: rgb(0.886, 0.91, 0.94), soft: rgb(0.945, 0.961, 0.976),
  teal: rgb(0.059, 0.463, 0.431), good: rgb(0.082, 0.502, 0.239), warn: rgb(0.706, 0.325, 0.035), bad: rgb(0.725, 0.11, 0.11),
  goodBg: rgb(0.94, 0.99, 0.96), warnBg: rgb(1, 0.973, 0.92), badBg: rgb(0.996, 0.949, 0.949), neutralBg: rgb(0.945, 0.961, 0.976),
};
const TONE = (t: Tone) => ({ fg: t === 'good' ? C.good : t === 'warn' ? C.warn : t === 'bad' ? C.bad : C.ink2, bg: t === 'good' ? C.goodBg : t === 'warn' ? C.warnBg : t === 'bad' ? C.badBg : C.neutralBg });

class Writer {
  pdf!: PDFDocument;
  regular!: PDFFont;
  bold!: PDFFont;
  chars!: Set<number>;
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;

  static async create(meta: { title: string; subject: string; now: Date }): Promise<Writer> {
    const w = new Writer();
    w.pdf = await PDFDocument.create();
    w.regular = await w.pdf.embedFont(StandardFonts.Helvetica);
    w.bold = await w.pdf.embedFont(StandardFonts.HelveticaBold);
    w.chars = new Set(w.regular.getCharacterSet());
    w.pdf.setTitle(meta.title);
    w.pdf.setSubject(meta.subject);
    w.pdf.setAuthor('QuoteDesk');
    w.pdf.setCreator('QuoteDesk');
    w.pdf.setProducer('QuoteDesk with pdf-lib');
    w.pdf.setCreationDate(meta.now);
    w.pdf.setModificationDate(meta.now);
    w.newPage();
    return w;
  }

  safe(s: string): string {
    return pdfSafe(s, this.chars);
  }

  newPage(): void {
    this.page = this.pdf.addPage([PAGE.w, PAGE.h]);
    this.pages.push(this.page);
    this.y = PAGE.h - PAGE.top;
  }

  ensure(h: number): void {
    if (this.y - h < PAGE.bottom) this.newPage();
  }

  width(text: string, size: number, bold = false): number {
    return (bold ? this.bold : this.regular).widthOfTextAtSize(text, size);
  }

  /** Greedy word wrap. A single word wider than the line is split by character as a last resort. */
  wrap(text: string, size: number, maxW: number, bold = false): string[] {
    const t = this.safe(text).trim();
    if (!t) return [''];
    const lines: string[] = [];
    let cur = '';
    for (const word of t.split(' ')) {
      if (!word) continue;
      const trial = cur ? `${cur} ${word}` : word;
      if (this.width(trial, size, bold) <= maxW) {
        cur = trial;
        continue;
      }
      if (cur) lines.push(cur);
      if (this.width(word, size, bold) <= maxW) {
        cur = word;
        continue;
      }
      let chunk = '';
      for (const ch of word) {
        if (this.width(chunk + ch, size, bold) > maxW && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      cur = chunk;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  text(s: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
    const clean = this.safe(s);
    if (!clean) return;
    this.page.drawText(clean, { x, y, size, font: opts.bold ? this.bold : this.regular, color: opts.color ?? C.ink });
  }

  paragraph(text: string, o: { size?: number; color?: ReturnType<typeof rgb>; bold?: boolean; x?: number; width?: number; gap?: number } = {}): void {
    const size = o.size ?? 9;
    const lead = size * 1.4;
    const x = o.x ?? PAGE.left;
    const lines = this.wrap(text, size, o.width ?? CW - (x - PAGE.left), o.bold);
    // Keep at least two lines together so a paragraph is not stranded.
    this.ensure(lead * Math.min(lines.length, 2) + 2);
    for (const l of lines) {
      this.ensure(lead);
      this.y -= lead;
      this.text(l, x, this.y + size * 0.28, size, { bold: o.bold, color: o.color });
    }
    this.y -= o.gap ?? 4;
  }

  heading(level: 1 | 2 | 3, text: string): void {
    const size = level === 1 ? 13 : level === 2 ? 10.5 : 9;
    this.ensure(size * 1.4 + 60);
    this.y -= level === 1 ? 14 : 8;
    this.y -= size * 1.2;
    this.text(text, PAGE.left, this.y + size * 0.2, size, { bold: true, color: level === 3 ? C.muted : C.teal });
    if (level === 1) {
      this.y -= 4;
      this.page.drawLine({ start: { x: PAGE.left, y: this.y }, end: { x: PAGE.w - PAGE.right, y: this.y }, thickness: 0.6, color: C.line });
    }
    this.y -= 5;
  }

  item(block: Extract<Block, { t: 'item' }>): void {
    const size = 8.6;
    const lead = size * 1.4;
    const tagW = block.tag ? Math.max(46, this.width(this.safe(block.tag.text), 7, true) + 10) : 0;
    const indent = tagW ? tagW + 6 : 10;
    const lines = this.wrap(block.text, size, CW - indent);
    this.ensure(lead * Math.min(lines.length, 2) + 3);
    const top = this.y;
    if (block.tag) {
      const tone = TONE(block.tag.tone);
      this.page.drawRectangle({ x: PAGE.left, y: top - lead + 1, width: tagW, height: 10.5, color: tone.bg, borderColor: tone.fg, borderWidth: 0.4 });
      this.text(block.tag.text, PAGE.left + 4, top - lead + 4.2, 7, { bold: true, color: tone.fg });
    } else {
      this.page.drawCircle({ x: PAGE.left + 3, y: top - lead * 0.55 + 1.2, size: 1.2, color: C.muted });
    }
    for (const l of lines) {
      this.ensure(lead);
      this.y -= lead;
      this.text(l, PAGE.left + indent, this.y + size * 0.28, size);
    }
    this.y -= 3;
  }

  kv(rows: [string, string][]): void {
    const size = 8.6;
    const lead = size * 1.4;
    const keyW = 130;
    for (const [k, v] of rows) {
      const lines = this.wrap(v, size, CW - keyW - 6);
      this.ensure(lead * lines.length + 2);
      let first = true;
      for (const l of lines) {
        this.y -= lead;
        if (first) this.text(k, PAGE.left, this.y + size * 0.28, size, { bold: true, color: C.ink2 });
        this.text(l, PAGE.left + keyW, this.y + size * 0.28, size);
        first = false;
      }
      this.y -= 1.5;
    }
    this.y -= 4;
  }

  callout(b: Extract<Block, { t: 'callout' }>): void {
    const tone = TONE(b.tone);
    const lines = this.wrap(b.text, 8.8, CW - 24);
    const h = 16 + 14 + lines.length * 12.4 + 8;
    this.ensure(h + 4);
    this.page.drawRectangle({ x: PAGE.left, y: this.y - h, width: CW, height: h, color: tone.bg, borderColor: tone.fg, borderWidth: 0.8 });
    this.page.drawRectangle({ x: PAGE.left, y: this.y - h, width: 4, height: h, color: tone.fg });
    this.text(b.title, PAGE.left + 14, this.y - 20, 11.5, { bold: true, color: tone.fg });
    let yy = this.y - 36;
    for (const l of lines) {
      this.text(l, PAGE.left + 14, yy, 8.8);
      yy -= 12.4;
    }
    this.y -= h + 10;
  }

  metrics(items: { label: string; value: string; sub?: string }[]): void {
    const cols = 3;
    const gap = 8;
    const w = (CW - gap * (cols - 1)) / cols;
    const h = 52;
    for (let i = 0; i < items.length; i += cols) {
      this.ensure(h + gap);
      items.slice(i, i + cols).forEach((m, j) => {
        const x = PAGE.left + j * (w + gap);
        this.page.drawRectangle({ x, y: this.y - h, width: w, height: h, color: C.soft, borderColor: C.line, borderWidth: 0.6 });
        this.text(m.label, x + 8, this.y - 14, 7.2, { color: C.muted });
        this.text(m.value, x + 8, this.y - 31, 12.5, { bold: true });
        if (m.sub) this.text(m.sub, x + 8, this.y - 44, 7.2, { color: C.muted });
      });
      this.y -= h + gap;
    }
    this.y -= 2;
  }

  table(b: Extract<Block, { t: 'table' }>): void {
    const size = b.size ?? 7.5;
    const lead = size * 1.32;
    const pad = 3.2;
    const total = b.widths.reduce((a, c) => a + c, 0);
    const colW = b.widths.map((x) => (x / total) * CW);
    const drawHeader = () => {
      const lines = b.head.map((h, i) => this.wrap(h, size, (colW[i] as number) - pad * 2, true));
      const h = Math.max(...lines.map((l) => l.length)) * lead + pad * 2;
      this.ensure(h + lead * 2 + pad * 2);
      this.page.drawRectangle({ x: PAGE.left, y: this.y - h, width: CW, height: h, color: C.soft });
      let x = PAGE.left;
      lines.forEach((ls, i) => {
        const w = colW[i] as number;
        ls.forEach((l, k) => {
          const tw = this.width(l, size, true);
          this.text(l, b.align[i] === 'r' ? x + w - pad - tw : x + pad, this.y - pad - size - k * lead + size * 0.2, size, { bold: true, color: C.ink2 });
        });
        x += w;
      });
      this.page.drawLine({ start: { x: PAGE.left, y: this.y - h }, end: { x: PAGE.left + CW, y: this.y - h }, thickness: 0.6, color: C.muted });
      this.y -= h;
    };
    drawHeader();
    b.rows.forEach((row, ri) => {
      const cells = row.map((c, i) => this.wrap(c, size, (colW[i] as number) - pad * 2));
      const h = Math.max(...cells.map((l) => l.length)) * lead + pad * 2;
      if (this.y - h < PAGE.bottom) {
        this.newPage();
        drawHeader();
      }
      if (ri % 2 === 1) this.page.drawRectangle({ x: PAGE.left, y: this.y - h, width: CW, height: h, color: rgb(0.978, 0.985, 0.992) });
      let x = PAGE.left;
      cells.forEach((ls, i) => {
        const w = colW[i] as number;
        ls.forEach((l, k) => {
          const tw = this.width(l, size);
          this.text(l, b.align[i] === 'r' ? x + w - pad - tw : x + pad, this.y - pad - size - k * lead + size * 0.2, size);
        });
        x += w;
      });
      this.page.drawLine({ start: { x: PAGE.left, y: this.y - h }, end: { x: PAGE.left + CW, y: this.y - h }, thickness: 0.3, color: C.line });
      this.y -= h;
    });
    this.y -= 8;
  }

  title(b: Extract<Block, { t: 'title' }>): void {
    this.y -= 4;
    this.text('QuoteDesk', PAGE.left, this.y, 8.5, { bold: true, color: C.teal });
    this.y -= 24;
    this.text(b.text, PAGE.left, this.y, 22, { bold: true });
    this.y -= 12;
    for (const s of b.sub) {
      for (const l of this.wrap(s, 9.5, CW)) {
        this.y -= 13;
        this.text(l, PAGE.left, this.y, 9.5, { color: C.ink2 });
      }
    }
    this.y -= 12;
  }

  /** Running header and footer on every page, once the page count is known. */
  finish(header: string, footer: string): void {
    const n = this.pages.length;
    this.pages.forEach((pg, i) => {
      if (i > 0) {
        pg.drawText(this.safe('QuoteDesk award decision memo'), { x: PAGE.left, y: PAGE.h - 30, size: 7.5, font: this.bold, color: C.teal });
        const h = this.safe(header);
        pg.drawText(h, { x: PAGE.w - PAGE.right - this.width(h, 7.5), y: PAGE.h - 30, size: 7.5, font: this.regular, color: C.muted });
        pg.drawLine({ start: { x: PAGE.left, y: PAGE.h - 36 }, end: { x: PAGE.w - PAGE.right, y: PAGE.h - 36 }, thickness: 0.4, color: C.line });
      }
      pg.drawLine({ start: { x: PAGE.left, y: 38 }, end: { x: PAGE.w - PAGE.right, y: 38 }, thickness: 0.4, color: C.line });
      pg.drawText(this.safe(footer), { x: PAGE.left, y: 26, size: 7, font: this.regular, color: C.muted });
      const pn = `Page ${i + 1} of ${n}`;
      pg.drawText(pn, { x: PAGE.w - PAGE.right - this.width(pn, 7), y: 26, size: 7, font: this.regular, color: C.muted });
    });
  }
}

export async function renderMemo(blocks: Block[], meta: { title: string; subject: string; header: string; footer: string; now: Date }): Promise<Uint8Array> {
  const w = await Writer.create({ title: meta.title, subject: meta.subject, now: meta.now });
  for (const b of blocks) {
    switch (b.t) {
      case 'title': w.title(b); break;
      case 'h1': w.heading(1, b.text); break;
      case 'h2': w.heading(2, b.text); break;
      case 'h3': w.heading(3, b.text); break;
      case 'p': w.paragraph(b.text, { size: b.small ? 7.8 : 9, color: b.muted ? C.muted : C.ink }); break;
      case 'item': w.item(b); break;
      case 'kv': w.kv(b.rows); break;
      case 'metrics': w.metrics(b.items); break;
      case 'callout': w.callout(b); break;
      case 'table': w.table(b); break;
      case 'break': w.newPage(); break;
    }
  }
  w.finish(meta.header, meta.footer);
  return w.pdf.save({ useObjectStreams: false });
}
