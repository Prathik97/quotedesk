// Every model call goes through callModel. In order:
//   1. dev cache lookup (unless fresh): a hit returns a stored REAL response, labelled
//   2. hard budget guard: refuses the call if worst case cost would pass the session cap
//   3. the call itself (no SDK retries)
//   4. usage log and cost line
import { createHash } from 'node:crypto';
import type { LlmClient, LlmRequest } from './client.js';
import { costInr, worstCaseInr, type TokenUsage } from './pricing.js';
import type { LlmStore } from './store.js';

/** Hard cap from the owner. The env can lower it, never raise it. */
export const SESSION_CAP_INR_MAX = 300;

export function sessionCapInr(): number {
  const env = Number(process.env.SESSION_BUDGET_INR);
  return Number.isFinite(env) && env > 0 ? Math.min(env, SESSION_CAP_INR_MAX) : SESSION_CAP_INR_MAX;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly spent: number,
    public readonly next: number,
    public readonly cap: number,
  ) {
    super(
      `Budget guard: this call could cost up to Rs ${next.toFixed(2)}, and the session has already spent Rs ${spent.toFixed(2)} of its Rs ${cap} cap. Call refused.`,
    );
  }
}

/** The daily spend cap (DAILY_SPEND_CAP_INR) would be passed. Treated like the session cap everywhere. */
export class DailyCapError extends BudgetExceededError {
  constructor(spent: number, next: number, cap: number) {
    super(spent, next, cap);
    this.name = 'DailyCapError';
    this.message = `The daily spend cap of Rs ${cap} has been reached (Rs ${spent.toFixed(2)} spent today). No live model call was made.`;
  }
}

export type CallContext = {
  stage: 'classify' | 'extract' | 'repair' | 'certificate' | 'ping' | 'note';
  route: string;
  prompt_version: string;
  document_sha256: string;
  /** Hash of anything else that shapes the output, such as the RFx line list. */
  context_hash: string;
  document_id: string | null;
  run_id: string | null;
  session_id: string;
  fresh: boolean;
  estimated_input_tokens: number;
};

export type CallResult = {
  text: string;
  stop_reason: string | null;
  usage: TokenUsage;
  cost_inr: number;
  cache_hit: boolean;
  cached_at?: string;
};

export type CallDeps = {
  client: LlmClient;
  store: LlmStore;
  log?: (line: string) => void;
  /** When set, a live call is refused if today's spend across all sessions would pass it. */
  dailyCapInr?: number;
};

// Reservations for calls in flight, so parallel workers cannot jointly pass the cap.
const inFlight = new Map<string, number>();

export function cacheKey(req: LlmRequest, ctx: CallContext): string {
  const h = createHash('sha256');
  h.update([ctx.stage, req.model, ctx.prompt_version, ctx.document_sha256, ctx.context_hash, String(req.max_tokens)].join('|'));
  // Repair calls depend on the failed output, so include the whole message list for them.
  if (ctx.stage === 'repair') h.update(JSON.stringify(req.messages));
  return h.digest('hex');
}

export async function callModel(req: LlmRequest, ctx: CallContext, deps: CallDeps): Promise<CallResult> {
  const key = cacheKey(req, ctx);
  const log = deps.log ?? (() => {});

  if (!ctx.fresh) {
    const hit = await deps.store.getCache(key);
    if (hit) {
      await deps.store.logUsage({
        route: ctx.route, stage: ctx.stage, model: req.model, usage: hit.usage, est_cost_inr: 0,
        session_id: ctx.session_id, run_id: ctx.run_id, document_id: ctx.document_id, cache_hit: true,
      });
      log(`[CACHE HIT] ${ctx.stage} ${req.model}: stored real response from ${hit.created_at}, no API call, Rs 0.00`);
      return { text: hit.response_text, stop_reason: 'end_turn', usage: hit.usage, cost_inr: 0, cache_hit: true, cached_at: hit.created_at };
    }
  }

  const cap = sessionCapInr();
  const worst = worstCaseInr(req.model, ctx.estimated_input_tokens, req.max_tokens);
  const spent = await deps.store.sessionSpendInr(ctx.session_id);
  const reserved = [...inFlight.values()].reduce((s, v) => s + v, 0);
  if (deps.dailyCapInr !== undefined) {
    const today = await deps.store.daySpendInr();
    if (today + reserved + worst > deps.dailyCapInr) throw new DailyCapError(today + reserved, worst, deps.dailyCapInr);
  }
  if (spent + reserved + worst > cap) throw new BudgetExceededError(spent + reserved, worst, cap);

  const token = `${key}:${Math.random()}`;
  inFlight.set(token, worst);
  try {
    const res = await deps.client.complete(req);
    const cost = costInr(req.model, res.usage);
    await deps.store.logUsage({
      route: ctx.route, stage: ctx.stage, model: req.model, usage: res.usage, est_cost_inr: cost,
      session_id: ctx.session_id, run_id: ctx.run_id, document_id: ctx.document_id, cache_hit: false,
    });
    // Only complete answers are cached; a truncated one must be re-run, not replayed.
    if (res.stop_reason === 'end_turn') {
      await deps.store.putCache(key, { stage: ctx.stage, model: req.model, prompt_version: ctx.prompt_version, document_sha256: ctx.document_sha256 }, res.text, res.usage);
    }
    const after = await deps.store.sessionSpendInr(ctx.session_id);
    log(
      `[LIVE] ${ctx.stage} ${req.model}: in ${res.usage.input_tokens} (cache read ${res.usage.cache_read_input_tokens}, write ${res.usage.cache_creation_input_tokens}), out ${res.usage.output_tokens}, Rs ${cost.toFixed(2)}; session Rs ${after.toFixed(2)} of ${cap}`,
    );
    return { text: res.text, stop_reason: res.stop_reason, usage: res.usage, cost_inr: cost, cache_hit: false };
  } finally {
    inFlight.delete(token);
  }
}
