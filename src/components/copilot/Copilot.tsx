// "Draft with the co-pilot": chat on the left, the live structured RFx on the right, and the Issue flow.
// The draft belongs to this browser only (a random id). The seeded FY27 RFx is never touched from here.
import { Database, Mail, Plus, Send, Square, Wrench } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyRfx, validateRfx, type DraftRfx } from '../../../engine/rfx';
import { RfxEditor } from '@/components/copilot/RfxEditor';
import { Btn, Chip, ErrorBox, Loading } from '@/components/ui';
import { api, ApiFailure } from '@/lib/api';
import { browserId } from '@/lib/browser';
import { STARTER_BRIEFS, streamCopilot, type ChatMessage, type CopilotStep, type DraftWithEmails, type EmailDraftResponse } from '@/lib/copilot';
import { useApp } from '@/lib/store';

type Turn = { id: string; question: string; text: string; steps: CopilotStep[]; running: string | null; status: 'working' | 'done' | 'error'; error: string | null; cost: number | null };

function restore(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let q: string | null = null;
  for (const m of messages) {
    if (m.role === 'user') q = m.text;
    else if (q != null) {
      turns.push({ id: `r${turns.length}`, question: q, text: m.text, steps: m.steps ?? [], running: null, status: 'done', error: null, cost: m.cost_inr ?? null });
      q = null;
    }
  }
  return turns;
}

