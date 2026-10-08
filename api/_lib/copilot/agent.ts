// One co-pilot chat turn. The model may call up to 6 tools, each one a pure edit of the draft RFx.
// Only the buyer's words and the draft RFx reach the model: no vendor text exists on this path.
//
// Cost control, in order: a per turn cap, the daily spend cap, then the session budget guard shared
// with every other route. A refusal throws before any model call is made.
import type Anthropic from '@anthropic-ai/sdk';
import { validateRfx, type DraftRfx, type Validation } from '../../../engine/rfx.js';
import type { AgentClient } from '../analyst/agentClient.js';
import { plain } from '../analyst/agent.js';
import { BudgetExceededError, DailyCapError, sessionCapInr } from '../llm/call.js';
import { costInr, expectedInr, worstCaseInr, type TokenUsage } from '../llm/pricing.js';
import type { LlmStore } from '../llm/store.js';
import { estimateTextTokens } from '../llm/tokens.js';
import { describeStep, MAX_TOOL_CALLS_PER_TURN, runTool } from './tools.js';

export const COPILOT_TURN_CAP_INR = 10;
export const COPILOT_MAX_TOKENS = 4096;
const MAX_MODEL_CALLS = MAX_TOOL_CALLS_PER_TURN + 2;

export class CopilotCapError extends Error {
  constructor(spent: number, next: number) {
    super(`This turn reached the co-pilot cost cap of Rs ${COPILOT_TURN_CAP_INR}. It spent Rs ${spent.toFixed(2)} and the next step could cost up to Rs ${next.toFixed(2)}. Your RFx is saved as it stands.`);
  }
}

export type CopilotEvent =
  | { type: 'session'; draft_id: string }
  | { type: 'text'; delta: string }
  | { type: 'text_reset' }
  | { type: 'step'; id: string; tool: string; label: string; status: 'running' | 'done' | 'error'; summary?: string }
  | { type: 'draft'; rfx: DraftRfx; validation: Validation }
  | { type: 'final'; text: string; validation: Validation; usage: CopilotUsage }
  | { type: 'error'; message: string };

export type CopilotUsage = { cost_inr: number; model_calls: number; tool_calls: number; tokens_in: number; tokens_out: number; cache_read_tokens: number; cache_write_tokens: number };
export type CopilotStep = { tool: string; label: string; summary: string; error: boolean };
export type HistoryMessage = { role: 'user' | 'assistant'; text: string };

export type CopilotDeps = {
  client: AgentClient;
  store: LlmStore;
  model: string;
  budgetSession: string;
  dailyCapInr?: number;
  draftId: string;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
};

/**
 * What the model is shown for the buyer's turn. The draft RFx is data in its own block; the buyer's
 * message follows. This is the only place user content is built, and nothing from a vendor can enter it.
 */
export function buildUserMessage(rfx: DraftRfx, message: string): string {
  return `<current_rfx>\n${JSON.stringify(rfx)}\n</current_rfx>\n\n${message}`;
}

function clone(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map((b) => ({ ...b })) }));
}

/** One rolling cache breakpoint on the newest message, so the tool loop reads its own history from cache. */
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

