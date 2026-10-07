// Persistence used by the model call wrapper: cache, usage log, session spend.
// Interface so tests can use an in-memory store.
import type pg from 'pg';
import type { TokenUsage } from './pricing.js';

export type CacheEntry = { response_text: string; usage: TokenUsage; created_at: string };

export type UsageRow = {
  route: string;
  stage: string;
  model: string;
  usage: TokenUsage;
  est_cost_inr: number;
  session_id: string;
  run_id: string | null;
  document_id: string | null;
  cache_hit: boolean;
};

export interface LlmStore {
  getCache(key: string): Promise<CacheEntry | null>;
  putCache(key: string, meta: { stage: string; model: string; prompt_version: string; document_sha256: string }, text: string, usage: TokenUsage): Promise<void>;
  logUsage(row: UsageRow): Promise<void>;
  sessionSpendInr(sessionId: string): Promise<number>;
}

export function pgStore(pool: pg.Pool): LlmStore {
  return {
    async getCache(key) {
      const r = await pool.query<{ response_text: string; usage: TokenUsage; created_at: Date }>(
        'select response_text, usage, created_at from llm_cache where key = $1',
        [key],
      );
      const row = r.rows[0];
      return row ? { response_text: row.response_text, usage: row.usage, created_at: row.created_at.toISOString() } : null;
    },
    async putCache(key, meta, text, usage) {
      await pool.query(
        `insert into llm_cache (key, stage, model, prompt_version, document_sha256, response_text, usage)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (key) do update set response_text = excluded.response_text, usage = excluded.usage, created_at = now()`,
        [key, meta.stage, meta.model, meta.prompt_version, meta.document_sha256, text, JSON.stringify(usage)],
      );
    },
    async logUsage(u) {
      await pool.query(
        `insert into usage_log (route, stage, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
           est_cost_inr, session_id, run_id, document_id, cache_hit)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [u.route, u.stage, u.model, u.usage.input_tokens, u.usage.output_tokens, u.usage.cache_read_input_tokens,
          u.usage.cache_creation_input_tokens, u.est_cost_inr, u.session_id, u.run_id, u.document_id, u.cache_hit],
      );
    },
    async sessionSpendInr(sessionId) {
      const r = await pool.query<{ s: string | null }>(
        'select sum(est_cost_inr) as s from usage_log where session_id = $1 and not cache_hit',
        [sessionId],
      );
      return Number(r.rows[0]?.s ?? 0);
    },
  };
}

/** In-memory store for tests. */
export function memoryStore(): LlmStore & { usage: UsageRow[]; cache: Map<string, CacheEntry> } {
  const cache = new Map<string, CacheEntry>();
  const usage: UsageRow[] = [];
  return {
    cache,
    usage,
    async getCache(key) {
      return cache.get(key) ?? null;
    },
    async putCache(key, _meta, text, u) {
      cache.set(key, { response_text: text, usage: u, created_at: new Date().toISOString() });
    },
    async logUsage(row) {
      usage.push(row);
    },
    async sessionSpendInr(sessionId) {
      return usage.filter((u) => u.session_id === sessionId && !u.cache_hit).reduce((s, u) => s + u.est_cost_inr, 0);
    },
  };
}
