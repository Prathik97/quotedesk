// The analyst agent loop. One call to runTurn is one chat turn: the model may call up to 8 tools,
// streams its answer, and the server then checks every figure in the answer against the tool results.
//
// Cost control, in order: a per turn cap, then the session budget guard shared with extraction.
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { BudgetExceededError, DailyCapError, sessionCapInr } from '../llm/call.js';
import { costInr, expectedInr, worstCaseInr, type TokenUsage } from '../llm/pricing.js';
import type { LlmStore } from '../llm/store.js';
import { estimateTextTokens } from '../llm/tokens.js';
import { log } from '../http.js';
import type { AgentClient } from './agentClient.js';
import { checkNumbers, type NumberCheck } from './numcheck.js';
import { MAX_TOOL_CALLS_PER_TURN } from './tools.js';
import type { ChartPayload, ExportChip, SessionState, StepRecord, StoredResult, ToolOutcome } from './types.js';

export const PER_TURN_CAP_INR = 12;
export const MAX_TOKENS = 2500;
const MAX_MODEL_CALLS = MAX_TOOL_CALLS_PER_TURN + 2;

export class TurnCapError extends Error {
  constructor(
    public readonly spent: number,
    public readonly next: number,
  ) {
    super(`This question reached the per turn cost cap of Rs ${PER_TURN_CAP_INR}. It spent Rs ${spent.toFixed(2)} and the next step could cost up to Rs ${next.toFixed(2)}.`);
  }
}

export type AnalystEvent =
  | { type: 'session'; session_id: string }
  | { type: 'text'; delta: string }
  | { type: 'text_reset' }
  | { type: 'step'; id: string; tool: string; label: string; status: 'running' | 'done' | 'error'; summary?: string }
  | { type: 'result'; result: StoredResult }
  | { type: 'chart'; chart: ChartPayload }
  | { type: 'export'; chip: ExportChip }
  | { type: 'final'; answer: FinalAnswer }
  | { type: 'error'; message: string };

export type FinalAnswer = {
  body: string;
  callout: string | null;
  alternatives: { label: string; question: string }[];
  how: HowIGotThis;
  warnings: string[];
  number_check: { ok: boolean; checked: number; unmatched: string[] };
  usage: { cost_inr: number; model_calls: number; tokens_in: number; tokens_out: number; cache_read_tokens: number; cache_write_tokens: number };
};

export type HowIGotThis = {
  steps: { tool: string; summary: string; sql: string | null; scenario: string | null; assumptions: string | null; rows_used: number | null; result_id: string | null; evidence_ids: string[] }[];
  reliance: { result_id: string; text: string }[];
};

export type HistoryMessage = { role: 'user' | 'assistant'; text: string };

export type TurnDeps = {
  client: AgentClient;
  store: LlmStore;
  model: string;
  budgetSession: string;
  /** When set, a model call is refused if today's spend across all sessions would pass it. */
  dailyCapInr?: number;
  chatSession: string;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  /** Static text the model saw in the system prompt, so figures quoted from it are not flagged. */
  contextText: string;
  runTool: (name: string, input: unknown) => Promise<ToolOutcome>;
  describeStep: (name: string, input: unknown) => string;
  describeScenario: (s: SessionState) => string;
  getState: () => SessionState;
};

export type TurnInput = {
  question: string;
  history: HistoryMessage[];
  /** One line per result stored in earlier turns, so the model can chart or export them by id. */
  priorResults?: string;
};

export type TurnOutput = {
  final: FinalAnswer;
  steps: StepRecord[];
  results: StoredResult[];
  rawText: string;
  check: NumberCheck;
};

const AltSchema = z.array(z.object({ label: z.string().min(1).max(120), question: z.string().min(1).max(300) })).max(3);

export function parseAnswer(text: string): { body: string; callout: string | null; alternatives: { label: string; question: string }[] } {
  const calloutM = /<callout>([\s\S]*?)<\/callout>/i.exec(text);
  const altM = /<alternatives>([\s\S]*?)<\/alternatives>/i.exec(text);
  let alternatives: { label: string; question: string }[] = [];
  if (altM) {
    try {
      const parsed = AltSchema.safeParse(JSON.parse((altM[1] ?? '').trim()));
      if (parsed.success) alternatives = parsed.data;
    } catch {
      // A malformed block is dropped, not shown.
    }
  }
  const body = text.replace(/<callout>[\s\S]*?<\/callout>/gi, '').replace(/<alternatives>[\s\S]*?<\/alternatives>/gi, '').replace(/<\/?(callout|alternatives)>/gi, '').trim();
  return { body: plain(body), callout: calloutM ? plain((calloutM[1] ?? '').trim()) : null, alternatives };
}

