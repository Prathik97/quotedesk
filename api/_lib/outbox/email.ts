// The covering email for an issued RFx. One draft per issue, written once and personalised with the
// vendor's name in code. The model (MODEL_FAST) sees only a summary of the buyer's own RFx. A template
// is used when the buyer asks for it, when a cap or the model fails, or when the model's draft fails
// its checks. The buyer can edit the draft before issuing.
import { createHash } from 'node:crypto';
import { bySection, type DraftRfx } from '../../../engine/rfx.js';
import { checkNumbers } from '../analyst/numcheck.js';
import { plain } from '../analyst/agent.js';
import { loadPrompt } from '../extract/model.js';
import { log } from '../http.js';
import { BudgetExceededError, callModel, type CallDeps } from '../llm/call.js';
import type { LlmRequest } from '../llm/client.js';
import { estimateTextTokens } from '../llm/tokens.js';
import { GST_TEXT } from './pack.js';

export const EMAIL_PROMPT = 'rfx-email.v1';
export const EMAIL_MAX_TOKENS = 700;
export const VENDOR_PLACEHOLDER = '{{vendor_name}}';

export type EmailDraft = { subject: string; body: string };

/** The only thing the model sees: the buyer's own RFx, summarised. */
export function emailSummary(rfx: DraftRfx, buyerOrg: string) {
  const t = rfx.terms;
  return {
    buyer_org: buyerOrg,
    title: t.title,
    scope_summary: t.scope_summary,
    line_item_count: rfx.lines.length,
    sections: bySection(rfx.lines).map((g) => g.section),
    question_count: rfx.questions.length,
    knockout_count: rfx.questions.filter((q) => q.is_knockout).length,
    payment_terms_days: t.payment_terms_days,
    quote_validity_days: t.validity_days,
    delivery_location: t.delivery_location,
    price_basis: t.gst_basis ? GST_TEXT[t.gst_basis] : null,
    currency: t.currency,
    quotes_due_day_after_issue: t.quotes_due_day,
  };
}

/** Fixed text from the same summary. Used as the fallback and when the buyer asks for it. */
export function templateEmail(rfx: DraftRfx, buyerOrg: string): EmailDraft {
  const s = emailSummary(rfx, buyerOrg);
  const terms = [
    s.payment_terms_days != null ? `payment terms of ${s.payment_terms_days} days` : null,
    s.quote_validity_days != null ? `quote validity of ${s.quote_validity_days} days` : null,
    s.delivery_location ? `delivery to ${s.delivery_location}` : null,
    s.price_basis ? `${s.price_basis.toLowerCase()} in ${s.currency ?? 'INR'}` : null,
  ].filter((x): x is string => !!x);
  const body = [
    `Dear ${VENDOR_PLACEHOLDER} team,`,
    `${buyerOrg} invites you to quote for ${s.title ?? 'the attached request for quotation'}.${s.scope_summary ? ` ${s.scope_summary}` : ''}`,
    `The attached RFx pack lists ${s.line_item_count} line ${s.line_item_count === 1 ? 'item' : 'items'}${s.sections.length ? ` across ${s.sections.join(', ')}` : ''}${s.question_count > 0 ? ` and a questionnaire of ${s.question_count} ${s.question_count === 1 ? 'question' : 'questions'}${s.knockout_count ? `, of which ${s.knockout_count} must be passed for a quote to be considered` : ''}` : ''}.`,
    terms.length ? `We ask for ${terms.join(', ')}.${s.quotes_due_day_after_issue != null ? ` Please send your quote by day ${s.quotes_due_day_after_issue} after this email.` : ''}` : '',
    'You may reply in any format that suits you: a spreadsheet, a PDF, a document, a photo of a rate card or plain email text. Please answer the questionnaire in the same reply and attach any certificates.',
    `Thank you,\nProcurement\n${buyerOrg}`,
  ].filter(Boolean);
  return { subject: `Request for quotation: ${s.title ?? 'RFx'}`.slice(0, 120), body: plain(body.join('\n\n')) };
}

export function personalise(text: string, vendorName: string): string {
  return text.split(VENDOR_PLACEHOLDER).join(vendorName);
}

export type EmailCheck = { ok: boolean; reasons: string[] };

