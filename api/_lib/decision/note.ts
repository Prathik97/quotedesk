// FR-8.3: the draft approval note. One model call per pack, given only structured scenario data
// (never vendor text, never the buyer's free text), then the same server side number check the
// analyst uses. If the check fails the caller shows a warning and offers regenerate or the template.
// If a cap is hit or the call fails, or the buyer asks for it, a deterministic template is used and
// labelled as such. The template is also what check:function and development use: no model call.
import { createHash } from 'node:crypto';
import { checkNumbers } from '../analyst/numcheck.js';
import { plain } from '../analyst/agent.js';
import { log } from '../http.js';
import { BudgetExceededError, callModel, type CallDeps } from '../llm/call.js';
import type { LlmRequest } from '../llm/client.js';
import { estimateTextTokens } from '../llm/tokens.js';
import { loadPrompt } from '../extract/model.js';
import { STRATEGY_NAME, rsCompact, type PackData } from './pack.js';

export const NOTE_MAX_WORDS = 149;
export const NOTE_MAX_TOKENS = 600;
export const NOTE_PROMPT = 'note.v2';

/** Fixed phrases for open item kinds, so no vendor derived message ever reaches the model. */
const KIND_PHRASE: Record<string, string> = {
  freight_amount_unknown: 'freight is extra with no amount stated',
  freight_terms_unknown: 'freight terms are not stated',
  total_mismatch: 'the stated total does not match the sum of its lines',
  knockout_failed: 'a vendor in the award failed a knockout question',
  knockout_pending: 'a knockout question is undecided',
  certificate_expired: 'a certificate has expired',
  attachment_name_mismatch: 'a certificate legal name differs from the quote letterhead',
  suspicious_content: 'a vendor document contained instruction like text that was ignored',
  low_visibility_text: 'a vendor document contained near invisible text that was ignored',
  hidden_instructions: 'a vendor document contained near invisible text and instruction like text, both ignored',
  line_needs_review: 'some prices need a person to check them',
  conflict: 'some prices are in conflict',
  extraction_failed: 'a document could not be read',
  assumed_cells: 'assumed prices carry part of the award',
  coverage_gaps: 'some lines are not covered by any eligible vendor',
};
const phrase = (kind: string): string => KIND_PHRASE[kind] ?? 'an open review item';

export type NoteInput = ReturnType<typeof noteInput>;

/** The only thing the model sees. Display strings are included so it can copy a figure rather than compute one. */
export function noteInput(p: PackData) {
  const r = p.result;
  const t = r.totals;
  const left = r.vendors_considered.filter((v) => !v.eligible);
  const must = [
    ...p.readiness.blockers.map((b) => ({ vendor: b.vendor_key, issue: phrase(b.kind), blocks_po: true })),
    ...p.readiness.open_items.map((o) => ({ vendor: o.vendor_key, issue: phrase(o.kind), blocks_po: false })),
  ];
  const lost = p.sensitivity.top_vendor_lost;
  const lowFx = p.sensitivity.fx.find((x) => x.usd_inr === 85);
  const highFx = p.sensitivity.fx.find((x) => x.usd_inr === 105);
  return {
    rfx: p.rfx.title,
    scenario: {
      strategy: STRATEGY_NAME[p.scenario.strategy],
      eligible_vendors: p.scenario.filters.eligibility === 'cleared' ? 'Cleared vendors only (passed all three knockouts)' : 'Cleared vendors and vendors with undecided knockouts',
      prices_used: p.scenario.filters.price_basis === 'confirmed' ? 'Confirmed only' : 'Confirmed and Assumed',
      conditional_discounts_applied: p.scenario.filters.apply_discounts,
      vendors_left_out: left.map((v) => ({ vendor: v.vendor_key, questionnaire: v.questionnaire })),
    },
    headline: {
      lines_awarded: t.lines_awarded,
      lines_total: t.lines_total,
      vendor_count: r.concentration.vendor_count,
      goods_total_inr: Math.round(t.goods_total_inr),
      goods_total_display: rsCompact(t.goods_total_inr),
      landed_complete: t.landed_complete,
      last_year_value_of_same_lines_display: rsCompact(t.ly_value_of_awarded_lines_inr),
      change_vs_last_year_display: rsCompact(Math.abs(t.savings_vs_ly_inr)),
      change_vs_last_year_direction: t.savings_vs_ly_inr >= 0 ? 'saving' : 'extra cost',
      change_vs_last_year_pct: t.savings_vs_ly_pct == null ? null : Math.round(Math.abs(t.savings_vs_ly_pct) * 10) / 10,
      lines_not_covered: r.coverage_gaps.length,
    },
    vendors_awarded: r.by_vendor.map((v) => ({ vendor: v.vendor_key, name: v.vendor_name, lines: v.lines, share_pct: Math.round(v.share * 1000) / 10, value_display: rsCompact(v.goods_value_inr), questionnaire: v.questionnaire })),
    readiness: { label: p.readiness.label, blockers: p.readiness.blockers.length, open_items: p.readiness.open_items.length },
    reliance: {
      confirmed_cells: r.reliance.confirmed,
      assumed_cells: r.reliance.assumed,
      assumed_value_display: rsCompact(r.reliance.assumed_value_inr),
      needs_review_cells: r.reliance.needs_review + r.reliance.conflict,
    },
    sensitivity: {
      usd_rates: [lowFx, highFx].flatMap((x) => (x?.without_discount.ok ? [{ usd_rate: x.usd_inr, goods_total_display: rsCompact(x.without_discount.goods_inr) }] : [])),
      top_vendor_lost: lost && lost.cell.ok ? { vendor: lost.vendor_key, goods_total_display: rsCompact(lost.cell.goods_inr), extra_cost_display: lost.goods_delta_inr == null ? null : rsCompact(Math.abs(lost.goods_delta_inr)), like_for_like: lost.like_for_like } : null,
    },
    must_resolve_before_po: must.slice(0, 8),
  };
}

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------- template