function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  return `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;
}

/** Indian digit grouping for rupee amounts: 1,843,200 and ₹1843200 both become 18,43,200. Digits are never changed, only the commas. */
export function indianGrouping(s: string): string {
  return s
    .replace(/(?<![\d,.])\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?(?![\d,])/g, (m) => {
      const [whole = '', frac] = m.replace(/,/g, '').split('.');
      return `${groupIndian(whole)}${frac ? `.${frac}` : ''}`;
    })
    .replace(/₹\s?(\d{5,})(\.\d+)?(?![\d,])/g, (_m, whole: string, frac?: string) => `₹${groupIndian(whole)}${frac ?? ''}`);
}

/** House style: no em or en dashes in copy, and Indian digit grouping. */
export function plain(s: string): string {
  return indianGrouping(s).replace(/\s*[\u2014\u2013]\s*/g, (m, off: number, all: string) => {
    const before = all[off - 1] ?? '';
    const after = all[off + m.length] ?? '';
    return /\d/.test(before) && /\d/.test(after) ? ' to ' : ', ';
  });
}

function clone(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map((b) => ({ ...b })) }));
}

/** One rolling cache breakpoint on the newest message, so the growing tool loop is read from cache. */
function withBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out = clone(messages);
  const last = out[out.length - 1];
  if (!last) return out;
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  else {
    const b = last.content[last.content.length - 1] as { cache_control?: unknown } | undefined;
    if (b) b.cache_control = { type: 'ephemeral' };
  }
  return out;
}

function tokensOf(system: Anthropic.TextBlockParam[], tools: Anthropic.Tool[], messages: Anthropic.MessageParam[]): number {
  return estimateTextTokens(JSON.stringify(system) + JSON.stringify(tools) + JSON.stringify(messages));
}

export async function runTurn(deps: TurnDeps, input: TurnInput, emit: (e: AnalystEvent) => void): Promise<TurnOutput> {
  const stateText = deps.describeScenario(deps.getState());
  const prior = input.priorResults ? `<prior_results>\n${input.priorResults}\n</prior_results>\n` : '';
  const userContent = `<scenario_in_force>${stateText}</scenario_in_force>\n${prior}\n${input.question}`;
  const messages: Anthropic.MessageParam[] = [...input.history.map((h) => ({ role: h.role, content: h.text }) as Anthropic.MessageParam), { role: 'user', content: userContent }];

  const steps: StepRecord[] = [];
  const results: StoredResult[] = [];
  const modelSeen: string[] = [];
  const totals: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let turnCost = 0;
  let calls = 0;
  let toolCalls = 0;
  let finalText = '';
  const notices: string[] = [];
  const toolsWithBreakpoint = deps.tools.map((t, i) => (i === deps.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t));

  for (let i = 0; i < MAX_MODEL_CALLS; i++) {
    const forceAnswer = toolCalls >= MAX_TOOL_CALLS_PER_TURN || i === MAX_MODEL_CALLS - 1;
    const msgs = withBreakpoint(messages);
    const est = tokensOf(deps.system, toolsWithBreakpoint, msgs);
    const sessionWorst = worstCaseInr(deps.model, est, MAX_TOKENS);
    const spent = await deps.store.sessionSpendInr(deps.budgetSession);
    const cap = sessionCapInr();
    if (spent + sessionWorst > cap) throw new BudgetExceededError(spent, sessionWorst, cap);
    if (deps.dailyCapInr !== undefined) {
      const today = await deps.store.daySpendInr();
      if (today + sessionWorst > deps.dailyCapInr) throw new DailyCapError(today, sessionWorst, deps.dailyCapInr);
    }
    // After the first call the static prefix is cached, so the realistic worst case is the base input rate.
    const turnWorst = calls === 0 ? sessionWorst : expectedInr(deps.model, est, MAX_TOKENS);
    if (turnCost + turnWorst > PER_TURN_CAP_INR) throw new TurnCapError(turnCost, turnWorst);

    if (calls > 0) emit({ type: 'text_reset' });
    calls++;
    const res = await deps.client.stream(
      { model: deps.model, max_tokens: MAX_TOKENS, system: deps.system, tools: toolsWithBreakpoint, messages: msgs, ...(forceAnswer ? { tool_choice: { type: 'none' as const } } : {}) },
      (d) => emit({ type: 'text', delta: d }),
    );
    const cost = costInr(deps.model, res.usage);
    turnCost += cost;
    totals.input_tokens += res.usage.input_tokens;
    totals.output_tokens += res.usage.output_tokens;
    totals.cache_creation_input_tokens += res.usage.cache_creation_input_tokens;
    totals.cache_read_input_tokens += res.usage.cache_read_input_tokens;
    await deps.store.logUsage({
      route: 'api:analyst', stage: 'analyst', model: deps.model, usage: res.usage, est_cost_inr: cost,
      session_id: deps.budgetSession, run_id: deps.chatSession, document_id: null, cache_hit: false,
    });

    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || uses.length === 0) {
      finalText = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      if (res.stop_reason === 'max_tokens') notices.push('The answer was cut off at the length limit. Ask for a shorter version or one part at a time.');
      break;
    }

    messages.push({ role: 'assistant', content: res.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      if (toolCalls >= MAX_TOOL_CALLS_PER_TURN) {
        toolResults.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Tool call limit of ${MAX_TOOL_CALLS_PER_TURN} reached for this turn. Answer now using the results you already have, and say what you could not check.` });
        continue;
      }
      toolCalls++;
      const label = deps.describeStep(u.name, u.input);
      emit({ type: 'step', id: u.id, tool: u.name, label, status: 'running' });
      const out = await deps.runTool(u.name, u.input);
      const modelJson = JSON.stringify(out.model);
      modelSeen.push(modelJson);
      steps.push({
        id: u.id, tool: u.name, input: u.input, status: out.error ? 'error' : 'done', summary: out.summary, result_id: out.result?.id ?? null,
        rows_used: out.rows_used ?? null, sql: out.sql ?? null, scenario: out.scenario ?? null, assumptions: out.assumptions ?? null, evidence_ids: out.evidence_ids ?? [],
      });
      emit({ type: 'step', id: u.id, tool: u.name, label, status: out.error ? 'error' : 'done', summary: out.summary });
      if (out.result) {
        results.push(out.result);
        emit({ type: 'result', result: out.result });
      }
      if (out.chart) emit({ type: 'chart', chart: out.chart });
      if (out.export) emit({ type: 'export', chip: out.export });
      toolResults.push({ type: 'tool_result', tool_use_id: u.id, is_error: out.error ? true : undefined, content: modelJson });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText.trim()) finalText = 'I could not finish this answer. Try a narrower question.';
  const parsed = parseAnswer(finalText);
  const warnings = [...notices];

  // Server number check: every figure must appear in something the model was given.
  const earlier = input.history.map((h) => h.text);
  const check = checkNumbers(`${parsed.body}\n${parsed.callout ?? ''}`, [deps.contextText, input.question, ...earlier, stateText, input.priorResults ?? '', ...modelSeen]);
  if (!check.ok) {
    warnings.push(`Some figures in this answer were not found in any tool result: ${check.unmatched.map((u) => u.text).join(', ')}. Treat them as unverified.`);
    log('warn', 'analyst_number_check_failed', { chat_session: deps.chatSession, unmatched: check.unmatched.map((u) => u.text) });
  }
  if (steps.length > 0 && !parsed.callout) {
    warnings.push('This answer does not say how many of the cells it relied on are Assumed, Needs review or Not quoted. Check the "How I got this" panel before relying on it.');
    log('warn', 'analyst_missing_callout', { chat_session: deps.chatSession });
  }

  const how: HowIGotThis = {
    steps: steps.map((s) => ({
      tool: s.tool, summary: s.summary, sql: s.sql, scenario: s.scenario ? deps.describeScenario({ scenario: s.scenario, assumptions: s.assumptions ?? {} }) : null,
      assumptions: s.assumptions && Object.keys(s.assumptions).length ? JSON.stringify(s.assumptions) : null, rows_used: s.rows_used, result_id: s.result_id, evidence_ids: s.evidence_ids,
    })),
    reliance: results.filter((r) => r.kind === 'award').map((r) => ({ result_id: r.id, text: relianceText(r) })),
  };

  const final: FinalAnswer = {
    body: parsed.body,
    callout: parsed.callout,
    alternatives: parsed.alternatives,
    how,
    warnings,
    number_check: { ok: check.ok, checked: check.checked, unmatched: check.unmatched.map((u) => u.text) },
    usage: { cost_inr: turnCost, model_calls: calls, tokens_in: totals.input_tokens, tokens_out: totals.output_tokens, cache_read_tokens: totals.cache_read_input_tokens, cache_write_tokens: totals.cache_creation_input_tokens },
  };
  emit({ type: 'final', answer: final });
  return { final, steps, results, rawText: finalText, check };
}

function relianceText(r: StoredResult): string {
  const d = r.data as { award?: { reliance: { confirmed: number; assumed: number; needs_review: number; conflict: number; missing: number } } } | undefined;
  const x = d?.award?.reliance;
  if (!x) return '';
  return `Scenario ${r.id} relies on ${x.confirmed} Confirmed, ${x.assumed} Assumed, ${x.needs_review} Needs review and ${x.conflict} Conflict cells. ${x.missing} ${x.missing === 1 ? 'line is' : 'lines are'} not covered.`;
}