export function Copilot({ onOpenOutbox }: { onOpenOutbox: () => void }) {
  const { refreshUsage, notify } = useApp();
  const [draft, setDraft] = useState<DraftWithEmails | null>(null);
  const [rfx, setRfx] = useState<DraftRfx>(emptyRfx());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [email, setEmail] = useState<(EmailDraftResponse & { loading?: false }) | 'loading' | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const draftId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ draft: DraftWithEmails | null }>(`rfx-draft?browser_id=${browserId()}`);
      setDraft(r.draft);
      draftId.current = r.draft?.id ?? null;
      setRfx(r.draft?.rfx ?? emptyRfx());
      setTurns(r.draft ? restore(r.draft.messages) : []);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, turns[turns.length - 1]?.text, turns[turns.length - 1]?.steps.length]);

  const issued = draft?.status === 'issued';
  const validation = validateRfx(rfx);

  // Direct edits: show at once, save shortly after the last keystroke.
  const edit = (next: DraftRfx) => {
    setRfx(next);
    setSaveState('saving');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const id = draftId.current;
      const body = { action: 'save', browser_id: browserId(), draft_id: id, rfx: next };
      const run = async () => {
        let did = id;
        if (!did) {
          const created = await api<{ draft: DraftWithEmails }>('rfx-draft', { method: 'POST', body: { action: 'new', browser_id: browserId() } });
          did = created.draft.id;
          draftId.current = did;
          setDraft(created.draft);
        }
        await api('rfx-draft', { method: 'POST', body: { ...body, draft_id: did } });
        setSaveState('saved');
        setSaveError(null);
      };
      pending.current = run().catch((e: Error) => {
        setSaveState('error');
        setSaveError(e.message);
      });
    }, 700);
  };

  const flush = async () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    await pending.current;
  };

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy || issued) return;
      await flush();
      const id = `t${Date.now()}`;
      setInput('');
      setBusy(true);
      setRefused(null);
      setTurns((t) => [...t, { id, question: q, text: '', steps: [], running: null, status: 'working', error: null, cost: null }]);
      const ctl = new AbortController();
      abort.current = ctl;
      const patch = (f: (t: Turn) => Turn) => setTurns((all) => all.map((t) => (t.id === id ? f(t) : t)));
      try {
        const cap = await streamCopilot(
          draftId.current,
          q,
          (e) => {
            if (e.type === 'session') {
              draftId.current = e.draft_id;
            } else if (e.type === 'text') patch((t) => ({ ...t, text: t.text + e.delta }));
            else if (e.type === 'text_reset') patch((t) => ({ ...t, text: '' }));
            else if (e.type === 'step') {
              if (e.status === 'running') patch((t) => ({ ...t, running: e.label }));
              else patch((t) => ({ ...t, running: null, steps: [...t.steps, { tool: e.tool, label: e.label, summary: e.summary ?? '', error: e.status === 'error' }] }));
            } else if (e.type === 'draft') setRfx(e.rfx);
            else if (e.type === 'final') patch((t) => ({ ...t, text: e.text, status: 'done', running: null, cost: e.usage.cost_inr }));
            else if (e.type === 'error') patch((t) => ({ ...t, status: 'error', error: e.message, running: null }));
          },
          ctl.signal,
        );
        if (cap) {
          setTurns((all) => all.filter((t) => t.id !== id));
          setInput(q);
          setRefused(cap.message);
        } else {
          patch((t) => (t.status === 'working' ? { ...t, status: 'error', error: 'The connection ended before the reply finished. Your RFx keeps the changes already shown.' } : t));
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') patch((t) => ({ ...t, status: 'error', error: 'The co-pilot could not be reached. Try again.', running: null }));
        else patch((t) => ({ ...t, status: 'error', error: 'Stopped. Changes already shown are kept.', running: null }));
      } finally {
        abort.current = null;
        setBusy(false);
        void refreshUsage();
        void load().catch(() => undefined);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, issued, load, refreshUsage],
  );

  const startNew = async () => {
    if (issued || (rfx.lines.length === 0 && turns.length === 0) || window.confirm('Start a new blank draft? The current draft is discarded.')) {
      const old = draftId.current;
      if (old && !issued) await api('rfx-draft', { method: 'POST', body: { action: 'discard', browser_id: browserId(), draft_id: old } }).catch(() => undefined);
      draftId.current = null;
      setDraft(null);
      setRfx(emptyRfx());
      setTurns([]);
      setEmail(null);
      setSaveState('saved');
    }
  };

  const prepareEmail = async (mode: 'model' | 'template') => {
    await flush();
    if (!draftId.current) return;
    setEmail('loading');
    setEmailError(null);
    try {
      const r = await api<EmailDraftResponse>('rfx-draft', { method: 'POST', body: { action: 'email', browser_id: browserId(), draft_id: draftId.current, mode } });
      setEmail(r);
    } catch (e) {
      setEmail(null);
      setEmailError((e as ApiFailure).message);
    } finally {
      void refreshUsage();
    }
  };

  const issue = async () => {
    if (!email || email === 'loading' || !draftId.current) return;
    setIssuing(true);
    try {
      const r = await api<{ draft: DraftWithEmails }>('rfx-draft', { method: 'POST', body: { action: 'issue', browser_id: browserId(), draft_id: draftId.current, subject: email.subject, body: email.body, source: email.source } });
      setDraft(r.draft);
      setEmail(null);
      notify('success', 'RFx issued. Five simulated emails are in the Outbox. Nothing left the system.');
    } catch (e) {
      setEmailError((e as ApiFailure).message);
    } finally {
      setIssuing(false);
    }
  };

  if (loadError) return <ErrorBox message={loadError} onRetry={() => void load()} />;
  if (!loaded) return <Loading what="your draft" />;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(320px,2fr)_3fr]" style={{ minHeight: 'calc(100vh - 17rem)' }}>
      <section aria-label="Co-pilot chat" className="flex min-h-[28rem] flex-col rounded-lg border border-border bg-card xl:sticky xl:top-0 xl:max-h-[calc(100vh-11rem)]">
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">Co-pilot</h2>
          <span className="text-[11px] text-muted-foreground">It edits your draft through tools. It never sees vendor documents.</span>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 pb-6" aria-live="polite">
          {turns.length === 0 ? (
            <div className="space-y-2 text-sm">
              <p>Describe what you want to buy. I will draft sections, line items, a questionnaire and terms in one go, as defaults for you to correct.</p>
              <p className="text-xs text-muted-foreground">Examples, not scripts. Edit them or write your own.</p>
              {STARTER_BRIEFS.map((b) => (
                <button key={b} type="button" onClick={() => setInput(b)} className="block w-full rounded-md border border-border bg-muted/50 px-3 py-2 text-left text-sm hover:bg-muted">{b}</button>
              ))}
            </div>
          ) : null}
          {turns.map((t) => (
            <div key={t.id} className="space-y-1.5">
              <p className="ml-6 rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground">{t.question}</p>
              {t.steps.length > 0 || t.running ? (
                <ul className="space-y-0.5 pl-1 text-xs text-muted-foreground" aria-label="Tool calls">
                  {t.steps.map((s, i) => (
                    <li key={i} className="flex items-center gap-1.5"><Wrench size={11} aria-hidden /> <span className={s.error ? 'text-status-conflict' : ''}>{s.label}: {s.summary}</span></li>
                  ))}
                  {t.running ? <li className="flex items-center gap-1.5"><Wrench size={11} aria-hidden /> {t.running}...</li> : null}
                </ul>
              ) : null}
              {t.text ? <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-sm">{t.text}</p> : t.status === 'working' && !t.running ? <p className="px-1 text-xs text-muted-foreground">Thinking...</p> : null}
              {t.error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-status-conflict">{t.error}</p> : null}
              {t.status === 'done' && t.cost != null && t.cost > 0 ? <p className="pl-1 text-[11px] text-muted-foreground">This turn cost about Rs {t.cost.toFixed(2)}.</p> : null}
            </div>
          ))}
          <div ref={bottom} className="scroll-mb-24" />
        </div>
        {refused ? (
          <div role="alert" className="mx-3 mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-status-assumed">
            <Database size={12} className="mr-1 inline" aria-hidden /> {refused} You can still edit every cell by hand and issue with the template email.
          </div>
        ) : null}
        <form
          className="border-t border-border bg-card p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <label className="sr-only" htmlFor="copilot-input">Message to the co-pilot</label>
          <div className="flex items-end gap-2">
            <textarea
              id="copilot-input" rows={2} value={input} maxLength={2000} disabled={busy || issued}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={issued ? 'This RFx is issued. Start a new draft to keep going.' : 'Describe what you buy, or ask for a change'}
              className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border bg-card px-2 py-1.5 text-sm disabled:opacity-60"
            />
            {busy ? (
              <Btn onClick={() => abort.current?.abort()}><Square size={14} aria-hidden /> Stop</Btn>
            ) : (
              <Btn variant="primary" type="submit" disabled={!input.trim() || issued}><Send size={14} aria-hidden /> Send</Btn>
            )}
          </div>
        </form>
      </section>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Chip tone={issued ? 'good' : 'neutral'}>{issued ? 'Issued, final' : 'Draft'}</Chip>
            <span className="text-xs text-muted-foreground">
              {issued ? 'Simulated dispatch. Nothing left the system.' : saveState === 'saving' ? 'Saving...' : saveState === 'error' ? `Not saved: ${saveError ?? 'try again'}` : 'Saved to this browser\'s draft'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Btn small onClick={() => void startNew()} disabled={busy}><Plus size={12} aria-hidden /> New draft</Btn>
            {issued ? (
              <Btn small variant="primary" onClick={onOpenOutbox}><Mail size={12} aria-hidden /> View outbox</Btn>
            ) : (
              <Btn small variant="primary" disabled={!validation.can_issue || busy || email === 'loading'} title={validation.can_issue ? 'Draft the covering email, then issue' : `Fix ${validation.errors} ${validation.errors === 1 ? 'error' : 'errors'} first`} onClick={() => void prepareEmail('model')}>
                <Mail size={12} aria-hidden /> Issue RFx
              </Btn>
            )}
          </div>
        </div>
        {!issued && !validation.can_issue && rfx.lines.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm">
            <span>Issue is blocked: {validation.errors} {validation.errors === 1 ? 'error' : 'errors'} to fix. Edit the cells, or let the co-pilot propose fixes.</span>
            <Btn small disabled={busy} onClick={() => void send('Please fix the validation errors with sensible defaults, tell me what you assumed, and run validate_rfx.')}>Ask the co-pilot to fix them</Btn>
          </div>
        ) : null}

        {emailError ? <ErrorBox message={emailError} /> : null}
        {email ? <EmailStep email={email} issuing={issuing} onChange={(e) => setEmail(e)} onIssue={() => void issue()} onCancel={() => setEmail(null)} onTemplate={() => void prepareEmail('template')} /> : null}
        {issued && draft ? <IssuedSummary draft={draft} onOpenOutbox={onOpenOutbox} /> : null}

        <RfxEditor rfx={rfx} validation={validation} onChange={edit} locked={busy || issued || email === 'loading'} />
      </div>
    </div>
  );
}

