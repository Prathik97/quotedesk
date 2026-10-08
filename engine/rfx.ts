// The structured RFx a buyer drafts with the co-pilot, and the pure code that edits and checks it.
// The model changes an RFx only through the tool operations below. Nothing here does I/O or calls a model.
import { describeRule, type PassRule } from './questionnaire';

export type AnswerType = 'bool' | 'number' | 'date' | 'text' | 'choice';

export type DraftLine = {
  code: string;
  section: string;
  description: string;
  spec: string | null;
  /** Base unit as the buyer wrote it, such as "piece" or "kg". Null until set. */
  uom: string | null;
  /** How many base units one pack holds, for units like "box". */
  pack_size: number | null;
  annual_qty: number | null;
};

export type DraftQuestion = {
  code: string;
  text: string;
  answer_type: AnswerType;
  is_knockout: boolean;
  pass_rule: PassRule | null;
};

export type DraftTerms = {
  title: string | null;
  scope_summary: string | null;
  delivery_location: string | null;
  payment_terms_days: number | null;
  validity_days: number | null;
  gst_basis: 'excl_gst' | 'incl_gst' | null;
  currency: string | null;
  /** Days after issue. */
  clarifications_by_day: number | null;
  quotes_due_day: number | null;
  award_by_day: number | null;
};

export type DraftRfx = { terms: DraftTerms; lines: DraftLine[]; questions: DraftQuestion[] };

export const MAX_LINES = 60;
export const MAX_QUESTIONS = 30;

export function emptyRfx(): DraftRfx {
  return {
    terms: {
      title: null, scope_summary: null, delivery_location: null, payment_terms_days: null, validity_days: null, gst_basis: null,
      currency: 'INR', clarifications_by_day: null, quotes_due_day: null, award_by_day: null,
    },
    lines: [],
    questions: [],
  };
}

// ---------------------------------------------------------------- units

/** Units a vendor cannot misread. */
const CLEAR_UNITS = new Set([
  'piece', 'pieces', 'pc', 'pcs', 'nos', 'no', 'each', 'unit', 'units', 'kg', 'kgs', 'kilogram', 'tonne', 'tonnes', 'ton', 'mt', 'sq m', 'sqm', 'sq.m', 'm2', 'sq ft', 'sqft',
  'm', 'metre', 'meter', 'roll', 'rolls', 'set', 'sets', 'plate', 'plates', 'pallet', 'pallets', 'litre', 'liter', 'l', 'ream', 'reams', 'sheet', 'sheets', 'pair', 'pairs',
]);

/** Units whose size depends on the vendor unless a pack size is given. */
const PACK_UNITS = new Set(['box', 'boxes', 'carton', 'cartons', 'pack', 'packs', 'packet', 'packets', 'bundle', 'bundles', 'case', 'cases', 'bag', 'bags', 'lot', 'lots', 'bale', 'bales', 'drum', 'drums']);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
export const isPackUnit = (uom: string): boolean => PACK_UNITS.has(norm(uom));
export const isClearUnit = (uom: string): boolean => CLEAR_UNITS.has(norm(uom));

/** The spec or unit text itself gives the pack size, for example "box of 100 pcs". */
function packSizeStated(l: DraftLine): boolean {
  if (l.pack_size != null && l.pack_size > 0) return true;
  const text = `${l.uom ?? ''} ${l.spec ?? ''} ${l.description}`;
  return /\b(box|pack|packet|bundle|case|carton|bag|bale|drum)\s*(of|=|:)\s*\d/i.test(text) || /\bpack size\s*[:=]?\s*\d/i.test(text) || /\b\d[\d,]*\s*(pcs|pieces|nos|units)\s*(per|\/)\s*(box|pack|packet|bundle|case|carton|bag)\b/i.test(text);
}

// ---------------------------------------------------------------- validation

export type Severity = 'error' | 'warning';
export type Finding = {
  severity: Severity;
  code:
    | 'no_lines' | 'missing_description' | 'missing_unit' | 'missing_quantity' | 'ambiguous_unit' | 'unusual_unit' | 'duplicate_line'
    | 'question_no_pass_rule' | 'knockout_no_pass_rule' | 'no_questions' | 'no_knockout' | 'duplicate_question'
    | 'missing_payment_terms' | 'missing_validity' | 'missing_delivery' | 'missing_gst_basis' | 'missing_timeline' | 'missing_title' | 'missing_scope' | 'timeline_order';
  message: string;
  line_code?: string;
  question_code?: string;
  field?: string;
};

