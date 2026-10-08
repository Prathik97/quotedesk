import { BarChart3, Database, FileText, Inbox as InboxIcon, MessageSquare, Scale, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EvidenceDrawer } from '@/components/EvidenceDrawer';
import { Btn } from '@/components/ui';
import { formatIndian } from '../engine/format';
import { TopStrip } from '@/components/TopStrip';
import { AppProvider, useApp, type Page } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Analyst } from '@/pages/Analyst';
import { ComingNext } from '@/pages/ComingNext';
import { Comparison } from '@/pages/Comparison';
import { Eval } from '@/pages/Eval';
import { Inbox } from '@/pages/Inbox';
import { IssuedRfx } from '@/pages/IssuedRfx';

const STAGES: { id: Page; label: string; icon: typeof FileText; soon?: boolean }[] = [
  { id: 'rfx', label: 'Issued RFx (saved)', icon: FileText },
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'comparison', label: 'Comparison', icon: BarChart3 },
  { id: 'analyst', label: 'Analyst', icon: MessageSquare },
  { id: 'decision', label: 'Decision', icon: Scale, soon: true },
  { id: 'eval', label: 'Evaluation', icon: ShieldCheck },
];

type Health = { ok: boolean; config: string; database: string };

function Shell() {
  const { page, setPage, toast, selection, resetDemo, resetCount, busy } = useApp();
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth({ ok: false, config: 'unknown', database: 'unreachable' }));
  }, []);

  return (
    <div className="flex h-full min-w-[1024px] flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-4">
        <div className="flex items-center gap-2">
          <span className="font-semibold tracking-tight">QuoteDesk</span>
          <span className="text-sm text-muted-foreground">FY27 Corrugated Packaging and Consumables</span>
        </div>
        <span className="text-xs text-muted-foreground">Compare, check, decide</span>
      </header>
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-slate-50 px-4" aria-label="Certainty and readiness">
        <div className="w-full"><TopStrip /></div>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Journey stages" className="w-44 shrink-0 border-r border-border bg-card p-2">
          <ul className="space-y-1">
            {STAGES.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setPage(s.id)}
                  aria-current={page === s.id ? 'page' : undefined}
                  className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm', page === s.id ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted')}
                >
                  <s.icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 leading-tight">
                    {s.label}
                    {s.soon ? <span className={cn('block text-[11px] font-normal', page === s.id ? 'text-teal-100' : 'text-muted-foreground')}>coming next</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className={cn('min-w-0 flex-1 overflow-auto p-5', selection && 'pr-[520px]')}>
          {page === 'rfx' ? <IssuedRfx /> : null}
          {page === 'inbox' ? <Inbox /> : null}
          {page === 'comparison' ? <Comparison /> : null}
          {page === 'analyst' ? <Analyst key={resetCount} /> : null}
          {page === 'eval' ? <Eval /> : null}
          {page === 'decision' ? <ComingNext title="Decision" what="Turn a scenario into an award decision pack that lists every assumption and every unresolved item." /> : null}
        </main>
      </div>
      <footer className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-card px-4 py-1 text-xs text-muted-foreground">
        <span>Server: {health ? (health.ok ? 'ready' : `config ${health.config}, database ${health.database}`) : 'checking'}</span>
        <UsageMeter />
        <span className="min-w-[14rem] flex-1">Shared demo: edits are visible to everyone. Use Reset demo to restore.</span>
        <Btn
          small
          disabled={busy > 0}
          onClick={() => {
            if (window.confirm('Reset the demo for everyone? This clears all corrections, assumption changes and chats. Extraction results are kept.')) void resetDemo();
          }}
        >
          Reset demo
        </Btn>
      </footer>
      <EvidenceDrawer />
      {toast ? (
        <div role="status" aria-live="polite" className={cn('fixed bottom-12 left-1/2 z-50 max-w-xl -translate-x-1/2 rounded-md border px-4 py-2 text-sm shadow-lg', toast.kind === 'error' ? 'border-red-300 bg-red-50 text-status-conflict' : 'border-border bg-card')}>
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

function UsageMeter() {
  const { usage } = useApp();
  if (!usage) return <span>Usage: unavailable</span>;
  if (usage.capped) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-status-assumed">
        <Database size={12} aria-hidden /> Spend cap reached. Showing stored results from an earlier live run.
      </span>
    );
  }
  return (
    <span title="Live model calls today and their estimated cost. Cached replays are free and not counted.">
      Today: {usage.calls_today} live model {usage.calls_today === 1 ? 'call' : 'calls'}, about Rs {formatIndian(usage.cost_today_inr, 2)} of Rs {formatIndian(usage.daily_cap_inr, 0)}
    </span>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
