// POST /api/copilot { browser_id, draft_id?, message }  streams one co-pilot turn as newline delimited JSON.
// The model edits only the buyer's own draft row (rfx_drafts) through tools. It never touches the seeded
// RFx and never sees vendor text: it receives the buyer's message and the draft, nothing else.
import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { realAgentClient } from '../analyst/agentClient.js';
import { CopilotCapError, runCopilotTurn, type CopilotEvent, type HistoryMessage } from '../copilot/agent.js';
import { BrowserId, createDraft, DraftLimitError, getDraft, latestDraft, saveState, type ChatMessage } from '../copilot/drafts.js';
import { toolDefinitions } from '../copilot/tools.js';
import { db } from '../db.js';
import { env } from '../env.js';
import { admitModelCall, CAPPED_LABEL } from '../guard.js';
import { loadPrompt } from '../extract/model.js';
import { ApiError, log, route } from '../http.js';
import { BudgetExceededError } from '../llm/call.js';
import { budgetSessionId } from '../llm/session.js';
import { pgStore } from '../llm/store.js';

const Body = z.object({
  browser_id: BrowserId,
  draft_id: z.string().uuid().optional(),
  message: z.string().trim().min(1, 'Type a message first.').max(2000, 'Keep the message under 2000 characters.'),
});

export default route(['POST'], async (req: VercelRequest, res: VercelResponse) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Send { browser_id, message } as JSON.');
  const { browser_id, message } = parsed.data;
  const pool = db();
  // Before any work: the per IP limit and the spend caps. A refusal costs nothing.
  const gate = await admitModelCall(pool, req, 'copilot');
  if (!gate.ok) throw new ApiError(429, 'capped', gate.message, { reason: gate.reason, label: CAPPED_LABEL });

  let draft = parsed.data.draft_id ? await getDraft(pool, browser_id, parsed.data.draft_id) : await latestDraft(pool, browser_id);
  if (draft && draft.status === 'issued') draft = null; // an issued RFx is final: a new brief starts a new draft
  if (!draft) {
    try {
      draft = await createDraft(pool, browser_id);
    } catch (e) {
      if (e instanceof DraftLimitError) throw new ApiError(503, 'too_many_drafts', e.message);
      throw e;
    }
  }
  const current = draft;

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.status(200);
  // Keep the newest draft the tools produced, so a turn that stops half way still saves what it did.
  let latest = current.rfx;
  const emit = (e: CopilotEvent) => {
    if (e.type === 'draft') latest = e.rfx;
    res.write(JSON.stringify(e) + '\n');
  };
  emit({ type: 'session', draft_id: current.id });

  try {
    const prompt = loadPrompt('copilot.v2');
    const history: HistoryMessage[] = current.messages.slice(-10).map((m) => ({ role: m.role, text: m.text }));
    const out = await runCopilotTurn(
      {
        client: realAgentClient(), store: pgStore(pool), model: env().MODEL_ANALYST, budgetSession: budgetSessionId(), dailyCapInr: env().DAILY_SPEND_CAP_INR, draftId: current.id,
        system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }], tools: toolDefinitions(),
      },
      { rfx: current.rfx, message, history },
      emit,
    );
    const msgs: ChatMessage[] = [
      ...current.messages,
      { role: 'user', text: message },
      { role: 'assistant', text: out.text, steps: out.steps, cost_inr: out.usage.cost_inr },
    ];
    await saveState(pool, current.id, out.rfx, msgs);
    log('info', 'copilot_turn', { draft: current.id, prompt: prompt.version, cost_inr: Number(out.usage.cost_inr.toFixed(3)), calls: out.usage.model_calls, tools: out.usage.tool_calls });
  } catch (e) {
    const known = e instanceof BudgetExceededError || e instanceof CopilotCapError;
    log(known ? 'warn' : 'error', 'copilot_failed', { draft: current.id, message: (e as Error).message.slice(0, 300) });
    const msg = known ? (e as Error).message : 'The co-pilot hit a problem and stopped. Any change it already made is saved. Try again, or edit the cells directly.';
    await saveState(pool, current.id, latest, [...current.messages, { role: 'user', text: message }, { role: 'assistant', text: msg }]).catch(() => undefined);
    emit({ type: 'error', message: msg });
  }
  res.end();
  return undefined;
});
