import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, callModel, type CallContext } from './call';
import { realClient, type LlmClient, type LlmRequest } from './client';
import { memoryStore } from './store';

const req: LlmRequest = { model: 'claude-sonnet-5-5', max_tokens: 1000, system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'hi' }] };
const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  stage: 'extract', route: 'test', prompt_version: 'extract.v1@x', document_sha256: 'abc', context_hash: 'h',
  document_id: null, run_id: null, session_id: 's1', fresh: false, estimated_input_tokens: 1000, ...over,
});
const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function fakeClient(): LlmClient & { calls: number } {
  const c = {
    calls: 0,
    async complete() {
      c.calls++;
      return { text: '{"ok":true}', stop_reason: 'end_turn', usage };
    },
  };
  return c;
}

describe('callModel', () => {
  it('refuses to build the real client inside tests', () => {
    expect(() => realClient()).toThrow(/Refusing/);
  });

  it('calls once, logs cost, then serves the stored real response from cache', async () => {
    const client = fakeClient();
    const store = memoryStore();
    const lines: string[] = [];
    const a = await callModel(req, ctx(), { client, store, log: (l) => lines.push(l) });
    expect(a.cache_hit).toBe(false);
    expect(a.cost_inr).toBeCloseTo(((1000 * 2 + 500 * 10) / 1e6) * 96, 10);
    const b = await callModel(req, ctx(), { client, store, log: (l) => lines.push(l) });
    expect(b.cache_hit).toBe(true);
    expect(b.cost_inr).toBe(0);
    expect(b.text).toBe(a.text);
    expect(client.calls).toBe(1);
    expect(lines[1]).toMatch(/^\[CACHE HIT\]/);
    expect(store.usage.map((u) => u.cache_hit)).toEqual([false, true]);
  });

  it('bypasses the cache when fresh', async () => {
    const client = fakeClient();
    const store = memoryStore();
    await callModel(req, ctx(), { client, store });
    const b = await callModel(req, ctx({ fresh: true }), { client, store });
    expect(b.cache_hit).toBe(false);
    expect(client.calls).toBe(2);
  });

  it('keys the cache on prompt version and model', async () => {
    const client = fakeClient();
    const store = memoryStore();
    await callModel(req, ctx(), { client, store });
    await callModel(req, ctx({ prompt_version: 'extract.v2@y' }), { client, store });
    await callModel({ ...req, model: 'claude-haiku-4-5-20251001' }, ctx(), { client, store });
    expect(client.calls).toBe(3);
  });

  it('refuses a call that would pass the session cap, before calling', async () => {
    const client = fakeClient();
    const store = memoryStore();
    store.usage.push({ route: 'x', stage: 'extract', model: 'm', usage, est_cost_inr: 299.9, session_id: 's1', run_id: null, document_id: null, cache_hit: false });
    await expect(callModel(req, ctx(), { client, store })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(client.calls).toBe(0);
  });

  it('counts other sessions separately and ignores cache hits in spend', async () => {
    const client = fakeClient();
    const store = memoryStore();
    store.usage.push({ route: 'x', stage: 'extract', model: 'm', usage, est_cost_inr: 299.9, session_id: 'other', run_id: null, document_id: null, cache_hit: false });
    store.usage.push({ route: 'x', stage: 'extract', model: 'm', usage, est_cost_inr: 500, session_id: 's1', run_id: null, document_id: null, cache_hit: true });
    await expect(callModel(req, ctx(), { client, store })).resolves.toMatchObject({ cache_hit: false });
  });

  it('cannot be raised above 300 by the environment', async () => {
    vi.stubEnv('SESSION_BUDGET_INR', '100000');
    const client = fakeClient();
    const store = memoryStore();
    store.usage.push({ route: 'x', stage: 'extract', model: 'm', usage, est_cost_inr: 299.95, session_id: 's1', run_id: null, document_id: null, cache_hit: false });
    await expect(callModel(req, ctx(), { client, store })).rejects.toBeInstanceOf(BudgetExceededError);
    vi.unstubAllEnvs();
  });

  it('does not cache a truncated response', async () => {
    const store = memoryStore();
    const client: LlmClient = { complete: async () => ({ text: '{"partial', stop_reason: 'max_tokens', usage }) };
    await callModel(req, ctx(), { client, store });
    expect(store.cache.size).toBe(0);
  });

  it('reserves in flight cost so parallel calls cannot jointly pass the cap', async () => {
    const store = memoryStore();
    // worst case of one call: 1000 in at 2.5/M + 1000 out at 10/M = 0.0125 USD = Rs 1.20
    store.usage.push({ route: 'x', stage: 'extract', model: 'm', usage, est_cost_inr: 298.0, session_id: 's1', run_id: null, document_id: null, cache_hit: false });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const client: LlmClient = { complete: async () => { await gate; return { text: '{}', stop_reason: 'end_turn', usage }; } };
    const first = callModel(req, ctx(), { client, store });
    await new Promise((r) => setTimeout(r, 0));
    await expect(callModel(req, ctx({ document_sha256: 'other' }), { client, store })).rejects.toBeInstanceOf(BudgetExceededError);
    release();
    await first;
  });
});
