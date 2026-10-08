// Client side helpers for the RFx co-pilot: the streaming call and the shapes the API returns.
import type { Finding, DraftRfx, Validation } from '../../engine/rfx';
import type { CopilotEvent, CopilotStep } from '../../api/_lib/copilot/agent';
import type { ChatMessage, DraftView } from '../../api/_lib/copilot/drafts';
import type { EmailView } from '../../api/_lib/routes/outbox';
import { browserId } from './browser';

export type { ChatMessage, CopilotEvent, CopilotStep, DraftRfx, DraftView, EmailView, Finding, Validation };
export type DraftWithEmails = DraftView & { emails: EmailView[] };
export type EmailDraftResponse = { subject: string; body: string; source: 'model' | 'template'; label: string; cost_inr: number; fallback: string | null; attachment: string };
export type OutboxResponse = {
  saved: { title: string; pack_url: string; emails: EmailView[] };
  drafts: { draft_id: string; title: string | null; issued_at: string | null; emails: EmailView[] }[];
};

export type Capped = { message: string; label: string };

/** Streams one co-pilot turn. Resolves with the cap details if the server refused the turn, otherwise null. */
export async function streamCopilot(draftId: string | null, message: string, onEvent: (e: CopilotEvent) => void, signal?: AbortSignal): Promise<Capped | null> {
  const res = await fetch('/api/copilot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ browser_id: browserId(), draft_id: draftId ?? undefined, message }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = 'The co-pilot could not be reached. Check that the server is running, then try again.';
    try {
      const j = (await res.json()) as { error?: string; message?: string; label?: string };
      if (j.message) msg = j.message;
      if (res.status === 429 && j.error === 'capped') return { message: msg, label: j.label ?? 'Showing stored results from an earlier live run' };
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
        onEvent(JSON.parse(line) as CopilotEvent);
      } catch {
        // ignore a malformed line
      }
    }
  }
  return null;
}

export const STARTER_BRIEFS = [
  'Annual rate contract for corrugated cartons, sheets and consumables for our Bengaluru plant.',
  'Annual contract for stretch film, BOPP tape and strapping for our Bengaluru plant and one regional warehouse.',
];
