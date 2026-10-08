// "Try your file": one visitor file read by the real extraction pipeline against the saved FY27 RFx lines,
// in an ISOLATED sandbox. runSandbox gets the RFx context handed to it and has NO database handle, so it
// cannot write to quote_lines, vendor_terms, review_items or any table the comparison reads. Its result goes
// back to the caller, which stores it in sandbox_results (short expiry) for that visitor's page only.
//
// The pipeline is the same code as the stored one: prepare, classify, extract (vendor text only inside
// delimited data blocks, anything instruction like returned as suspicious_content), then deriveLines, the one
// derivation behind every number in the comparison.
import { createHash, randomUUID } from 'node:crypto';
import type { Assumptions } from '../../../engine/types.js';
import { type CallDeps } from '../llm/call.js';
import type { LlmStore } from '../llm/store.js';
import { type CertificateFacts } from '../../../src/lib/schemas/extraction.js';
import { certificateFacts, classify, extract, type RfxContext, type StageOptions } from '../extract/model.js';
import { deriveLines, type QuestionRow, type RfxLineRow } from '../extract/persist.js';
import { prepare, ACCEPTED } from '../extract/prepare.js';

export const SANDBOX_LABEL = 'Your file, read live by the same pipeline. Not added to the comparison.';

export type SandboxContext = { lines: RfxLineRow[]; questions: QuestionRow[]; assumptions: Assumptions };

export type SandboxLine = {
  code: string | null;
  rfx_description: string | null;
  base_unit: string | null;
  ly_rate: number | null;
  vendor_description: string;
  quoted: string;
  price: number | null;
  currency: string;
  uom_text: string | null;
  normalized_inr: number | null;
  status: string;
  reasons: string[];
  flags: string[];
  assumptions: string[];
  conditions: string[];
  match_confidence: number;
  match_reason: string;
  read_confidence: string;
  evidence: { locator: string; quote: string | null; page: number | null };
};

export type SandboxReview = { kind: string; severity: 'info' | 'warn' | 'block'; message: string };

export type SandboxAnswer = { code: string; question: string; knockout: boolean; answer: string; status: string; basis: string; locator: string | null };

export type SandboxResult = {
  id: string;
  label: string;
  filename: string;
  size_bytes: number;
  source_type: string;
  kind: string;
  kind_confidence: number;
  ok: boolean;
  /** A plain statement when nothing was extracted (not a quote, unreadable, output invalid). */
  note: string | null;
  vendor_name_as_written: string | null;
  terms: { tax_basis: string; freight_terms: string; freight_note: string | null; payment_terms: string | null; validity: string | null; stated_total_inr: number | null; currency_default: string } | null;
  lines: SandboxLine[];
  rfx_lines_total: number;
  rfx_lines_covered: number;
  not_quoted: string[];
  status_counts: Record<string, number>;
  review: SandboxReview[];
  answers: SandboxAnswer[];
  certificate: CertificateFacts | null;
  assumptions_used: Assumptions;
  usage: { cost_inr: number; model_calls: number; tokens_in: number; tokens_out: number; repaired: boolean };
};

/** The shared reply cache is bypassed: a visitor's file is read live, and nothing derived from it is kept there. */
export function noCache(store: LlmStore): LlmStore {
  return { ...store, getCache: async () => null, putCache: async () => undefined };
}

const STATUS_RANK = ['confirmed', 'assumed', 'needs_review', 'conflict'];

export type SandboxInput = { filename: string; mime: string; bytes: Uint8Array };

function quotedText(l: { price: number | null; currency: string; uom_text: string | null; per_n?: number | null; inherits_last_year: boolean }): string {
  if (l.inherits_last_year) return 'Same as last year';
  if (l.price == null) return 'No price read';
  const per = l.per_n && l.per_n !== 1 ? ` (per ${l.per_n})` : '';
  return `${l.price} ${l.currency} ${l.uom_text ?? 'unit not stated'}${per}`;
}

