// Read only list of vendor replies and attachments with extraction status.
import { Mail, Paperclip } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { InboxResponse } from '@/lib/api-types';
import { useApp } from '@/lib/store';
import { Btn, Chip, ErrorBox, Loading, PageTitle, pipelineTone, StoredLabel } from '@/components/ui';

const KIND: Record<string, string> = { quote: 'Quote', questionnaire: 'Questionnaire', certificate: 'Certificate', profile: 'Profile', other: 'Other, skipped' };

export function Inbox() {
  const { openSource, version } = useApp();
  const [r, setR] = useState<InboxResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<InboxResponse>('inbox').then((x) => { setR(x); setErr(null); }).catch((e: Error) => setErr(e.message));
  }, [version]);
  if (err) return <ErrorBox message={err} />;
  if (!r) return <Loading what="the inbox" />;
  return (
    <div className="space-y-4">
      <PageTitle title="Inbox" sub="Vendor replies as they arrived, with every attachment and where its extraction stands. Read only." right={<StoredLabel stored={r.stored} />} />
      {r.messages.map((m) => (
        <section key={m.vendor_id} aria-label={`Reply from ${m.vendor_name}`} className="rounded-lg border border-border bg-card">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <Mail size={15} className="shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {m.vendor_key} {m.vendor_name}: {m.subject ?? 'No subject'}
                </div>
                <div className="text-xs text-muted-foreground">
                  From {m.from ?? 'unknown sender'}. {m.arrival_day != null ? `Arrived on day ${m.arrival_day}` : 'Arrival day not set'}
                  {m.received_at ? `, ${new Date(m.received_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                </div>
              </div>
            </div>
            <Chip tone={pipelineTone(m.pipeline)}>{m.pipeline}</Chip>
          </header>
          {m.body_text ? (
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
                    <span className="inline-flex items-center gap-1.5 font-medium break-all">
                      <Paperclip size={12} aria-hidden /> {d.filename}
                    </span>
                    <div className="text-muted-foreground">{d.is_message_body ? 'Message body' : d.mime}{d.size_bytes ? `, ${(d.size_bytes / 1024).toFixed(0)} KB` : ''}</div>
                  </td>
                  <td className="px-2 py-2 text-xs">{d.kind ? KIND[d.kind] ?? d.kind : 'Not read'}</td>
                  <td className="px-2 py-2 text-xs">
                    <Chip tone={d.status === 'extracted' ? 'good' : d.status === 'failed' ? 'bad' : 'neutral'}>{d.status === 'extracted' ? 'Extracted' : d.status === 'failed' ? 'Failed' : d.status[0]?.toUpperCase() + d.status.slice(1)}</Chip>
                    {d.error ? <div className="mt-1 text-status-conflict">{d.error}</div> : null}
                  </td>
                  <td className="px-2 py-2 text-right text-xs tabular">{d.lines > 0 ? d.lines : <span className="text-muted-foreground">None</span>}</td>
                  <td className="px-4 py-2 text-right">
                    <Btn small onClick={() => openSource({ vendor_id: m.vendor_id, document_id: d.id })}>
                      View source
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
