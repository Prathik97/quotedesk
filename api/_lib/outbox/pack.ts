// The RFx pack: a simple PDF of the RFx (terms, line items by section, questionnaire) attached to each
// simulated email. Drawn with pdf-lib through the same writer as the decision memo. It works from a plain
// PackInput, so a visitor's draft and the saved FY27 RFx go through the same code.
import { formatIndian } from '../../../engine/format.js';
import { describeRule, type PassRule } from '../../../engine/questionnaire.js';
import { bySection, unitLabel, type DraftRfx } from '../../../engine/rfx.js';
import { renderMemo, type Block } from '../decision/memo.js';
import { noDashes } from '../decision/text.js';

export type PackInput = {
  title: string;
  buyer_org: string;
  ref: string | null;
  scope_summary: string | null;
  delivery_location: string | null;
  payment_terms_days: number | null;
  validity_days: number | null;
  gst_basis: string | null;
  currency: string;
  timeline: { clarifications_by_day: number | null; quotes_due_day: number | null; award_by_day: number | null };
  lines: { code: string; section: string; description: string; spec: string | null; unit: string; annual_qty: number | null }[];
  questions: { code: string; text: string; is_knockout: boolean; rule: string | null }[];
};

export const GST_TEXT: Record<string, string> = { excl_gst: 'Prices excluding GST', incl_gst: 'Prices including GST' };

/** A buyer's draft, as a pack. The buyer organisation is passed in (the demo buyer), not typed by the visitor. */
export function packFromDraft(rfx: DraftRfx, buyerOrg: string): PackInput {
  const t = rfx.terms;
  return {
    title: t.title ?? 'Request for quotation', buyer_org: buyerOrg, ref: null, scope_summary: t.scope_summary, delivery_location: t.delivery_location,
    payment_terms_days: t.payment_terms_days, validity_days: t.validity_days, gst_basis: t.gst_basis, currency: t.currency ?? 'INR',
    timeline: { clarifications_by_day: t.clarifications_by_day, quotes_due_day: t.quotes_due_day, award_by_day: t.award_by_day },
    lines: rfx.lines.map((l) => ({ code: l.code, section: l.section, description: l.description, spec: l.spec, unit: unitLabel(l), annual_qty: l.annual_qty })),
    questions: rfx.questions.map((q) => ({ code: q.code, text: q.text, is_knockout: q.is_knockout, rule: describeRule(q.pass_rule as PassRule | null) })),
  };
}

const days = (n: number | null) => (n == null ? 'Not set' : `${n} days`);
const day = (n: number | null) => (n == null ? 'Not set' : `Day ${n} after issue`);

export function packBlocks(p: PackInput, generatedOn: string): Block[] {
  const b: Block[] = [];
  b.push({ t: 'title', text: 'Request for quotation', sub: [p.title, `${p.buyer_org}${p.ref ? `. Reference ${p.ref}` : ''}. Issued ${generatedOn}.`] });
  if (p.scope_summary) {
    b.push({ t: 'h2', text: 'Scope' });
    b.push({ t: 'p', text: p.scope_summary });
  }
  b.push({ t: 'h2', text: 'Commercial terms' });
  b.push({
    t: 'kv',
    rows: [
      ['Delivery location', p.delivery_location ?? 'Not set'],
      ['Payment terms requested', days(p.payment_terms_days)],
      ['Quote validity', days(p.validity_days)],
      ['Prices', `${p.currency}. ${p.gst_basis ? (GST_TEXT[p.gst_basis] ?? p.gst_basis) : 'GST basis not set'}`],
      ['Clarification questions by', day(p.timeline.clarifications_by_day)],
      ['Quotes due', day(p.timeline.quotes_due_day)],
      ['Award decision by', day(p.timeline.award_by_day)],
    ],
  });
  b.push({ t: 'h2', text: `Line items (${p.lines.length})` });
  b.push({ t: 'p', text: 'Price every line per the unit shown, in the currency above. If you cannot quote a line, say so rather than leaving it blank. You may reply in any format.', small: true, muted: true });
  for (const g of bySection(p.lines.map((l) => ({ ...l, uom: l.unit, spec: l.spec, pack_size: null })))) {
    b.push({ t: 'h3', text: g.section });
    b.push({
      t: 'table', size: 7.5, widths: [0.11, 0.43, 0.2, 0.12, 0.14], align: ['l', 'l', 'l', 'l', 'r'],
      head: ['Code', 'Description', 'Spec', 'Unit', 'Annual quantity'],
      rows: g.lines.map((l) => [l.code, l.description, l.spec ?? '', l.uom ?? '', l.annual_qty == null ? 'Not set' : formatIndian(l.annual_qty, 0)]),
    });
  }
  if (p.questions.length > 0) {
    b.push({ t: 'h2', text: `Questionnaire (${p.questions.length} questions, ${p.questions.filter((q) => q.is_knockout).length} knockouts)` });
    b.push({ t: 'p', text: 'Answer every question. A knockout question must be passed for your quote to be considered. Attach any certificate you refer to.', small: true, muted: true });
    b.push({
      t: 'table', size: 7.5, widths: [0.08, 0.6, 0.32], align: ['l', 'l', 'l'], head: ['Code', 'Question', 'Knockout rule'],
      rows: p.questions.map((q) => [q.code, q.text, q.is_knockout ? (q.rule ?? 'Knockout') : '']),
    });
  }
  return b;
}

export async function renderPack(p: PackInput, now: Date): Promise<Uint8Array> {
  const on = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return renderMemo(packBlocks(p, on), {
    title: noDashes(`RFx pack, ${p.title}`), subject: noDashes(p.title), header: noDashes(`${p.title}. ${p.buyer_org}`),
    footer: 'RFx pack. Simulated dispatch: this document was not sent by email.', now,
  });
}