export type Validation = { findings: Finding[]; errors: number; warnings: number; can_issue: boolean };

const squash = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Deterministic checks on a draft RFx. Errors block Issue; warnings are listed and allowed. */
export function validateRfx(rfx: DraftRfx): Validation {
  const f: Finding[] = [];
  const t = rfx.terms;
  if (rfx.lines.length === 0) f.push({ severity: 'error', code: 'no_lines', message: 'The RFx has no line items yet.' });

  const seen = new Map<string, string>();
  for (const l of rfx.lines) {
    if (!l.description.trim()) f.push({ severity: 'error', code: 'missing_description', line_code: l.code, message: `${l.code} has no description.` });
    if (l.uom == null || !l.uom.trim()) {
      f.push({ severity: 'error', code: 'missing_unit', line_code: l.code, field: 'uom', message: `${l.code} has no base unit. Say what vendors should price per (piece, kg, roll and so on).` });
    } else if (isPackUnit(l.uom) && !packSizeStated(l)) {
      f.push({ severity: 'error', code: 'ambiguous_unit', line_code: l.code, field: 'uom', message: `${l.code} is priced per "${l.uom}" with no pack size. Vendors will mean different things by it. Give the pack size or use a base unit such as piece.` });
    } else if (!isPackUnit(l.uom) && !isClearUnit(l.uom)) {
      f.push({ severity: 'warning', code: 'unusual_unit', line_code: l.code, field: 'uom', message: `${l.code} uses the unit "${l.uom}", which is not a standard base unit. Check that vendors will read it the same way.` });
    }
    if (l.annual_qty == null || !Number.isFinite(l.annual_qty) || l.annual_qty <= 0) {
      f.push({ severity: 'error', code: 'missing_quantity', line_code: l.code, field: 'annual_qty', message: `${l.code} has no annual quantity. Vendors cannot quote a volume price without it.` });
    }
    const key = `${squash(l.description)}|${squash(l.spec)}`;
    if (l.description.trim()) {
      const first = seen.get(key);
      if (first) f.push({ severity: 'error', code: 'duplicate_line', line_code: l.code, message: `${l.code} repeats ${first} (same description and spec). Remove one or make the spec differ.` });
      else seen.set(key, l.code);
    }
  }

  const qSeen = new Map<string, string>();
  for (const q of rfx.questions) {
    if (!q.pass_rule) {
      if (q.is_knockout) f.push({ severity: 'error', code: 'knockout_no_pass_rule', question_code: q.code, message: `${q.code} is a knockout but has no pass rule, so no vendor can be cleared or failed on it.` });
      else f.push({ severity: 'warning', code: 'question_no_pass_rule', question_code: q.code, message: `${q.code} has no pass rule. Answers will be shown but not scored.` });
    }
    const k = squash(q.text);
    const first = qSeen.get(k);
    if (first) f.push({ severity: 'warning', code: 'duplicate_question', question_code: q.code, message: `${q.code} repeats ${first}.` });
    else qSeen.set(k, q.code);
  }
  if (rfx.questions.length === 0) f.push({ severity: 'warning', code: 'no_questions', message: 'There is no questionnaire. Vendors will not be asked to confirm quality or capacity.' });
  else if (!rfx.questions.some((q) => q.is_knockout)) f.push({ severity: 'warning', code: 'no_knockout', message: 'No question is a knockout, so every vendor will count as cleared.' });

  if (t.payment_terms_days == null) f.push({ severity: 'error', code: 'missing_payment_terms', field: 'payment_terms_days', message: 'Payment terms are missing. Set the payment days you want vendors to quote against.' });
  if (t.validity_days == null) f.push({ severity: 'error', code: 'missing_validity', field: 'validity_days', message: 'Quote validity is missing. Set how many days a quote must stay open.' });
  if (!t.delivery_location?.trim()) f.push({ severity: 'warning', code: 'missing_delivery', field: 'delivery_location', message: 'No delivery location is set.' });
  if (t.gst_basis == null) f.push({ severity: 'warning', code: 'missing_gst_basis', field: 'gst_basis', message: 'The GST basis is not set. State whether prices are excluding or including GST.' });
  if (!t.title?.trim()) f.push({ severity: 'warning', code: 'missing_title', field: 'title', message: 'The RFx has no title.' });
  if (!t.scope_summary?.trim()) f.push({ severity: 'warning', code: 'missing_scope', field: 'scope_summary', message: 'There is no scope summary.' });
  if (t.quotes_due_day == null) f.push({ severity: 'warning', code: 'missing_timeline', field: 'quotes_due_day', message: 'No quote due day is set in the timeline.' });
  const days = [t.clarifications_by_day, t.quotes_due_day, t.award_by_day].filter((x): x is number => x != null);
  if (days.some((d, i) => i > 0 && d < (days[i - 1] ?? 0))) f.push({ severity: 'warning', code: 'timeline_order', message: 'The timeline is out of order: clarifications, then quotes due, then award.' });

  const errors = f.filter((x) => x.severity === 'error').length;
  return { findings: f, errors, warnings: f.length - errors, can_issue: errors === 0 };
}

