import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientIp, hashIp } from './guard';

describe('ip handling', () => {
  it('takes the first forwarded address, then the real ip, then the socket', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } })).toBe('203.0.113.9');
    expect(clientIp({ headers: { 'x-real-ip': '198.51.100.2' } })).toBe('198.51.100.2');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '::1' } })).toBe('::1');
    expect(clientIp({ headers: {} })).toBe('unknown');
  });

  it('hashes with a salt: stable, not the address, different salt gives a different hash', () => {
    const h = hashIp('203.0.113.9', 'salt-a');
    expect(h).toBe(hashIp('203.0.113.9', 'salt-a'));
    expect(h).not.toContain('203');
    expect(h).toHaveLength(32);
    expect(hashIp('203.0.113.9', 'salt-b')).not.toBe(h);
    expect(hashIp('203.0.113.10', 'salt-a')).not.toBe(h);
  });
});

// A small in-memory stand in for the two tables the guard reads and writes.
function fakeDb(opts: { dayCost?: number } = {}) {
  const log: { id: string; ip: string; route: string; outcome: string }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/from usage_log/.test(sql) && /count\(\*\)/.test(sql)) return { rows: [{ n: '3', s: String(opts.dayCost ?? 0) }] };
      if (/sum\(est_cost_inr\) as s from usage_log where session_id/.test(sql)) return { rows: [{ s: '0' }] };
      if (/insert into request_log/.test(sql)) {
        log.push({ id: String(log.length + 1), ip: String(params[0]), route: String(params[1]), outcome: 'admitted' });
        return { rows: [{ id: String(log.length) }] };
      }
      if (/update request_log set outcome = 'denied'/.test(sql)) {
        const row = log.find((r) => r.id === params[0]);
        if (row) row.outcome = 'denied';
        return { rows: [] };
      }
      if (/select count\(\*\) as n from request_log/.test(sql)) {
        const n = log.filter((r) => r.route === params[0] && r.outcome === 'admitted' && (params[1] == null || r.ip === params[1])).length;
        return { rows: [{ n: String(n) }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  return { pool: pool as never, log };
}

function setEnv(over: Record<string, string>) {
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'k', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_DB_URL: 'postgres://x',
    DAILY_SPEND_CAP_INR: '500', PER_IP_HOURLY_CALLS: '2', DEFAULT_USD_INR: '96', DEFAULT_GST_PCT: '18', VERCEL: '1', ...over,
  });
}

describe('admission (hourly limit and spend cap), without any model call', () => {
  // env() caches its first parse, so each test loads a fresh copy of the modules.
  beforeEach(() => {
    vi.resetModules();
    delete process.env.DEMO_ADMIN_TOKEN;
  });

  it('allows the limit, refuses the next call from the same address, and still allows another address', async () => {
    const { admitModelCall } = await import('./guard');
    setEnv({ PER_IP_HOURLY_CALLS: '2' });
    const { pool, log } = fakeDb();
    const a = { headers: { 'x-forwarded-for': '203.0.113.9' } };
    expect((await admitModelCall(pool, a, 'analyst')).ok).toBe(true);
    expect((await admitModelCall(pool, a, 'extract')).ok).toBe(true);
    const third = await admitModelCall(pool, a, 'analyst');
    expect(third).toMatchObject({ ok: false, reason: 'ip_limit' });
    expect(log.filter((r) => r.outcome === 'denied')).toHaveLength(1);
    expect((await admitModelCall(pool, { headers: { 'x-forwarded-for': '203.0.113.10' } }, 'analyst')).ok).toBe(true);
    expect(JSON.stringify(log)).not.toContain('203.0.113');
  });

  it('refuses everything when the daily cap is 0, and writes no request row', async () => {
    const { admitModelCall } = await import('./guard');
    setEnv({ DAILY_SPEND_CAP_INR: '0' });
    const { pool, log } = fakeDb();
    expect(await admitModelCall(pool, { headers: {} }, 'analyst')).toMatchObject({ ok: false, reason: 'daily_cap' });
    expect(log).toHaveLength(0);
  });

  it('refuses everything when the hourly limit is 0', async () => {
    const { admitModelCall } = await import('./guard');
    setEnv({ PER_IP_HOURLY_CALLS: '0' });
    const { pool } = fakeDb();
    expect(await admitModelCall(pool, { headers: {} }, 'extract')).toMatchObject({ ok: false, reason: 'ip_limit' });
  });

  it('stops admitting when less than one analyst turn is left under the cap', async () => {
    const { admitModelCall } = await import('./guard');
    setEnv({ DAILY_SPEND_CAP_INR: '500' });
    expect((await admitModelCall(fakeDb({ dayCost: 480 }).pool, { headers: {} }, 'analyst')).ok).toBe(true);
    expect((await admitModelCall(fakeDb({ dayCost: 489 }).pool, { headers: {} }, 'analyst')).ok).toBe(false);
  });

  it('limits Reset demo per address, and lets a script with the admin token through', async () => {
    const { admitReset, RESET_PER_IP_HOURLY } = await import('./guard');
    setEnv({ DEMO_ADMIN_TOKEN: 'script-token' });
    const { pool } = fakeDb();
    const a = { headers: { 'x-forwarded-for': '203.0.113.9' } };
    for (let i = 0; i < RESET_PER_IP_HOURLY; i++) expect((await admitReset(pool, a)).ok).toBe(true);
    expect((await admitReset(pool, a)).ok).toBe(false);
    expect(await admitReset(pool, { headers: { ...a.headers, 'x-admin-token': 'wrong' } })).toMatchObject({ ok: false });
    expect(await admitReset(pool, { headers: { ...a.headers, 'x-admin-token': 'script-token' } })).toEqual({ ok: true, admin: true });
  });
});