/** The chat shows plain text, so markdown the model slips in is removed (bold, headings, code ticks). */
export function stripMarkdown(s: string): string {
  return s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/`([^`\n]+)`/g, '$1');
}

export type CopilotTurnOutput = { rfx: DraftRfx; text: string; steps: CopilotStep[]; usage: CopilotUsage; validation: Validation };

export async function runCopilotTurn(
  deps: CopilotDeps,
  input: { rfx: DraftRfx; message: string; history: HistoryMessage[] },
  emit: (e: CopilotEvent) => void,
): Promise<CopilotTurnOutput> {
  let rfx = input.rfx;
  const messages: Anthropic.MessageParam[] = [
    ...input.history.map((h) => ({ role: h.role, content: h.text }) as Anthropic.MessageParam),
    { role: 'user', content: buildUserMessage(rfx, input.message) },
  ];
  const steps: CopilotStep[] = [];
  const totals: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const tools = deps.tools.map((t, i) => (i === deps.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t));
  let turnCost = 0;
  let calls = 0;
  let toolCalls = 0;
  let finalText = '';

  for (let i = 0; i < MAX_MODEL_CALLS; i++) {
    const forceAnswer = toolCalls >= MAX_TOOL_CALLS_PER_TURN || i === MAX_MODEL_CALLS - 1;
    const msgs = withBreakpoint(messages);
    const est = estimateTextTokens(JSON.stringify(deps.system) + JSON.stringify(tools) + JSON.stringify(msgs));
    const worst = worstCaseInr(deps.model, est, COPILOT_MAX_TOKENS);
    const spent = await deps.store.sessionSpendInr(deps.budgetSession);
    const cap = sessionCapInr();
    if (spent + worst > cap) throw new BudgetExceededError(spent, worst, cap);
    if (deps.dailyCapInr !== undefined) {
      const today = await deps.store.daySpendInr();
      if (today + worst > deps.dailyCapInr) throw new DailyCapError(today, worst, deps.dailyCapInr);
    }
    // After the first call the static prefix is cached, so the realistic worst case is the base input rate.
    const turnWorst = calls === 0 ? worst : expectedInr(deps.model, est, COPILOT_MAX_TOKENS);
    if (turnCost + turnWorst > COPILOT_TURN_CAP_INR) throw new CopilotCapError(turnCost, turnWorst);

    if (calls > 0) emit({ type: 'text_reset' });
    calls++;
    const res = await deps.client.stream(
      { model: deps.model, max_tokens: COPILOT_MAX_TOKENS, system: deps.system, tools, messages: msgs, ...(forceAnswer ? { tool_choice: { type: 'none' as const } } : {}) },
      (d) => emit({ type: 'text', delta: d }),
    );
    const cost = costInr(deps.model, res.usage);
    turnCost += cost;
    totals.input_tokens += res.usage.input_tokens;
    totals.output_tokens += res.usage.output_tokens;
    totals.cache_creation_input_tokens += res.usage.cache_creation_input_tokens;
    totals.cache_read_input_tokens += res.usage.cache_read_input_tokens;
    await deps.store.logUsage({
      route: 'api:copilot', stage: 'copilot', model: deps.model, usage: res.usage, est_cost_inr: cost,
      session_id: deps.budgetSession, run_id: deps.draftId, document_id: null, cache_hit: false,
    });

    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || uses.length === 0) {
      finalText = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      if (res.stop_reason === 'max_tokens') finalText += '\n\n(The reply was cut off at the length limit. Ask me to continue.)';
      break;
    }

    messages.push({ role: 'assistant', content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      if (toolCalls >= MAX_TOOL_CALLS_PER_TURN) {
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Tool call limit of ${MAX_TOOL_CALLS_PER_TURN} reached for this turn. Tell the buyer what is still to do and stop.` });
        continue;
      }
      toolCalls++;
      const label = describeStep(u.name);
      emit({ type: 'step', id: u.id, tool: u.name, label, status: 'running' });
      const out = runTool(rfx, u.name, u.input);
      rfx = out.rfx;
      steps.push({ tool: u.name, label, summary: out.summary, error: out.error });
      emit({ type: 'step', id: u.id, tool: u.name, label, status: out.error ? 'error' : 'done', summary: out.summary });
      emit({ type: 'draft', rfx, validation: validateRfx(rfx) });
      results.push({ type: 'tool_result', tool_use_id: u.id, is_error: out.error ? true : undefined, content: JSON.stringify(out.model) });
    }
    messages.push({ role: 'user', content: results });
  }

  if (!finalText.trim()) finalText = 'I made the changes shown on the right. Check the findings below before you issue.';
  const text = stripMarkdown(plain(finalText.trim()));
  const validation = validateRfx(rfx);
  const usage: CopilotUsage = {
    cost_inr: turnCost, model_calls: calls, tool_calls: toolCalls, tokens_in: totals.input_tokens, tokens_out: totals.output_tokens,
    cache_read_tokens: totals.cache_read_input_tokens, cache_write_tokens: totals.cache_creation_input_tokens,
  };
  emit({ type: 'final', text, validation, usage });
  return { rfx, text, steps, usage, validation };
}