// ---------------------------------------------------------------- operations (the co-pilot tools)

export type LineInput = {
  section: string;
  description: string;
  spec?: string | null;
  uom?: string | null;
  pack_size?: number | null;
  annual_qty?: number | null;
};

export type LinePatch = Partial<Omit<DraftLine, 'code'>>;

export type OpResult<T = Record<string, unknown>> = { rfx: DraftRfx; result: T; error?: string };

function prefixOf(section: string): string {
  const letters = section.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (letters.slice(0, 3) || 'LIN').padEnd(3, 'X');
}

function nextLineCode(lines: DraftLine[], section: string): string {
  const p = prefixOf(section);
  let n = lines.filter((l) => l.code.startsWith(`${p}-`)).length + 1;
  while (lines.some((l) => l.code === `${p}-${String(n).padStart(2, '0')}`)) n++;
  return `${p}-${String(n).padStart(2, '0')}`;
}

const clean = (s: string | null | undefined): string | null => (s == null ? null : s.trim() || null);

export function addLines(rfx: DraftRfx, items: LineInput[]): OpResult<{ added: { code: string; section: string; description: string }[]; skipped: string[]; line_count: number }> {
  const lines = [...rfx.lines];
  const added: { code: string; section: string; description: string }[] = [];
  const skipped: string[] = [];
  for (const it of items) {
    if (lines.length >= MAX_LINES) {
      skipped.push(`${it.description.slice(0, 60)}: the RFx is limited to ${MAX_LINES} lines`);
      continue;
    }
    const line: DraftLine = {
      code: nextLineCode(lines, it.section),
      section: it.section.trim() || 'General',
      description: it.description.trim(),
      spec: clean(it.spec),
      uom: clean(it.uom),
      pack_size: it.pack_size != null && it.pack_size > 0 ? it.pack_size : null,
      annual_qty: it.annual_qty != null && it.annual_qty > 0 ? it.annual_qty : null,
    };
    lines.push(line);
    added.push({ code: line.code, section: line.section, description: line.description });
  }
  return { rfx: { ...rfx, lines }, result: { added, skipped, line_count: lines.length } };
}