/** A fixed shape paragraph from the same data. Used when asked for, and when the model cannot be used. */
export function templateNote(p: PackData): string {
  const r = p.result;
  const t = r.totals;
  const vendors = r.by_vendor.slice(0, 3).map((v) => `${v.vendor_key} ${(v.share * 100).toFixed(1)} percent`).join(', ');
  const more = r.by_vendor.length > 3 ? ` and ${r.by_vendor.length - 3} more` : '';
  const change = `${rsCompact(Math.abs(t.savings_vs_ly_inr))}${t.savings_vs_ly_pct == null ? '' : ` (${Math.abs(t.savings_vs_ly_pct).toFixed(1)} percent)`}`;
  const lines = [
    `We recommend a ${STRATEGY_NAME[p.scenario.strategy].toLowerCase()} award of ${t.lines_awarded} of ${t.lines_total} lines to ${r.concentration.vendor_count} ${r.concentration.vendor_count === 1 ? 'vendor' : 'vendors'}, at ${rsCompact(t.goods_total_inr)} excluding GST${t.landed_complete ? '' : ', before freight that is still unknown, so this total is a floor'}.`,
    t.savings_vs_ly_inr >= 0 ? `That is ${change} below last year on the same lines.` : `That is ${change} above last year on the same lines.`,
    `Shares: ${vendors}${more}.`,
    `Readiness: ${p.readiness.label}.`,
  ];
  if (r.reliance.assumed > 0) lines.push(`${r.reliance.assumed} awarded ${r.reliance.assumed === 1 ? 'price is' : 'prices are'} Assumed, worth ${rsCompact(r.reliance.assumed_value_inr)}.`);
  const items = [...p.readiness.blockers.map((b) => `${b.vendor_key}: ${phrase(b.kind)}`), ...p.readiness.open_items.map((o) => `${o.vendor_key ? `${o.vendor_key}: ` : ''}${phrase(o.kind)}`)];
  let text = lines.join(' ');
  // Keep it under the word limit by naming fewer open items, never by dropping the readiness line.
  for (let n = Math.min(4, items.length); n >= 0; n--) {
    const tail = n > 0 ? ` Before a PO we must resolve: ${items.slice(0, n).join('; ')}.` : ' Nothing is open before a PO.';
    const more2 = items.length > n && n > 0 ? ` The memo lists ${items.length - n} more.` : '';
    const candidate = `${text}${tail}${more2}`;
    if (countWords(candidate) <= NOTE_MAX_WORDS || n === 0) {
      text = candidate;
      break;
    }
  }
  return plain(text);
}

// ---------------------------------------------------------------- check

export type NoteCheck = { ok: boolean; words: number; reasons: string[]; unmatched: string[]; checked: number };

