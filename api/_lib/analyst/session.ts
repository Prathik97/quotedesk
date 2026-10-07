// Everything the analyst route needs around the agent loop: the system prompt, the saved chat
// state, and persistence of messages and results.
import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { DEFAULT_SCENARIO } from '../../../engine/award.js';
import { loadPrompt } from '../extract/model.js';
import type { AnalystData } from './data.js';
import { describeScenario } from './tools.js';
import type { ChartPayload, ExportChip, SessionState, StoredResult } from './types.js';

export const PROMPT_NAME = 'analyst.v1';

export function initialState(): SessionState {
  return { scenario: structuredClone(DEFAULT_SCENARIO), assumptions: {} };
}

/** The schema description: vendor keys and the line index. Static for a given dataset, so it is cached. */
export function contextText(data: AnalystData): string {
  const c = data.compare;
  const vendors = c.vendors.map((v) => `${v.key} ${v.name} (${v.location ?? 'location not stated'})`).join('\n');
  const lines = c.lines.map((l) => `${l.sort}. ${l.code} | ${l.section} | per ${l.uom} | ${l.description}`).join('\n');
  return [
    `RFx: ${c.rfx.title}. Buyer: ${c.rfx.buyer_org}.`,
    'Vendors:',
    vendors,
    'RFx lines (the number a user says, such as "lines 1 to 14", is the first column):',
    lines,
  ].join('\n');
}

export function systemBlocks(data: AnalystData): { blocks: Anthropic.TextBlockParam[]; contextText: string; promptVersion: string } {
  const p = loadPrompt(PROMPT_NAME);
  const ctx = contextText(data);
  return {
    blocks: [{ type: 'text', text: p.text }, { type: 'text', text: ctx, cache_control: { type: 'ephemeral' } }],
    contextText: ctx,
    promptVersion: p.version,
  };
}

export function describeState(s: SessionState): string {
  return describeScenario(s.scenario, s.assumptions);
}

export function describeStepLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (name) {
    case 'query_comparison': return `Querying the comparison${i.title ? `: ${String(i.title)}` : ''}`;
    case 'simulate_award': return `Running an award scenario${i.title ? `: ${String(i.title)}` : ''}`;
    case 'get_evidence': return `Reading the evidence${i.vendor && i.line_code ? ` for ${String(i.vendor)} ${String(i.line_code)}` : ''}`;
    case 'list_open_issues': return `Listing open issues${i.vendor ? ` for ${String(i.vendor)}` : ''}`;
    case 'get_assumptions': return 'Reading the assumptions';
    case 'set_scenario_assumption': return `Setting ${String(i.key)} to ${String(i.value)} for this scenario only`;
    case 'make_chart': return `Drawing a chart: ${String(i.title ?? '')}`;
    case 'export': return `Preparing a ${String(i.format ?? '')} export`;
    default: return name;
  }
}

export async function loadState(pool: pg.Pool, sessionId: string): Promise<SessionState | null> {
  const r = await pool.query<{ scenario: SessionState | null }>('select scenario from chat_sessions where id = $1', [sessionId]);
  if (r.rows.length === 0) return null;
  const s = r.rows[0]?.scenario;
  return s && s.scenario ? s : initialState();
}

export async function createSession(pool: pg.Pool): Promise<string> {
  const r = await pool.query<{ id: string }>(`insert into chat_sessions (kind, scenario) values ('analyst', $1) returning id`, [JSON.stringify(initialState())]);
  return (r.rows[0] as { id: string }).id;
}

export async function saveState(pool: pg.Pool, sessionId: string, s: SessionState): Promise<void> {
  await pool.query('update chat_sessions set scenario = $2 where id = $1', [sessionId, JSON.stringify(s)]);
}

export async function loadResults(pool: pg.Pool, sessionId: string): Promise<Map<string, StoredResult>> {
  const r = await pool.query<{ id: string; kind: StoredResult['kind']; title: string; payload: Pick<StoredResult, 'notes' | 'tables' | 'data'> }>(
    'select id, kind, title, payload from analyst_results where session_id = $1 order by created_at',
    [sessionId],
  );
  return new Map(r.rows.map((x) => [x.id, { id: x.id, kind: x.kind, title: x.title, notes: x.payload.notes, tables: x.payload.tables, data: x.payload.data }]));
}

export async function saveResults(pool: pg.Pool, sessionId: string, results: StoredResult[]): Promise<void> {
  for (const r of results) {
    await pool.query(
      `insert into analyst_results (session_id, id, kind, title, payload) values ($1,$2,$3,$4,$5)
       on conflict (session_id, id) do update set payload = excluded.payload, title = excluded.title`,
      [sessionId, r.id, r.kind, r.title, JSON.stringify({ notes: r.notes, tables: r.tables, data: r.data })],
    );
  }
}

export type StoredMessage = {
  role: 'user' | 'assistant';
  text: string;
  final: unknown | null;
  results: string[];
  charts: ChartPayload[];
  exports: ExportChip[];
};

export async function loadMessages(pool: pg.Pool, sessionId: string): Promise<StoredMessage[]> {
  const r = await pool.query<{ role: 'user' | 'assistant'; content: { text: string; final?: unknown }; meta: { results?: string[]; charts?: ChartPayload[]; exports?: ExportChip[] } | null }>(
    `select role, content, meta from chat_messages where session_id = $1 and role in ('user','assistant') order by created_at, id`,
    [sessionId],
  );
  return r.rows.map((m) => ({ role: m.role, text: m.content.text, final: m.content.final ?? null, results: m.meta?.results ?? [], charts: m.meta?.charts ?? [], exports: m.meta?.exports ?? [] }));
}

export async function saveMessage(pool: pg.Pool, sessionId: string, role: 'user' | 'assistant', content: unknown, toolCalls: unknown, meta: unknown): Promise<void> {
  await pool.query('insert into chat_messages (session_id, role, content, tool_calls, meta) values ($1,$2,$3,$4,$5)', [sessionId, role, JSON.stringify(content), toolCalls == null ? null : JSON.stringify(toolCalls), meta == null ? null : JSON.stringify(meta)]);
}
