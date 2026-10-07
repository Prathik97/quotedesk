// The analyst chat. Answers stream in, tools run on the server, and every table, chart and
// download is rendered from a stored tool result, never from numbers the model typed.
import { MessageSquarePlus, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnswerView } from '@/components/analyst/AnswerView';
import { Btn, PageTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { applyEvent, emptyTurn, EXAMPLE_QUESTIONS, SESSION_KEY, streamTurn, type ChartPayload, type ExportChip, type FinalAnswer, type StoredResult, type Turn } from '@/lib/analyst';

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

export function Analyst() {
  const { selection } = useApp();
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
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, turns[turns.length - 1]?.steps.length, turns[turns.length - 1]?.final]);

  const ask = useCallback(
    async (q: string) => {
      const question = q.trim();
      if (!question || busy) return;
      const id = `t${Date.now()}`;
      setInput('');
      setBusy(true);
      setTurns((t) => [...t, emptyTurn(id, question)]);
      const ctl = new AbortController();
      abort.current = ctl;
      let sid = sessionId;
      try {
        await streamTurn(
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
        setTurns((all) => all.map((t) => (t.id === id && t.status === 'working' ? { ...t, status: 'error', error: 'The connection ended before the answer finished. Ask again.' } : t)));
      } catch (e) {
        const stopped = (e as Error).name === 'AbortError';
        setTurns((all) => all.map((t) => (t.id === id ? { ...t, status: 'error', error: stopped ? 'Stopped. Nothing was changed.' : 'The analyst could not be reached. Check that the server is running, then try again.' } : t)));
      } finally {
        setBusy(false);
        abort.current = null;
      }
    },
    [busy, sessionId],
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
        <div className="flex-1 space-y-5 pb-4" aria-live="polite">
          {loaded && turns.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Ask anything about the five quotes.</p>
              <p className="mx-auto mt-1 max-w-md">Try a question from the list on the right, or type your own. A follow up such as "now exclude Vendor 3" changes the last scenario.</p>
            </div>
          ) : null}
          {turns.map((t) => (
            <AnswerView key={t.id} turn={t} onAsk={(q) => void ask(q)} busy={busy} />
          ))}
          <div ref={bottom} />
        </div>
        <form
          className="sticky bottom-0 -mx-1 flex items-end gap-2 border-t border-border bg-background px-1 pt-3"
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
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            placeholder="Ask a question about the quotes"
            className="min-h-[3rem] flex-1 resize-none rounded-md border border-border bg-card px-3 py-2 text-sm"
          />
          {busy ? (
            <Btn variant="danger" onClick={() => abort.current?.abort()} aria-label="Stop the answer">
              <Square size={14} aria-hidden /> Stop
            </Btn>
          ) : (
            <Btn variant="primary" type="submit" disabled={!input.trim()}>
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