/** Plain text house style, under 150 words, and every figure found in the data the model was given. */
export function checkNote(text: string, dataJson: string): NoteCheck {
  const reasons: string[] = [];
  const words = countWords(text);
  if (words > NOTE_MAX_WORDS) reasons.push(`It has ${words} words. The limit is 149.`);
  if (words === 0) reasons.push('It is empty.');
  if (/[\u2013\u2014]/.test(text)) reasons.push('It contains an em dash or en dash.');
  if (/[#*_`>|]/.test(text)) reasons.push('It contains markdown characters.');
  const nums = checkNumbers(text, [dataJson]);
  if (!nums.ok) reasons.push(`Some figures were not found in the scenario data: ${nums.unmatched.map((u) => u.text).join(', ')}.`);
  return { ok: reasons.length === 0, words, reasons, unmatched: nums.unmatched.map((u) => u.text), checked: nums.checked };
}

// ---------------------------------------------------------------- model

export type NoteDeps = {
  call: CallDeps;
  model: string;
  budgetSession: string;
  route: string;
};

export type NoteResult = {
  source: 'model' | 'template';
  text: string;
  label: string;
  check: NoteCheck;
  /** Why a template is shown when a model note was wanted. */
  fallback: { reason: 'cap' | 'error'; message: string } | null;
  model: string | null;
  prompt_version: string | null;
  cost_inr: number;
  cache_hit: boolean;
};

export const TEMPLATE_LABEL = 'Template note: written by fixed rules from the scenario data. No model was used.';

export function templateResult(p: PackData, fallback: NoteResult['fallback'] = null): NoteResult {
  const text = templateNote(p);
  const label = fallback ? `${TEMPLATE_LABEL} ${fallback.message}` : TEMPLATE_LABEL;
  return { source: 'template', text, label, check: checkNote(text, JSON.stringify(noteInput(p))), fallback, model: null, prompt_version: null, cost_inr: 0, cache_hit: false };
}

/**
 * One live model call. `fresh` skips the stored reply for identical data, which is what Regenerate wants.
 * Throws the budget errors from callModel; the route turns those into the template.
 */
export async function modelNote(p: PackData, deps: NoteDeps, opts: { fresh: boolean }): Promise<NoteResult> {
  const prompt = loadPrompt(NOTE_PROMPT);
  const data = JSON.stringify(noteInput(p));
  const req: LlmRequest = {
    model: deps.model,
    max_tokens: NOTE_MAX_TOKENS,
    system: [{ type: 'text', text: prompt.text }],
    messages: [{ role: 'user', content: `<scenario_data>\n${data}\n</scenario_data>\nWrite the approval note now.` }],
    thinking_off: true,
  };
  const res = await callModel(
    req,
    {
      stage: 'note', route: deps.route, prompt_version: prompt.version, document_sha256: createHash('sha256').update(data).digest('hex'), context_hash: '-',
      document_id: null, run_id: null, session_id: deps.budgetSession, fresh: opts.fresh, estimated_input_tokens: estimateTextTokens(prompt.text + data) + 80,
    },
    deps.call,
  );
  // House style is applied to the reply (dashes to commas, Indian grouping) before it is checked.
  const text = plain(res.text.replace(/^\s*["'`]+|["'`]+\s*$/g, '').trim());
  const check = checkNote(text, data);
  if (res.stop_reason === 'max_tokens') check.reasons.push('The reply was cut off at the length limit.');
  const ok = check.reasons.length === 0;
  return {
    source: 'model', text, check: { ...check, ok },
    label: `Drafted by ${deps.model}${res.cache_hit ? ' (stored reply for identical data)' : ''} from the scenario data only. Figures checked against that data.`,
    fallback: null, model: deps.model, prompt_version: prompt.version, cost_inr: res.cost_inr, cache_hit: res.cache_hit,
  };
}

// ---------------------------------------------------------------- choosing

export type NoteGate = () => Promise<{ ok: true } | { ok: false; message: string }>;

/**
 * The one place that decides model or template. A model call happens only when asked for, admitted by
 * the caps (`admit`), and affordable. Any refusal or failure gives the template, labelled with why.
 * A model note that fails its check is returned as is: the caller shows the warning and lets the
 * buyer pick Regenerate or the template.
 */
export async function resolveNote(p: PackData, o: { mode: 'model' | 'template'; regenerate: boolean; admit: NoteGate; deps: NoteDeps }): Promise<NoteResult> {
  if (o.mode === 'template') return templateResult(p);
  const gate = await o.admit();
  if (!gate.ok) return templateResult(p, { reason: 'cap', message: `Live model calls are paused (${gate.message.replace(/\.$/, '')}).` });
  try {
    return await modelNote(p, o.deps, { fresh: o.regenerate });
  } catch (e) {
    const cap = e instanceof BudgetExceededError;
    log(cap ? 'warn' : 'error', 'decision_note_failed', { cap, message: (e as Error).message.slice(0, 200) });
    return templateResult(p, cap ? { reason: 'cap', message: 'The spend cap would be passed by a model call.' } : { reason: 'error', message: 'The model call failed.' });
  }
}