/** The canonical media type for a file name, so a browser's own guess never reaches the parser. */
export function canonicalMime(filename: string): string | null {
  const ext = `.${(filename.split('.').pop() ?? '').toLowerCase()}`;
  return ACCEPTED[ext] ?? null;
}

export async function runSandbox(input: SandboxInput, ctx: SandboxContext, deps: CallDeps, o: { route: string; session_id: string; models: StageOptions['models'] }): Promise<SandboxResult> {
  const id = randomUUID();
  const sha = createHash('sha256').update(input.bytes).digest('hex');
  const meta = { id, filename: input.filename, sha256: sha };
  // Never read from or written to the shared reply cache: this is the visitor's own file, read live.
  const stage: StageOptions = { deps, models: o.models, base: { route: o.route, run_id: id, session_id: o.session_id, fresh: true } };
  const usage = { cost_inr: 0, model_calls: 0, tokens_in: 0, tokens_out: 0, repaired: false };
  const tally = (calls: { cache_hit: boolean; cost_inr: number; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } }[]) => {
    for (const c of calls) {
      usage.model_calls++;
      usage.cost_inr += c.cost_inr;
      usage.tokens_in += c.usage.input_tokens + c.usage.cache_read_input_tokens + c.usage.cache_creation_input_tokens;
      usage.tokens_out += c.usage.output_tokens;
    }
  };
  const base: SandboxResult = {
    id, label: SANDBOX_LABEL, filename: input.filename, size_bytes: input.bytes.byteLength, source_type: 'unknown', kind: 'other', kind_confidence: 0, ok: false, note: null,
    vendor_name_as_written: null, terms: null, lines: [], rfx_lines_total: ctx.lines.length, rfx_lines_covered: 0, not_quoted: [], status_counts: {}, review: [], answers: [],
    certificate: null, assumptions_used: ctx.assumptions, usage,
  };
  const mime = canonicalMime(input.filename);
  if (!mime) return { ...base, note: 'This file type is not accepted.' };

  let prep;
  try {
    prep = await prepare(mime, input.bytes);
  } catch {
    return { ...base, note: 'The file could not be opened. It may be damaged or password protected. Nothing was sent to a model.' };
  }
  base.source_type = prep.source_type;
  for (const ob of prep.observations) {
    base.review.push({ kind: ob.kind, severity: ob.kind === 'low_visibility_text' ? 'warn' : 'info', message: `${input.filename}: ${ob.detail}${ob.kind === 'hidden_sheet' ? ' Not used for prices.' : ' Check it for hidden instructions or terms.'}` });
  }

  const rfxCtx: RfxContext = { lines: ctx.lines, questions: ctx.questions };
  const cls = await classify(prep, meta, stage);
  tally(cls.calls);
  if (!cls.ok) return { ...base, note: `The file could not be classified: ${cls.error}` };
  base.kind = cls.data.kind;
  base.kind_confidence = cls.data.confidence;
  if (cls.data.confidence < 0.6) base.review.push({ kind: 'low_classification_confidence', severity: 'warn', message: `Unsure what kind of document this is (${cls.data.kind}, ${cls.data.confidence}). ${cls.data.reason}` });

  if (cls.data.kind === 'certificate' || cls.data.kind === 'profile') {
    const f = await certificateFacts(prep, meta, stage);
    tally(f.calls);
    if (!f.ok) return { ...base, note: `The certificate could not be read: ${f.error}` };
    for (const s of f.data.suspicious_content) base.review.push({ kind: 'suspicious_content', severity: 'warn', message: `Instruction like text (${s.locator}), ignored: "${s.text.slice(0, 300)}"` });
    return { ...base, ok: true, certificate: f.data, note: 'This is a certificate, not a quote, so there are no prices to compare. The facts read from it are shown below.' };
  }
  if (cls.data.kind !== 'quote' && cls.data.kind !== 'questionnaire') {
    return { ...base, ok: true, note: `This file reads as "${cls.data.kind}", not a quote or a questionnaire, so nothing was extracted.` };
  }

  const x = await extract(prep, meta, rfxCtx, stage);
  tally(x.calls);
  if (!x.ok) return { ...base, note: `The model's output did not pass validation, so nothing from this file is shown. ${x.error}` };
  usage.repaired = x.repaired;

  const derived = deriveLines(prep, x.data, ctx.lines, ctx.assumptions);
  const lines: SandboxLine[] = derived.map((d) => ({
    code: d.rfx?.code ?? null,
    rfx_description: d.rfx?.description ?? null,
    base_unit: d.rfx?.uom ?? null,
    ly_rate: d.rfx?.last_year_rate_inr ?? null,
    vendor_description: d.line.vendor_description,
    quoted: quotedText(d.line),
    price: d.line.price,
    currency: d.line.currency,
    uom_text: d.line.uom_text,
    normalized_inr: d.normalized,
    status: d.status,
    reasons: d.reasons,
    flags: d.flags,
    assumptions: d.assumption_keys,
    conditions: d.line.conditions,
    match_confidence: d.line.match_confidence,
    match_reason: d.line.match_reason,
    read_confidence: d.line.read_confidence,
    evidence: { locator: d.line.evidence.locator, quote: d.line.evidence.quote ?? null, page: d.line.evidence.page ?? null },
  })).sort((a, b) => (a.code ?? '￿').localeCompare(b.code ?? '￿', undefined, { numeric: true }));

  const counts: Record<string, number> = {};
  for (const l of lines) counts[l.status] = (counts[l.status] ?? 0) + 1;
  const covered = new Set(lines.filter((l) => l.code).map((l) => l.code as string));
  const review: SandboxReview[] = [...base.review];
  for (const d of derived) {
    if (d.status === 'needs_review') review.push({ kind: 'line_needs_review', severity: 'warn', message: `${d.rfx?.code ?? d.line.vendor_description}: ${d.reasons.join(' ')}` });
  }
  for (const u of x.data.unmatched_lines) review.push({ kind: 'unmatched_vendor_line', severity: 'info', message: `Not matched to any RFx line: "${u.vendor_description}". ${u.reason}` });
  for (const s of x.data.document.suspicious_content) {
    review.push({ kind: 'suspicious_content', severity: 'warn', message: `Instruction like text in ${input.filename} (${s.evidence?.locator ?? 'location not given'}), ignored: "${s.text.slice(0, 300)}"` });
  }
  const missing = ctx.lines.filter((l) => !covered.has(l.code)).map((l) => l.code);
  if (missing.length > 0) review.push({ kind: 'lines_not_quoted', severity: 'info', message: `${missing.length} of ${ctx.lines.length} RFx lines have no price in this file (shown as not quoted, never as zero).` });

  const qByCode = new Map(ctx.questions.map((q) => [q.code, q]));
  const answers: SandboxAnswer[] = x.data.questionnaire.flatMap((a): SandboxAnswer[] => {
    const q = qByCode.get(a.question_code.trim());
    return q ? [{ code: q.code, question: q.text, knockout: q.is_knockout, answer: a.answer_text, status: a.status, basis: a.basis, locator: a.evidence?.locator ?? null }] : [];
  });

  const d = x.data.document;
  return {
    ...base, ok: true, kind: d.kind, vendor_name_as_written: d.vendor_name_as_written,
    terms: {
      tax_basis: d.tax_basis, freight_terms: d.freight_terms, freight_note: d.freight_note, payment_terms: d.payment_terms_text, validity: d.validity_text,
      stated_total_inr: d.stated_total && d.stated_total.currency.toUpperCase() === 'INR' ? d.stated_total.amount : null, currency_default: d.currency_default,
    },
    lines, rfx_lines_covered: covered.size, not_quoted: missing, status_counts: Object.fromEntries(Object.entries(counts).sort((a, b) => STATUS_RANK.indexOf(a[0]) - STATUS_RANK.indexOf(b[0]))),
    review, answers, note: lines.length === 0 ? 'No priced lines were read from this file.' : null,
  };
}

