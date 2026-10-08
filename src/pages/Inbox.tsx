// Vendor replies with attachments and extraction status. "Simulate vendor replies" replays the five stored replies
// on a day timeline (arrival days 2, 3, 5, 7, 9). It uses the STORED real extraction results and makes no model call.
import { Database, Mail, Paperclip, Play, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Btn, Chip, ErrorBox, Loading, PageTitle, pipelineTone } from '@/components/ui';
import { api } from '@/lib/api';
import type { InboxResponse } from '@/lib/api-types';
import { browserId } from '@/lib/browser';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';

const KIND: Record<string, string> = { quote: 'Quote', questionnaire: 'Questionnaire', certificate: 'Certificate', profile: 'Profile', other: 'Other, skipped' };
const STAGES = ['Received', 'Classified', 'Extracted', 'Needs review', 'Ready'] as const;
const LAST_DAY = 9;
const TICK_MS = 750;

type Msg = InboxResponse['messages'][number];

/** How far a message has got on the replay: 0 Received, 1 Classified, 2 Extracted, then its stored final stage. */
function stageIndex(m: Msg, day: number | null): number {
  const final = Math.max(STAGES.indexOf(m.pipeline as (typeof STAGES)[number]), 2);
  if (day == null) return final;
  const since = day - (m.arrival_day ?? LAST_DAY);
  return since < 0 ? -1 : Math.min(since, final);
}

