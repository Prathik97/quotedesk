// The agent loop with a fake model. No test here can reach the real API: the real client throws under Vitest.
import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../llm/call.js';
import { memoryStore } from '../llm/store.js';
import { realAgentClient, type AgentClient, type AgentResponse } from './agentClient.js';
import { parseAnswer, plain, runTurn, TurnCapError, type AnalystEvent, type TurnDeps } from './agent.js';
import { initialState } from './session.js';
import type { ToolOutcome } from './types.js';

const usage = (i = 1000, o = 100, w = 0, r = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: w, cache_read_input_tokens: r });
const text = (t: string): AgentResponse => ({ content: [{ type: 'text', text: t, citations: null } as never], stop_reason: 'end_turn', usage: usage() });
const toolUse = (id: string, name = 'query_comparison', input: unknown = { sql: 'select 1' }): AgentResponse => ({
  content: [{ type: 'tool_use', id, name, input } as never], stop_reason: 'tool_use', usage: usage(),
});

function fakeClient(script: AgentResponse[]): AgentClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  let i = 0;
  return {
    requests,
    async stream(req, onText) {
      requests.push(req);
      const r = script[Math.min(i++, script.length - 1)] as AgentResponse;
      for (const b of r.content) if (b.type === 'text') onText(b.text);
      return r;
    },
  };
}

const okTool = (model: unknown = { rows: [{ total: 1234.5 }] }): ToolOutcome => ({ model, summary: 'ok', rows_used: 1, sql: 'select 1' });

function deps(client: AgentClient, over: Partial<TurnDeps> = {}) {
  const store = memoryStore();
  const d: TurnDeps = {
    client, store, model: 'claude-sonnet-5-5', budgetSession: 'budget', chatSession: 'chat',
    system: [{ type: 'text', text: 'system' }], tools: [{ name: 'query_comparison', description: 'd', input_schema: { type: 'object' } }, { name: 'export', description: 'd', input_schema: { type: 'object' } }],
    contextText: '1. CRT-5P-01 | Cartons', runTool: async () => okTool(), describeStep: (n) => n, describeScenario: () => 'default', getState: () => initialState(), ...over,
  };
  return { d, store };
}

const run = async (d: TurnDeps, q = 'How much?') => {
  const events: AnalystEvent[] = [];
  const out = await runTurn(d, { question: q, history: [] }, (e) => events.push(e));
  return { out, events };
};