export function updateLine(rfx: DraftRfx, code: string, patch: LinePatch): OpResult {
  const i = rfx.lines.findIndex((l) => l.code === code);
  if (i < 0) return { rfx, result: {}, error: `No line with code ${code}. Codes are ${rfx.lines.map((l) => l.code).join(', ') || 'none yet'}.` };
  const cur = rfx.lines[i] as DraftLine;
  const next: DraftLine = {
    ...cur,
    ...(patch.section !== undefined ? { section: patch.section.trim() || cur.section } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    ...(patch.spec !== undefined ? { spec: clean(patch.spec) } : {}),
    ...(patch.uom !== undefined ? { uom: clean(patch.uom) } : {}),
    ...(patch.pack_size !== undefined ? { pack_size: patch.pack_size != null && patch.pack_size > 0 ? patch.pack_size : null } : {}),
    ...(patch.annual_qty !== undefined ? { annual_qty: patch.annual_qty != null && patch.annual_qty > 0 ? patch.annual_qty : null } : {}),
  };
  const lines = rfx.lines.map((l, k) => (k === i ? next : l));
  return { rfx: { ...rfx, lines }, result: { updated: code, line: next } };
}

export function removeLine(rfx: DraftRfx, code: string): OpResult {
  if (!rfx.lines.some((l) => l.code === code)) return { rfx, result: {}, error: `No line with code ${code}.` };
  return { rfx: { ...rfx, lines: rfx.lines.filter((l) => l.code !== code) }, result: { removed: code, line_count: rfx.lines.length - 1 } };
}

export type TermsPatch = Partial<DraftTerms>;

export function setTerms(rfx: DraftRfx, patch: TermsPatch): OpResult {
  const t: DraftTerms = { ...rfx.terms };
  const changed: string[] = [];
  for (const k of Object.keys(patch) as (keyof DraftTerms)[]) {
    const v = patch[k];
    if (v === undefined) continue;
    const val = typeof v === 'string' ? v.trim() || null : v;
    (t as Record<string, unknown>)[k] = val;
    changed.push(k);
  }
  return { rfx: { ...rfx, terms: t }, result: { changed, terms: t } };
}

export type QuestionInput = { text: string; answer_type?: AnswerType; is_knockout?: boolean; pass_rule?: PassRule | null };

export function addQuestions(rfx: DraftRfx, items: QuestionInput[]): OpResult<{ added: { code: string; text: string }[]; skipped: string[]; question_count: number }> {
  const questions = [...rfx.questions];
  const added: { code: string; text: string }[] = [];
  const skipped: string[] = [];
  for (const it of items) {
    if (questions.length >= MAX_QUESTIONS) {
      skipped.push(`${it.text.slice(0, 60)}: the questionnaire is limited to ${MAX_QUESTIONS} questions`);
      continue;
    }
    let n = questions.length + 1;
    while (questions.some((q) => q.code === `Q${n}`)) n++;
    const q: DraftQuestion = { code: `Q${n}`, text: it.text.trim(), answer_type: it.answer_type ?? 'text', is_knockout: !!it.is_knockout, pass_rule: it.pass_rule ?? null };
    questions.push(q);
    added.push({ code: q.code, text: q.text });
  }
  return { rfx: { ...rfx, questions }, result: { added, skipped, question_count: questions.length } };
}

export function setKnockout(rfx: DraftRfx, code: string, is_knockout: boolean, pass_rule?: PassRule | null): OpResult {
  const i = rfx.questions.findIndex((q) => q.code === code);
  if (i < 0) return { rfx, result: {}, error: `No question with code ${code}. Codes are ${rfx.questions.map((q) => q.code).join(', ') || 'none yet'}.` };
  const cur = rfx.questions[i] as DraftQuestion;
  const next: DraftQuestion = { ...cur, is_knockout, ...(pass_rule !== undefined ? { pass_rule } : {}) };
  return { rfx: { ...rfx, questions: rfx.questions.map((q, k) => (k === i ? next : q)) }, result: { updated: code, is_knockout, pass_rule: next.pass_rule ? describeRule(next.pass_rule) : null } };
}

/** A line that can be shown in a table: the unit with its pack size, such as "box (100 per box)". */
export function unitLabel(l: Pick<DraftLine, 'uom' | 'pack_size'>): string {
  if (!l.uom) return 'Not set';
  return l.pack_size ? `${l.uom} (${l.pack_size} per ${l.uom.replace(/es$|s$/i, '')})` : l.uom;
}

/** Lines grouped by section in the order sections first appear. */
export function bySection(lines: DraftLine[]): { section: string; lines: DraftLine[] }[] {
  const out: { section: string; lines: DraftLine[] }[] = [];
  for (const l of lines) {
    const g = out.find((x) => x.section === l.section);
    if (g) g.lines.push(l);
    else out.push({ section: l.section, lines: [l] });
  }
  return out;
}
