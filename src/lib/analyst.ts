// Client side helpers for the analyst chat: the streaming call and value formatting.
import type { AnalystEvent, FinalAnswer } from '../../api/_lib/analyst/agent';
import type { ChartPayload, ExportChip, StoredResult } from '../../api/_lib/analyst/types';
import { formatIndian, formatQty } from '../../engine/format';

export type { AnalystEvent, ChartPayload, ExportChip, FinalAnswer, StoredResult };

export type Step = { id: string; tool: string; label: string; status: 'running' | 'done' | 'error'; summary?: string };

export type Turn = {
  id: string;
  question: string;
  status: 'working' | 'done' | 'error';
  text: string;
  steps: Step[];
  results: StoredResult[];
  charts: ChartPayload[];
  exports: ExportChip[];
  final: FinalAnswer | null;
  error: string | null;
};

export const SESSION_KEY = 'quotedesk.analyst.session';

export function emptyTurn(id: string, question: string): Turn {
  return { id, question, status: 'working', text: '', steps: [], results: [], charts: [], exports: [], final: null, error: null };
}

export function applyEvent(t: Turn, e: AnalystEvent): Turn {
  switch (e.type) {
    case 'text':
      return { ...t, text: t.text + e.delta };
    case 'text_reset':
      return { ...t, text: '' };
    case 'step': {
      const i = t.steps.findIndex((s) => s.id === e.id);
      const next: Step = { id: e.id, tool: e.tool, label: e.label, status: e.status, summary: e.summary };
      return { ...t, steps: i < 0 ? [...t.steps, next] : t.steps.map((s, k) => (k === i ? next : s)) };
    }
    case 'result':
      return { ...t, results: [...t.results.filter((r) => r.id !== e.result.id), e.result] };
    case 'chart':
      return { ...t, charts: [...t.charts, e.chart] };
    case 'export':
      return { ...t, exports: [...t.exports, e.chip] };
    case 'final':
      return { ...t, final: e.answer, status: 'done', text: '' };
    case 'error':
      return { ...t, status: 'error', error: e.message };
    default:
      return t;
  }
}

export type Capped = { reason: string; message: string; label: string };

/** Streams one turn. Resolves with the cap details if the server refused the turn because of a cap, otherwise with null. */
export async function streamTurn(sessionId: string | null, message: string, onEvent: (e: AnalystEvent) => void, signal?: AbortSignal): Promise<Capped | null> {
  const res = await fetch('/api/analyst', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId ?? undefined, message }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = 'The analyst could not be reached. Check that the server is running, then try again.';
    try {
      const j = (await res.json()) as { error?: string; message?: string; reason?: string; label?: string };
      if (j.message) msg = j.message;
      if (res.status === 429 && j.error === 'capped') return { reason: j.reason ?? 'daily_cap', message: msg, label: j.label ?? 'Showing stored results from an earlier live run' };
    } catch {
      // keep the generic message
    }
    onEvent({ type: 'error', message: msg });
    return null;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as AnalystEvent);
      } catch {
        // ignore a malformed line
      }
    }
  }
  return null;
}

export function formatCell(type: string, v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v !== 'number') return String(v);
  switch (type) {
    case 'inr':
    case 'inr_unit':
    case 'num':
      return formatIndian(v, 2);
    case 'pct':
      return `${v.toFixed(1)}%`;
    case 'int':
      return formatQty(v);
    default:
      return String(v);
  }
}

/** Axis and tooltip formats for a chart unit. */
export function axisFormat(unit: ChartPayload['unit'], v: number): string {
  if (unit === 'inr') {
    const a = Math.abs(v);
    if (a >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${(v / 1e5).toFixed(1)} L`;
    return formatIndian(v, 0);
  }
  if (unit === 'pct') return `${v}%`;
  return formatIndian(v, Number.isInteger(v) ? 0 : 2);
}

export function tooltipFormat(unit: ChartPayload['unit'], v: number): string {
  if (unit === 'inr') return `₹${formatIndian(v, 2)}`;
  if (unit === 'pct') return `${v}%`;
  return formatIndian(v, Number.isInteger(v) ? 0 : 2);
}

export const EXAMPLE_QUESTIONS = [
  'Give me a one paragraph summary of where each vendor stands: coverage, questionnaire result, and anything I should worry about.',
  'What if we split the award, cheapest per line, but only among vendors who cleared the quality questionnaire?',
  'Which three lines have the biggest price spread between vendors, and what explains it?',
  'Sunrise looks cheapest. What is it actually costing us to exclude them, and is there any way to include them safely?',
  'How exposed is the award to the USD rate? Show what happens to total cost if the rate moves to 85 and 92.',
  "If Kaveri's 4 percent discount applies, what PO split makes the threshold work, and does it change the winner on lines 1 to 14?",
  'Show me every number in this award that is not confirmed, ranked by rupees at stake. Export it.',
  'Draft the approval note for my VP and list what must be resolved before a PO goes out.',
];