describe('runTurn', () => {
  it('runs a tool, then answers, and logs usage for every model call', async () => {
    const { d, store } = deps(fakeClient([toolUse('t1'), text('The total is 1,234.50.\n<callout>Relies on 0 Assumed cells.</callout>')]));
    const { out, events } = await run(d);
    expect(out.final.body).toBe('The total is 1,234.50.');
    expect(out.final.callout).toMatch(/Relies on/);
    expect(out.final.warnings).toEqual([]);
    expect(out.final.usage.model_calls).toBe(2);
    expect(store.usage).toHaveLength(2);
    expect(store.usage.every((u) => u.route === 'api:analyst' && u.run_id === 'chat' && !u.cache_hit)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['step', 'text_reset', 'text', 'final']));
    expect(out.final.how.steps[0]).toMatchObject({ tool: 'query_comparison', sql: 'select 1', rows_used: 1 });
  });

  it('flags a figure that no tool produced and logs the check as failed', async () => {
    const { d } = deps(fakeClient([toolUse('t1'), text('The saving is 999.99.\n<callout>Relies on nothing assumed.</callout>')]));
    const { out } = await run(d);
    expect(out.check.ok).toBe(false);
    expect(out.final.warnings.join(' ')).toMatch(/not found in any tool result/);
    expect(out.final.number_check.unmatched).toEqual(['999.99']);
  });

  it('accepts a figure copied from a tool result in lakh form', async () => {
    const { d } = deps(fakeClient([toolUse('t1'), text('That is ₹12.35 lakh.\n<callout>None assumed.</callout>')]), { runTool: async () => okTool({ total_inr: 1234567.8 }) });
    const { out } = await run(d);
    expect(out.check.ok).toBe(true);
  });

  it('warns when data was used but the answer has no uncertainty statement', async () => {
    const { d } = deps(fakeClient([toolUse('t1'), text('The total is 1,234.50.')]));
    const { out } = await run(d);
    expect(out.final.warnings.join(' ')).toMatch(/does not say how many of the cells/);
  });

  it('stops at 8 tool calls, answers the 9th request with an error result and forces an answer', async () => {
    const script: AgentResponse[] = [];
    for (let i = 0; i < 9; i++) script.push(toolUse(`t${i}`));
    script.push(text('Done.\n<callout>None.</callout>'));
    const client = fakeClient(script);
    let executed = 0;
    const { d } = deps(client, { runTool: async () => (executed++, okTool()) });
    const { out } = await run(d);
    expect(executed).toBe(8);
    expect(out.final.body).toBe('Done.');
    const last = client.requests[client.requests.length - 1] as { tool_choice?: { type: string }; messages: { content: unknown }[] };
    expect(last.tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(last.messages)).toContain('Tool call limit of 8');
  });

  it('sets max_tokens, a cache breakpoint on the system context, and one rolling breakpoint on messages', async () => {
    const client = fakeClient([toolUse('t1'), text('Done.\n<callout>None.</callout>')]);
    const { d } = deps(client, { system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] });
    await run(d);
    for (const r of client.requests as { max_tokens: number; messages: { content: unknown }[]; tools: { cache_control?: unknown }[] }[]) {
      expect(r.max_tokens).toBe(2500);
      expect(JSON.stringify(r.messages).match(/cache_control/g)?.length).toBe(1);
      expect(r.tools[r.tools.length - 1]?.cache_control).toBeTruthy();
    }
  });

  it('refuses a call that would pass the per turn cap', async () => {
    // 60k input tokens at the cache write rate plus 2500 output is above Rs 12.
    const big = 'x'.repeat(60000 * 3.2);
    const { d } = deps(fakeClient([text('hi')]), { contextText: '', system: [{ type: 'text', text: big }] });
    await expect(run(d)).rejects.toBeInstanceOf(TurnCapError);
  });

  it('refuses a call that would pass the session budget', async () => {
    const { d, store } = deps(fakeClient([text('hi')]));
    await store.logUsage({ route: 'x', stage: 'x', model: 'm', usage: usage(), est_cost_inr: 299.99, session_id: 'budget', run_id: null, document_id: null, cache_hit: false });
    await expect(run(d)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('a tool error is passed to the model as an error result and the turn continues', async () => {
    const client = fakeClient([toolUse('t1'), text('I could not run that.\n<callout>Nothing relied on.</callout>')]);
    const { d } = deps(client, { runTool: async () => ({ model: { error: 'bad sql' }, summary: 'bad sql', error: true }) });
    const { out } = await run(d);
    expect(out.steps[0]?.status).toBe('error');
    expect(JSON.stringify((client.requests[1] as { messages: unknown }).messages)).toContain('is_error');
  });

  it('puts the scenario in force in front of the question so a follow up can change only what it names', async () => {
    const client = fakeClient([text('ok')]);
    const { d } = deps(client, { describeScenario: () => 'strategy cheapest_per_line; excluding V3' });
    await run(d, 'now exclude Vendor 3');
    expect(JSON.stringify((client.requests[0] as { messages: unknown }).messages)).toContain('<scenario_in_force>strategy cheapest_per_line; excluding V3</scenario_in_force>');
  });
});

describe('prior results', () => {
  it('lists earlier results in the user message and counts their figures as sourced', async () => {
    const client = fakeClient([text('The first scenario total was ₹3.90 crore.\n<callout>None.</callout>')]);
    const { d } = deps(client);
    const events: AnalystEvent[] = [];
    const out = await runTurn(d, { question: 'Export it', history: [], priorResults: 'r1 (award): Cleared only. Goods total ₹3.90 crore, 30 of 30 lines awarded.' }, (e) => events.push(e));
    expect(JSON.stringify((client.requests[0] as { messages: unknown }).messages)).toContain('<prior_results>\\nr1 (award)');
    expect(out.check.ok).toBe(true);
  });
});

describe('parseAnswer and style', () => {
  it('splits the callout and the alternative chips from the body', () => {
    const a = parseAnswer('Body text.\n<callout>Note.</callout>\n<alternatives>[{"label":"Also pending","question":"Include pending vendors"}]</alternatives>');
    expect(a).toEqual({ body: 'Body text.', callout: 'Note.', alternatives: [{ label: 'Also pending', question: 'Include pending vendors' }] });
  });
  it('drops a malformed alternatives block instead of showing it', () => {
    expect(parseAnswer('Hi.<alternatives>not json</alternatives>').alternatives).toEqual([]);
  });
  it('regroups western digit grouping as Indian grouping and leaves everything else alone', () => {
    expect(plain('₹1,843,200 and 12,345,678.50 but 4,01,29,300 and 39,812 and 1,234.5')).toBe('₹18,43,200 and 1,23,45,678.50 but 4,01,29,300 and 39,812 and 1,234.5');
    expect(plain('₹39081449.12 and ₹299500 and ₹87.46 lakh and ₹1234')).toBe('₹3,90,81,449.12 and ₹2,99,500 and ₹87.46 lakh and ₹1234');
  });
  it('removes em and en dashes from copy', () => {
    expect(plain('Cheapest \u2014 but not cleared. Range 5\u201310.')).toBe('Cheapest, but not cleared. Range 5 to 10.');
  });
});

describe('cost safeguards', () => {
  it('the real client cannot be created inside a test', () => {
    expect(() => realAgentClient()).toThrow(/Refusing to create the real Anthropic client/);
  });
});