function EmailStep({ email, issuing, onChange, onIssue, onCancel, onTemplate }: { email: EmailDraftResponse | 'loading'; issuing: boolean; onChange: (e: EmailDraftResponse) => void; onIssue: () => void; onCancel: () => void; onTemplate: () => void }) {
  if (email === 'loading') return <p role="status" className="rounded-md border border-border bg-card px-3 py-3 text-sm text-muted-foreground">Drafting the covering email from your RFx...</p>;
  return (
    <section aria-label="Covering email" className="rounded-lg border border-teal-200 bg-teal-50/40 p-3">
      <h2 className="text-sm font-semibold">Covering email for the five vendors</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {email.label} The vendor name replaces {'{{vendor_name}}'} in each copy. {email.cost_inr > 0 ? `Cost: about Rs ${email.cost_inr.toFixed(2)}.` : ''}
      </p>
      <label className="mt-2 block text-xs text-muted-foreground">
        Subject
        <input className="mt-0.5 w-full rounded border border-border bg-card px-2 py-1 text-sm" value={email.subject} maxLength={160} onChange={(e) => onChange({ ...email, subject: e.target.value })} />
      </label>
      <label className="mt-2 block text-xs text-muted-foreground">
        Body
        <textarea className="mt-0.5 min-h-[14rem] w-full rounded border border-border bg-card px-2 py-1.5 text-sm" value={email.body} maxLength={6000} onChange={(e) => onChange({ ...email, body: e.target.value })} />
      </label>
      <p className="mt-1 text-xs text-muted-foreground">Attachment: {email.attachment} (the RFx pack, a PDF made when you issue).</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Btn variant="primary" disabled={issuing || !email.subject.trim() || email.body.trim().length < 20} onClick={onIssue}>{issuing ? 'Issuing...' : 'Issue to 5 vendors (simulated)'}</Btn>
        <Btn disabled={issuing} onClick={onTemplate}>Use the template email instead</Btn>
        <Btn variant="ghost" disabled={issuing} onClick={onCancel}>Cancel</Btn>
      </div>
    </section>
  );
}

function IssuedSummary({ draft, onOpenOutbox }: { draft: DraftWithEmails; onOpenOutbox: () => void }) {
  return (
    <section aria-label="Issued" className="rounded-lg border border-green-200 bg-green-50 px-3 py-3 text-sm">
      <p className="font-medium text-status-confirmed">Issued. {draft.emails.length} simulated emails were created, one per vendor.</p>
      <ul className="mt-1 list-disc pl-5 text-xs text-ink-2">
        {draft.emails.map((e) => <li key={e.id}>{e.vendor_key} {e.vendor_name}: {e.status}</li>)}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">The vendor replies in this demo answer the saved FY27 RFx, not this one. Your issued RFx is final; start a new draft to change anything.</p>
      <Btn small className="mt-2" onClick={onOpenOutbox}>Open the outbox</Btn>
    </section>
  );
}