/** The draft must be well formed, plain, and every figure must come from the RFx summary. */
export function checkEmail(d: EmailDraft, summaryJson: string): EmailCheck {
  const reasons: string[] = [];
  if (!d.subject.trim() || d.subject.length > 160) reasons.push('The subject is empty or too long.');
  const words = d.body.trim().split(/\s+/).filter(Boolean).length;
  if (words < 40 || words > 260) reasons.push(`The body has ${words} words, outside 40 to 260.`);
  if (!d.body.includes(VENDOR_PLACEHOLDER)) reasons.push('The body does not address the vendor.');
  if (/[–—]/.test(`${d.subject} ${d.body}`)) reasons.push('It contains an em dash or en dash.');
  if (/<[a-z/][^>]*>/i.test(d.body)) reasons.push('It contains markup.');
  const nums = checkNumbers(`${d.subject}\n${d.body}`, [summaryJson]);
  if (!nums.ok) reasons.push(`Some figures were not in the RFx: ${nums.unmatched.map((u) => u.text).join(', ')}.`);
  return { ok: reasons.length === 0, reasons };
}

export function parseEmailJson(text: string): EmailDraft | null {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(t.slice(start, end + 1)) as { subject?: unknown; body?: unknown };
    if (typeof j.subject !== 'string' || typeof j.body !== 'string') return null;
    return { subject: plain(j.subject.trim()), body: plain(j.body.trim()) };
  } catch {
    return null;
  }
}

export type EmailResult = { source: 'model' | 'template'; draft: EmailDraft; label: string; cost_inr: number; fallback: string | null; model: string | null };

export const TEMPLATE_EMAIL_LABEL = 'Template email: written by fixed rules from your RFx. No model was used.';

export function templateResult(rfx: DraftRfx, buyerOrg: string, fallback: string | null = null): EmailResult {
  return { source: 'template', draft: templateEmail(rfx, buyerOrg), label: fallback ? `${TEMPLATE_EMAIL_LABEL} ${fallback}` : TEMPLATE_EMAIL_LABEL, cost_inr: 0, fallback, model: null };
}

export type EmailDeps = { call: CallDeps; model: string; budgetSession: string; route: string };

/** One model call. Throws the budget errors from callModel; resolveEmail turns every failure into the template. */
export async function modelEmail(rfx: DraftRfx, buyerOrg: string, deps: EmailDeps): Promise<EmailResult> {
  const prompt = loadPrompt(EMAIL_PROMPT);
  const summaryJson = JSON.stringify(emailSummary(rfx, buyerOrg));
  const req: LlmRequest = {
    model: deps.model,
    max_tokens: EMAIL_MAX_TOKENS,
    system: [{ type: 'text', text: prompt.text }],
    messages: [{ role: 'user', content: `<rfx_summary>\n${summaryJson}\n</rfx_summary>\nWrite the email now. JSON only.` }],
  };
  const res = await callModel(
    req,
    {
      stage: 'email', route: deps.route, prompt_version: prompt.version, document_sha256: createHash('sha256').update(summaryJson).digest('hex'), context_hash: '-',
      document_id: null, run_id: null, session_id: deps.budgetSession, fresh: false, estimated_input_tokens: estimateTextTokens(prompt.text + summaryJson) + 80,
    },
    deps.call,
  );
  const draft = res.stop_reason === 'max_tokens' ? null : parseEmailJson(res.text);
  if (!draft) return { ...templateResult(rfx, buyerOrg, 'The model reply could not be used.'), cost_inr: res.cost_inr };
  const check = checkEmail(draft, summaryJson);
  if (!check.ok) {
    log('warn', 'rfx_email_check_failed', { reasons: check.reasons.map((r) => r.slice(0, 100)) });
    return { ...templateResult(rfx, buyerOrg, `The model's draft failed a check (${check.reasons[0]?.replace(/\.$/, '')}).`), cost_inr: res.cost_inr };
  }
  return {
    source: 'model', draft, cost_inr: res.cost_inr, fallback: null, model: deps.model,
    label: `Drafted by ${deps.model}${res.cache_hit ? ' (stored reply for identical RFx)' : ''} from your RFx only. Edit it before you issue.`,
  };
}

export type EmailGate = () => Promise<{ ok: true } | { ok: false; message: string }>;

/** The one place that chooses model or template. Any refusal or failure gives the labelled template. */
export async function resolveEmail(rfx: DraftRfx, buyerOrg: string, o: { mode: 'model' | 'template'; admit: EmailGate; deps: EmailDeps }): Promise<EmailResult> {
  if (o.mode === 'template') return templateResult(rfx, buyerOrg);
  const gate = await o.admit();
  if (!gate.ok) return templateResult(rfx, buyerOrg, `Live model calls are paused (${gate.message.replace(/\.$/, '')}).`);
  try {
    return await modelEmail(rfx, buyerOrg, o.deps);
  } catch (e) {
    const cap = e instanceof BudgetExceededError;
    log(cap ? 'warn' : 'error', 'rfx_email_failed', { cap, message: (e as Error).message.slice(0, 200) });
    return templateResult(rfx, buyerOrg, cap ? 'The spend cap would be passed by a model call.' : 'The model call failed.');
  }
}
