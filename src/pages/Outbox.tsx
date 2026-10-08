// The outbox: five simulated emails per issued RFx, one per vendor. Nothing is ever sent.
// Top: this browser's issued drafts. Below: the five saved emails of the seeded FY27 RFx.
import { Mail, Paperclip } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Btn, Chip, ErrorBox, Loading, PageTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { browserId } from '@/lib/browser';
import type { EmailView, OutboxResponse } from '@/lib/copilot';
import { useApp } from '@/lib/store';

const SOURCE: Record<EmailView['source'], string> = {
  saved: 'Saved with the FY27 RFx. Written without a model.',
  model: 'Drafted by the model once for this issue, then personalised in code.',
  template: 'Template email, written by fixed rules. No model was used.',
};

export function Outbox() {
  const { setPage } = useApp();
  const [r, setR] = useState<OutboxResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<OutboxResponse>(`outbox?browser_id=${browserId()}`).then(setR).catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <ErrorBox message={err} />;
  if (!r) return <Loading what="the outbox" />;
  return (
    <div className="space-y-6">
      <PageTitle title="Outbox" sub="Simulated dispatch. These emails are listed for the demo and never leave the system." />

      <section aria-label="Your issued RFx">
        <h2 className="mb-2 text-sm font-semibold">Your issued RFx</h2>
        {r.drafts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-5 text-sm text-muted-foreground">
            You have not issued an RFx in this browser. Draft one with the co-pilot, fix any errors and press Issue RFx.
            <div className="mt-2"><Btn small onClick={() => setPage('rfx')}>Open the RFx page</Btn></div>
          </div>
        ) : null}
        {r.drafts.map((d) => (
          <EmailGroup key={d.draft_id} title={d.title ?? 'Untitled RFx'} sub={d.issued_at ? `Issued ${new Date(d.issued_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Issued'} packUrl={`/api/outbox?pack=${d.draft_id}&browser_id=${browserId()}`} emails={d.emails} />
        ))}
      </section>

      <section aria-label="Saved FY27 emails">
        <h2 className="mb-2 text-sm font-semibold">Saved emails for the FY27 RFx</h2>
        <EmailGroup title={r.saved.title} sub="These five were saved with the seeded RFx. The stored vendor replies answer them." packUrl={r.saved.pack_url} emails={r.saved.emails} saved />
      </section>
    </div>
  );
}

function EmailGroup({ title, sub, packUrl, emails, saved }: { title: string; sub: string; packUrl: string; emails: EmailView[]; saved?: boolean }) {
  return (
    <div className="mb-4 rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-muted-foreground">{sub}</div>
        </div>
        <div className="flex items-center gap-2">
          {saved ? <Chip tone="accent">Saved</Chip> : null}
          <Chip tone="good">{emails.length} sent (simulated)</Chip>
        </div>
      </header>
      <ul className="divide-y divide-border">
        {emails.map((e) => (
          <li key={e.id} className="px-4 py-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <Mail size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{e.vendor_key} {e.vendor_name}: {e.subject}</div>
                  <div className="text-xs text-muted-foreground">To {e.to_email ?? 'no address on file'}</div>
                </div>
              </div>
              <Chip tone="good">{e.status}</Chip>
            </div>
            <details className="mt-1.5 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-ink-2">Message</summary>
              <pre className="mt-1.5 whitespace-pre-wrap break-words font-sans text-xs text-ink-2">{e.body}</pre>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{SOURCE[e.source]}</p>
            </details>
            <a className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-accent underline" href={packUrl}>
              <Paperclip size={12} aria-hidden /> {e.attachment_filename} (RFx pack, PDF)
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
