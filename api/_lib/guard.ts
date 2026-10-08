// Public safety for the model backed routes (R7, FR-11.1, FR-11.3).
//   1. a per IP hourly limit (PER_IP_HOURLY_CALLS), counted per request to a model route
//   2. a daily spend cap (DAILY_SPEND_CAP_INR) summed from usage_log, across every route
//   3. the session budget cap, also summed from usage_log (llm/call.ts)
// Raw IP addresses are never stored: only a salted hash.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
import type pg from 'pg';
import { env } from './env.js';
import { log } from './http.js';
import { PER_TURN_CAP_INR } from './analyst/agent.js';
import { sessionCapInr } from './llm/call.js';
import { budgetSessionId } from './llm/session.js';
import { pgStore } from './llm/store.js';

export const CAPPED_LABEL = 'Showing stored results from an earlier live run';

/** Stop admitting a new live request when less than one analyst turn at its cap is left. */
export const ADMISSION_HEADROOM_INR = PER_TURN_CAP_INR;

export const RESET_PER_IP_HOURLY = 3;
export const RESET_GLOBAL_HOURLY = 20;

export type CapReason = 'daily_cap' | 'ip_limit';
export type ModelRoute = 'analyst' | 'extract' | 'decision' | 'copilot' | 'outbox';

export type Admission = { ok: true; ip_hash: string } | { ok: false; reason: CapReason; message: string };

export function clientIp(req: Pick<VercelRequest, 'headers'> & { socket?: { remoteAddress?: string } }): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  const real = req.headers['x-real-ip'];
  return first || (Array.isArray(real) ? real[0] : real) || req.socket?.remoteAddress || 'unknown';
}

export function hashIp(ip: string, salt: string): string {
  return createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);
}

function ipHashOf(req: Parameters<typeof clientIp>[0]): string {
  const e = env();
  return hashIp(clientIp(req), e.IP_HASH_SALT || e.SUPABASE_SERVICE_ROLE_KEY);
}

export type UsageSummary = {
  calls_today: number;
  cost_today_inr: number;
  daily_cap_inr: number;
  session_spent_inr: number;
  session_cap_inr: number;
  per_ip_hourly_calls: number;
  capped: boolean;
  reason: CapReason | null;
  message: string | null;
  label: string;
};

/** Today's live model calls and cost (India date), and whether the global caps leave room for a new request. */
export async function usageSummary(pool: pg.Pool): Promise<UsageSummary> {
  const e = env();
  const r = await pool.query<{ n: string; s: string | null }>(
    `select count(*) as n, sum(est_cost_inr) as s from usage_log
     where not cache_hit and created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`,
  );
  const calls = Number(r.rows[0]?.n ?? 0);
  const cost = Number(r.rows[0]?.s ?? 0);
  const sessionSpent = await pgStore(pool).sessionSpendInr(budgetSessionId());
  const sessionCap = sessionCapInr();
  const dailyOut = cost + ADMISSION_HEADROOM_INR > e.DAILY_SPEND_CAP_INR;
  const sessionOut = sessionSpent + ADMISSION_HEADROOM_INR > sessionCap;
  const capped = dailyOut || sessionOut;
  return {
    calls_today: calls,
    cost_today_inr: cost,
    daily_cap_inr: e.DAILY_SPEND_CAP_INR,
    session_spent_inr: sessionSpent,
    session_cap_inr: sessionCap,
    per_ip_hourly_calls: e.PER_IP_HOURLY_CALLS,
    capped,
    reason: capped ? 'daily_cap' : null,
    message: capped ? 'The live demo has reached its spend cap for today, so new model calls are paused. Everything else still works.' : null,
    label: CAPPED_LABEL,
  };
}

async function admittedInLastHour(pool: pg.Pool, route: string, ipHash: string | null): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `select count(*) as n from request_log
     where route = $1 and outcome = 'admitted' and created_at > now() - interval '1 hour' and ($2::text is null or ip_hash = $2)`,
    [route, ipHash],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Records this request and answers whether it is within the hourly limit. Insert first, then count, so parallel requests cannot all slip under. */
async function withinHourlyLimit(pool: pg.Pool, route: string, ipHash: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const ins = await pool.query<{ id: string }>(`insert into request_log (ip_hash, route) values ($1, $2) returning id`, [ipHash, route]);
  const used = await admittedInLastHour(pool, route, ipHash);
  if (used > limit) {
    await pool.query(`update request_log set outcome = 'denied' where id = $1`, [ins.rows[0]?.id]);
    return false;
  }
  return true;
}

/** Gate for a route that can spend model money. Call before doing any work. */
export async function admitModelCall(pool: pg.Pool, req: Parameters<typeof clientIp>[0], route: ModelRoute): Promise<Admission> {
  const e = env();
  const summary = await usageSummary(pool);
  if (summary.capped) {
    log('warn', 'cap_reached', { route, reason: 'daily_cap', calls_today: summary.calls_today });
    return { ok: false, reason: 'daily_cap', message: summary.message ?? 'The live demo has reached its spend cap for today.' };
  }
  const ipHash = ipHashOf(req);
  // The limit counts every model route together, so one visitor cannot get the limit per route.
  const ok = await withinHourlyLimit(pool, 'model', ipHash, e.PER_IP_HOURLY_CALLS);
  if (!ok) {
    log('warn', 'ip_limit_reached', { route, limit: e.PER_IP_HOURLY_CALLS });
    return {
      ok: false,
      reason: 'ip_limit',
      message:
        e.PER_IP_HOURLY_CALLS <= 0
          ? 'Live model calls are switched off for this demo right now.'
          : `You have used the ${e.PER_IP_HOURLY_CALLS} live model calls allowed per hour from one address. Try again later.`,
    };
  }
  return { ok: true, ip_hash: ipHash };
}

function tokenMatches(given: unknown, expected: string | undefined): boolean {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Gate for Reset demo. A script holding DEMO_ADMIN_TOKEN skips the limits; everyone else is limited per IP and overall. */
export async function admitReset(pool: pg.Pool, req: Parameters<typeof clientIp>[0] & Pick<VercelRequest, 'headers'>): Promise<{ ok: true; admin: boolean } | { ok: false; message: string }> {
  if (tokenMatches(req.headers['x-admin-token'], env().DEMO_ADMIN_TOKEN)) return { ok: true, admin: true };
  if ((await admittedInLastHour(pool, 'reset', null)) >= RESET_GLOBAL_HOURLY) {
    return { ok: false, message: 'The demo was reset many times in the last hour. Wait a little before resetting again.' };
  }
  const ok = await withinHourlyLimit(pool, 'reset', ipHashOf(req), RESET_PER_IP_HOURLY);
  if (!ok) return { ok: false, message: `Reset demo is limited to ${RESET_PER_IP_HOURLY} times per hour from one address. Try again later.` };
  return { ok: true, admin: false };
}
