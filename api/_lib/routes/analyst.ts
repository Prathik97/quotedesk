// POST /api/analyst { session_id?, message }  streams the turn as newline delimited JSON events.
// GET  /api/analyst?session_id=X              returns the saved conversation so a reload restores it.
import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../env.js';
import { db, roDb } from '../db.js';
import { ApiError, log, route } from '../http.js';
import { runTurn, TurnCapError, type AnalystEvent, type HistoryMessage } from '../analyst/agent.js';
import { realAgentClient } from '../analyst/agentClient.js';
import { loadAnalystData } from '../analyst/data.js';
import { createSession, describeState, describeStepLabel, loadMessages, loadResults, loadState, saveMessage, saveResults, saveState, systemBlocks } from '../analyst/session.js';
import { executeTool, toolDefinitions, type ToolCtx } from '../analyst/tools.js';
import type { ChartPayload, ExportChip } from '../analyst/types.js';
import { BudgetExceededError } from '../llm/call.js';
import { budgetSessionId } from '../llm/session.js';
import { pgStore } from '../llm/store.js';

const Body = z.object({ session_id: z.string().uuid().optional(), message: z.string().trim().min(1, 'Type a question first.').max(1500, 'Keep the question under 1500 characters.') });

export default route(['GET', 'POST'], async (req: VercelRequest, res: VercelResponse) => {
  const pool = db();
  if (req.method === 'GET') {
    const id = z.string().uuid().safeParse(req.query.session_id);
    if (!id.success) return { session_id: null, messages: [], results: [] };
    const [messages, results] = await Promise.all([loadMessages(pool, id.data), loadResults(pool, id.data)]);
    return { session_id: id.data, messages, results: [...results.values()] };
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Send { message } as JSON.');
  const { message } = parsed.data;
  let sessionId = parsed.data.session_id ?? null;
  let state = sessionId ? await loadState(pool, sessionId) : null;
  if (!sessionId || !state) {
    sessionId = await createSession(pool);
    state = (await loadState(pool, sessionId)) as NonNullable<typeof state>;
  }
  const chatSession = sessionId;

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.status(200);
  const emit = (e: AnalystEvent) => {
    res.write(JSON.stringify(e) + '\n');
  };
  emit({ type: 'session', session_id: chatSession });

  try {
    let dataP: ReturnType<typeof loadAnalystData> | null = null;
    const data = () => (dataP ??= loadAnalystData(pool));
    const [sys, prior, results, past] = await Promise.all([
      data().then((d) => systemBlocks(d)),
      loadMessages(pool, chatSession),
      loadResults(pool, chatSession),
      pool.query<{ n: string }>('select count(*) as n from analyst_results where session_id = $1', [chatSession]),
    ]);
    let counter = Number(past.rows[0]?.n ?? 0);
    const before = new Set(results.keys());
    const ctx: ToolCtx = { ro: roDb(), pool, sessionId: chatSession, state, results, data, newResultId: () => `r${++counter}` };
    const history: HistoryMessage[] = prior.slice(-8).map((m) => ({ role: m.role, text: m.role === 'assistant' ? assistantText(m.final, m.text) : m.text }));

    await saveMessage(pool, chatSession, 'user', { text: message }, null, null);
    const charts: ChartPayload[] = [];
    const exportsOut: ExportChip[] = [];
    const out = await runTurn(
      {
        client: realAgentClient(), store: pgStore(pool), model: env().MODEL_ANALYST, budgetSession: budgetSessionId(), chatSession,
        system: sys.blocks, tools: toolDefinitions() as never, contextText: sys.contextText,
        runTool: (name, input) => executeTool(ctx, name, input), describeStep: describeStepLabel, describeScenario: (s) => describeState(s), getState: () => ctx.state,
      },
      { question: message, history },
      (e) => {
        if (e.type === 'chart') charts.push(e.chart);
        if (e.type === 'export') exportsOut.push(e.chip);
        emit(e);
      },
    );
    const fresh = [...results.values()].filter((r) => !before.has(r.id));
    await saveResults(pool, chatSession, fresh);
    await saveState(pool, chatSession, ctx.state);
    await saveMessage(pool, chatSession, 'assistant', { text: out.rawText, final: out.final }, out.steps, { results: fresh.map((r) => r.id), charts, exports: exportsOut, prompt: sys.promptVersion });
  } catch (e) {
    const msg =
      e instanceof BudgetExceededError || e instanceof TurnCapError
        ? e.message
        : 'The analyst hit a problem and stopped. Your data is untouched. Try again, or ask a narrower question.';
    log(e instanceof BudgetExceededError || e instanceof TurnCapError ? 'warn' : 'error', 'analyst_failed', { chat_session: chatSession, message: (e as Error).message.slice(0, 300) });
    emit({ type: 'error', message: msg });
  }
  res.end();
  return undefined;
});

function assistantText(final: unknown, fallback: string): string {
  const f = final as { body?: string; callout?: string | null } | null;
  if (!f?.body) return fallback;
  return f.callout ? `${f.body}\n[Data note: ${f.callout}]` : f.body;
}