export function Inbox() {
  const { openSource, version } = useApp();
  const [r, setR] = useState<InboxResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [day, setDay] = useState<number | null>(null); // null: show the stored state as it is, no replay running
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(() => api<InboxResponse>(`inbox?browser_id=${browserId()}`).then((x) => (setR(x), setErr(null), x)), []);
  useEffect(() => {
    load().catch((e: Error) => setErr(e.message));
    return () => window.clearInterval(timer.current);
  }, [load, version]);

  const simulate = async () => {
    setBusy(true);
    try {
      await api('inbox', { method: 'POST', body: { action: 'simulate', browser_id: browserId() } });
      await load();
      setDay(0);
      window.clearInterval(timer.current);
      timer.current = window.setInterval(() => {
        setDay((d) => {
          const next = (d ?? 0) + 1;
          if (next >= LAST_DAY + 2) {
            window.clearInterval(timer.current);
            return null;
          }
          return next;
        });
      }, TICK_MS);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hide = async () => {
    window.clearInterval(timer.current);
    setDay(null);
    setBusy(true);
    try {
      await api('inbox', { method: 'POST', body: { action: 'hide', browser_id: browserId() } });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (err) return <ErrorBox message={err} />;
  if (!r) return <Loading what="the inbox" />;
  const replaying = day != null;
  const shownDay = day ?? LAST_DAY;
  return (
    <div className="space-y-4">
      <PageTitle
        title="Inbox"
        sub="Vendor replies as they arrive, with every attachment and where its extraction stands."
        right={
          r.revealed ? (
            <Btn small disabled={busy} onClick={() => void hide()}><RotateCcw size={12} aria-hidden /> Hide replies again</Btn>
          ) : null
        }
      />
      <Timeline messages={r.messages} waiting={r.waiting} day={r.revealed ? shownDay : 0} replaying={replaying} />

      {!r.revealed ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center">
          <p className="text-sm font-medium">No vendor replies have arrived yet.</p>
          <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">
            Simulate vendor replies drops the {r.waiting} saved replies into the inbox over a nine day timeline. It replays the stored real extraction results and makes no model call.
          </p>
          <Btn variant="primary" className="mt-3" disabled={busy} onClick={() => void simulate()}><Play size={14} aria-hidden /> Simulate vendor replies</Btn>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Database size={12} aria-hidden /> Replaying stored real extraction results. {replaying ? `Day ${Math.min(day ?? 0, LAST_DAY)} of ${LAST_DAY}.` : 'All replies have arrived.'} No model calls are made here.
        </p>
      )}

      {r.messages.map((m) => {
        const idx = stageIndex(m, replaying ? day : null);
        if (idx < 0) return null;
        return <Reply key={m.vendor_id} m={m} idx={idx} onSource={(docId) => openSource({ vendor_id: m.vendor_id, document_id: docId })} />;
      })}
    </div>
  );
}

function Timeline({ messages, waiting, day, replaying }: { messages: Msg[]; waiting: number; day: number; replaying: boolean }) {
  const days = Array.from({ length: LAST_DAY }, (_, i) => i + 1);
  const at = (d: number) => messages.filter((m) => m.arrival_day === d);
  return (
    <section aria-label="Reply timeline" className="rounded-lg border border-border bg-card px-4 py-3">
      <ol className="grid grid-cols-9 gap-1">
        {days.map((d) => {
          const here = at(d);
          const arrived = d <= day && here.length > 0;
          return (
            <li key={d} className={cn('rounded-md border px-1.5 py-1.5 text-center text-xs', d === day && replaying ? 'border-accent bg-teal-50' : 'border-border', d > day && 'opacity-60')}>
              <div className="font-semibold tabular">Day {d}</div>
              <div className="mt-0.5 min-h-[2.25rem] text-[11px] leading-tight text-muted-foreground">
                {arrived ? here.map((m) => <div key={m.vendor_id} className="font-medium text-foreground">{m.vendor_key} {m.vendor_name.split(' ')[0]}</div>) : messages.length === 0 && [2, 3, 5, 7, 9].includes(d) ? <span aria-hidden>reply due</span> : null}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {messages.length === 0 ? `${waiting} replies are saved and will arrive on days 2, 3, 5, 7 and 9.` : `${messages.filter((m) => (m.arrival_day ?? LAST_DAY) <= day).length} of ${messages.length} replies have arrived.`}
      </p>
    </section>
  );
}

function Pipeline({ idx, final }: { idx: number; final: string }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[11px]" aria-label={`Pipeline stage: ${STAGES[Math.min(idx, 4)]}`}>
      {STAGES.map((s, i) => {
        const finalPair = s === 'Needs review' || s === 'Ready';
        const skipped = finalPair && s !== final && idx >= 3;
        const reached = finalPair ? s === final && idx >= 3 : i <= idx;
        return (
          <li key={s} className={cn('rounded-full border px-2 py-0.5', reached ? 'border-teal-300 bg-teal-50 font-medium text-accent' : 'border-border text-muted-foreground', skipped && 'opacity-40')}>
            {s}
          </li>
        );
      })}
    </ol>
  );
}

function Reply({ m, idx, onSource }: { m: Msg; idx: number; onSource: (docId: string) => void }) {
  const done = idx >= 3 || idx >= STAGES.indexOf(m.pipeline as (typeof STAGES)[number]);
  const shownPipeline = done ? m.pipeline : STAGES[idx] ?? 'Received';
  return (
    <section aria-label={`Reply from ${m.vendor_name}`} className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Mail size={15} className="shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{m.vendor_key} {m.vendor_name}: {m.subject ?? 'No subject'}</div>
            <div className="text-xs text-muted-foreground">
              From {m.from ?? 'unknown sender'}. {m.arrival_day != null ? `Arrived on day ${m.arrival_day}` : 'Arrival day not set'}
              {m.received_at ? `, ${new Date(m.received_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
            </div>
          </div>
        </div>
        <Chip tone={pipelineTone(shownPipeline)}>{shownPipeline}</Chip>
      </header>
      <div className="border-b border-border px-4 py-2"><Pipeline idx={done ? 3 : idx} final={m.pipeline} /></div>
      {m.body_text && idx >= 0 ? (
        <details className="border-b border-border px-4 py-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-ink-2">Message text</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs text-ink-2">{m.body_text}</pre>
        </details>
      ) : null}
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-1.5 font-medium">Attachment</th>
            <th scope="col" className="w-[16%] px-2 py-1.5 font-medium">Read as</th>
            <th scope="col" className="w-[16%] px-2 py-1.5 font-medium">Extraction</th>
            <th scope="col" className="w-[12%] px-2 py-1.5 text-right font-medium">Lines read</th>
            <th scope="col" className="w-[14%] px-4 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {m.documents.map((d) => (
            <tr key={d.id} className="border-t border-border align-top">
              <td className="px-4 py-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium break-all"><Paperclip size={12} aria-hidden /> {d.filename}</span>
                <div className="text-muted-foreground">{d.is_message_body ? 'Message body' : d.mime}{d.size_bytes ? `, ${(d.size_bytes / 1024).toFixed(0)} KB` : ''}</div>
              </td>
              <td className="px-2 py-2 text-xs">{idx >= 1 ? (d.kind ? KIND[d.kind] ?? d.kind : 'Not read') : <span className="text-muted-foreground">Waiting</span>}</td>
              <td className="px-2 py-2 text-xs">
                {idx >= 2 ? (
                  <>
                    <Chip tone={d.status === 'extracted' ? 'good' : d.status === 'failed' ? 'bad' : 'neutral'}>{d.status === 'extracted' ? 'Extracted' : d.status === 'failed' ? 'Failed' : d.status[0]?.toUpperCase() + d.status.slice(1)}</Chip>
                    {d.error ? <div className="mt-1 text-status-conflict">{d.error}</div> : null}
                  </>
                ) : (
                  <Chip>{idx === 1 ? 'Classified' : 'Received'}</Chip>
                )}
              </td>
              <td className="px-2 py-2 text-right text-xs tabular">{idx >= 2 ? (d.lines > 0 ? d.lines : <span className="text-muted-foreground">None</span>) : <span className="text-muted-foreground">Waiting</span>}</td>
              <td className="px-4 py-2 text-right"><Btn small onClick={() => onSource(d.id)}>View source</Btn></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
