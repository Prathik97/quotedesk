import { BarChart3, FileText, FlaskConical, Inbox, MessageSquare, Scale, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const STAGES = [
  { id: 'rfx', label: 'RFx', icon: FileText, phase: 6 },
  { id: 'outbox', label: 'Outbox', icon: Send, phase: 6 },
  { id: 'inbox', label: 'Inbox', icon: Inbox, phase: 6 },
  { id: 'comparison', label: 'Comparison', icon: BarChart3, phase: 3 },
  { id: 'analyst', label: 'Analyst', icon: MessageSquare, phase: 5 },
  { id: 'decision', label: 'Decision', icon: Scale, phase: 7 },
  { id: 'eval', label: 'Eval', icon: FlaskConical, phase: 2 },
] as const;

type StageId = (typeof STAGES)[number]['id'];

type Health = { ok: boolean; config: string; database: string };

export function App() {
  const [stage, setStage] = useState<StageId>('comparison');
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth({ ok: false, config: 'unknown', database: 'unreachable' }));
  }, []);

  const current = STAGES.find((s) => s.id === stage) ?? STAGES[0];

  return (
    <div className="flex h-full min-w-[1024px] flex-col">
      <header className="flex h-12 items-center justify-between border-b border-border bg-card px-4">
        <div className="flex items-center gap-2">
          <span className="font-semibold tracking-tight">QuoteDesk</span>
          <span className="text-sm text-muted-foreground">FY27 Corrugated Packaging and Consumables</span>
        </div>
        <div className="text-sm text-muted-foreground">Certainty counts appear here once extraction runs.</div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Journey stages" className="w-48 shrink-0 border-r border-border bg-card p-2">
          <ul className="space-y-1">
            {STAGES.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setStage(s.id)}
                  aria-current={stage === s.id ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
                    stage === s.id ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted',
                  )}
                >
                  <s.icon className="size-4" aria-hidden />
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 overflow-auto p-6">
          <h1 className="text-lg font-semibold">{current.label}</h1>
          <p className="mt-2 text-sm text-muted-foreground">This stage is built in phase {current.phase}.</p>
        </main>
      </div>
      <footer className="flex h-8 items-center justify-between border-t border-border bg-card px-4 text-xs text-muted-foreground">
        <span>
          Server: {health ? (health.ok ? 'ready' : `config ${health.config}, database ${health.database}`) : 'checking'}
        </span>
        <span>Usage meter arrives in phase 8.</span>
      </footer>
    </div>
  );
}
