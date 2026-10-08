// The analyst chat. Answers stream in, tools run on the server, and every table, chart and
// download is rendered from a stored tool result, never from numbers the model typed.
import { Database, MessageSquarePlus, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnswerView } from '@/components/analyst/AnswerView';
import { Btn, PageTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { applyEvent, emptyTurn, EXAMPLE_QUESTIONS, SESSION_KEY, streamTurn, type Capped, type ChartPayload, type ExportChip, type FinalAnswer, type StoredResult, type Turn } from '@/lib/analyst';

type Saved = { role: 'user' | 'assistant'; text: string; final: FinalAnswer | null; results: string[]; charts: ChartPayload[]; exports: ExportChip[] };
type Restore = { session_id: string | null; messages: Saved[]; results: StoredResult[] };

function restoreTurns(r: Restore): Turn[] {
  const byId = new Map(r.results.map((x) => [x.id, x]));
  const turns: Turn[] = [];
  let q: string | null = null;
  for (const m of r.messages) {
    if (m.role === 'user') {
      q = m.text;
      continue;
    }
    if (q == null) continue;
    const t = emptyTurn(`restored-${turns.length}`, q);
    t.status = m.final ? 'done' : 'error';
    t.final = m.final;
    t.error = m.final ? null : 'This answer did not finish.';
    t.results = m.results.map((id) => byId.get(id)).filter((x): x is StoredResult => !!x);
    t.charts = m.charts;
    t.exports = m.exports;
    turns.push(t);
    q = null;
  }
  return turns;
}

type StoredRun = { session_id: string; question: string; created_at: string };
const STORED_LABEL = 'Showing stored results from an earlier live run';

export function Analyst() {
  const { selection, usage, refreshUsage } = useApp();
  // A refusal for this visitor (hourly limit) or for everyone (spend cap). Either way, stored runs are offered.
  const [refused, setRefused] = useState<Capped | null>(null);
  const [stored, setStored] = useState<StoredRun[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const capped = !!usage?.capped || refused !== null;
  const blockedMessage = refused?.message ?? usage?.message ?? null;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let id: string | null = null;
    try {
      id = localStorage.getItem(SESSION_KEY);
    } catch {
      // storage unavailable: start fresh
    }
    if (!id) {
      setLoaded(true);
      return;
    }
    api<Restore>(`analyst?session_id=${id}`)
      .then((r) => {
        setSessionId(r.session_id);
        setTurns(restoreTurns(r));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!capped || stored) return;
    api<{ sessions: StoredRun[] }>('analyst?stored=1')
      .then((r) => setStored(r.sessions))
      .catch(() => setStored([]));
  }, [capped, stored]);

  const openStored = (run: StoredRun) => {
    api<Restore>(`analyst?session_id=${run.session_id}`)
      .then((r) => {
        setTurns(restoreTurns(r));
        setViewing(run.session_id);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    // A stored run opens at its top; only a live answer follows the stream to the bottom.
    if (viewing) return;
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [viewing, turns.length, turns[turns.length - 1]?.steps.length, turns[turns.length - 1]?.final]);

  const ask = useCallback(
    async (q: string) => {
      const question = q.trim();
      if (!question || busy || capped) return;
      const id = `t${Date.now()}`;
      setInput('');
      setBusy(true);
      // A stored run is read only: asking something new starts a fresh live chat.
      const fresh = viewing !== null;
      if (fresh) setViewing(null);
      setTurns((t) => [...(fresh ? [] : t), emptyTurn(id, question)]);
      const ctl = new AbortController();
      abort.current = ctl;
      let sid = fresh ? null : sessionId;
      try {
        const refusal = await streamTurn(
          sid,
          question,
          (e) => {
            if (e.type === 'session') {
              sid = e.session_id;
              setSessionId(e.session_id);
              try {
                localStorage.setItem(SESSION_KEY, e.session_id);
              } catch {
                // storage unavailable: the chat still works for this tab
              }
            }
            setTurns((all) => all.map((t) => (t.id === id ? applyEvent(t, e) : t)));
          },
          ctl.signal,
        );
        if (refusal) {
          // Nothing ran. Take the empty turn back out and show the stored runs instead.
          setTurns((all) => all.filter((t) => t.id !== id));
          setInput(question);
          setRefused(refusal);
          return;
        }
        setTurns((all) => all.map((t) => (t.id === id && t.status === 'working' ? { ...t, status: 'error', error: 'The connection ended before the answer finished. Ask again.' } : t)));
      } catch (e) {
        const stopped = (e as Error).name === 'AbortError';
        setTurns((all) => all.map((t) => (t.id === id ? { ...t, status: 'error', error: stopped ? 'Stopped. Nothing was changed.' : 'The analyst could not be reached. Check that the server is running, then try again.' } : t)));
      } finally {
        setBusy(false);
        abort.current = null;
        void refreshUsage();
      }
    },
    [busy, capped, sessionId, refreshUsage, viewing],
  );

  const newChat = () => {
    abort.current?.abort();
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // nothing to clear
    }
    setSessionId(null);
    setTurns([]);
    setViewing(null);
  };

  return (
    <div className="flex min-h-full gap-5">
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Analyst chat">
        <PageTitle
          title="Analyst"
          sub="Ask about the comparison in plain language. Every number comes from a tool, and every answer says how much of it is assumed."
          right={
            <Btn small onClick={newChat} disabled={turns.length === 0 && !busy}>
              <MessageSquarePlus size={13} aria-hidden /> New chat
            </Btn>
          }
        />
        {capped ? (
          <div role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium text-status-assumed">
              <Database size={14} aria-hidden /> {STORED_LABEL}
            </p>
            <p className="mt-1 text-foreground">{blockedMessage ?? 'New questions are paused.'}</p>
            {stored && stored.length > 0 ? (
              <>
                <p className="mt-2 text-xs text-muted-foreground">These are real answers from earlier live runs, with the tool results they were built from. Open one to read it.</p>
                <ul className="mt-1.5 max-h-44 space-y-1 overflow-auto">
                  {stored.map((r) => (
                    <li key={r.session_id}>
                      <button
                        type="button"
                        aria-current={viewing === r.session_id ? 'true' : undefined}
                        onClick={() => openStored(r)}
                        className={cn('w-full rounded-md border border-border bg-card px-2 py-1.5 text-left text-xs hover:bg-muted', viewing === r.session_id && 'border-accent')}
                      >
                        {r.question}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {refused && !usage?.capped ? (
              <Btn small className="mt-2" onClick={() => setRefused(null)}>
                Try again
              </Btn>
            ) : null}
          </div>
        ) : null}
        <div className="flex-1 space-y-5 pb-6" aria-live="polite">
          {loaded && turns.length === 0 && !capped ? (
            <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Ask anything about the five quotes.</p>
              <p className="mx-auto mt-1 max-w-md">Try a question from the list on the right, or type your own. A follow up such as "now exclude Vendor 3" changes the last scenario.</p>
            </div>
          ) : null}
          {turns.map((t) => (
            <AnswerView key={t.id} turn={t} onAsk={(q) => void ask(q)} busy={busy || capped} />
          ))}
          {/* scroll-mb reserves the height of the sticky input bar, so scrolling to the end never leaves the last answer behind it. */}
          <div ref={bottom} className="scroll-mb-28" aria-hidden />
        </div>
        <form
          className="sticky bottom-0 z-10 -mx-1 flex items-end gap-2 border-t border-border bg-background px-1 pb-2 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <label htmlFor="analyst-input" className="sr-only">
            Your question
          </label>
          <textarea
            ref={box}
            id="analyst-input"
            value={input}
            rows={2}
            maxLength={1500}
            disabled={capped}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            placeholder={capped ? 'New questions are paused. Open a stored run above.' : 'Ask a question about the quotes'}
            className="min-h-[3rem] flex-1 resize-none rounded-md border border-border bg-card px-3 py-2 text-sm"
          />
          {busy ? (
            <Btn variant="danger" onClick={() => abort.current?.abort()} aria-label="Stop the answer">
              <Square size={14} aria-hidden /> Stop
            </Btn>
          ) : (
            <Btn variant="primary" type="submit" disabled={!input.trim() || capped}>
              <Send size={14} aria-hidden /> Ask
            </Btn>
          )}
        </form>
      </section>

      {/* The examples step aside while the evidence drawer is open, so the chat keeps its width. */}
      <aside className={cn('hidden w-72 shrink-0 lg:block', selection && 'lg:hidden')} aria-label="Example questions">
        <div className="sticky top-0 rounded-lg border border-border bg-card p-3">
          <h2 className="text-sm font-semibold">Example questions</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Examples only. Click one to put it in the box, edit it if you like, then ask. You can ask your own.</p>
          <ul className="mt-2 space-y-1.5">
            {EXAMPLE_QUESTIONS.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  className="w-full rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-muted"
                  disabled={capped}
                  onClick={() => {
                    setInput(q);
                    box.current?.focus();
                  }}
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
