// Shared setup for local scripts: env, DB pool, model deps, budget session.
import pg from 'pg';
import { pgConfig } from '../api/_lib/pgconfig.js';
import type { CallDeps } from '../api/_lib/llm/call.js';
import { realClient } from '../api/_lib/llm/client.js';
import { budgetSessionId } from '../api/_lib/llm/session.js';
import { pgStore } from '../api/_lib/llm/store.js';
import { loadEnvLocal, requireEnv } from './envfile.js';

export function runtime(): { pool: pg.Pool; deps: CallDeps; session_id: string } {
  loadEnvLocal();
  const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 8 }));
  const deps: CallDeps = { client: realClient(), store: pgStore(pool), log: (l) => console.log('   ' + l) };
  return { pool, deps, session_id: budgetSessionId() };
}

export async function sessionSpend(pool: pg.Pool, sessionId: string): Promise<number> {
  const r = await pool.query<{ s: string | null }>('select sum(est_cost_inr) s from usage_log where session_id = $1 and not cache_hit', [sessionId]);
  return Number(r.rows[0]?.s ?? 0);
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let stop: unknown = null;
  const worker = async () => {
    while (next < items.length && !stop) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (e) {
        stop = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (stop) throw stop;
  return out;
}
