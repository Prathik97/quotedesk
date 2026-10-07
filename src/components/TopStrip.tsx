// Persistent top strip: certainty counts with click through, and decision readiness (FR-9.2, FR-9.3).
import { CircleCheck, OctagonX, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { CellStatus } from '../../engine/certainty';
import { useApp } from '@/lib/store';
import { STATUS_ICON, STATUS_LABEL, STATUS_TEXT_CLASS } from '@/lib/status';
import { cn } from '@/lib/utils';
import { Btn, StoredLabel } from './ui';

const LABEL: Record<CellStatus, (n: number) => string> = {
  confirmed: (n) => `${n} confirmed`,
  assumed: (n) => `${n} assumed`,
  needs_review: (n) => `${n} need review`,
  conflict: (n) => `${n} in conflict`,
  missing: (n) => `${n} not quoted`,
};

export function TopStrip() {
  const { data, setPage, setTab, setStatusFilter, busy } = useApp();
  const [open, setOpen] = useState(false);
  if (!data) return <div className="text-sm text-muted-foreground">Certainty counts load with the comparison.</div>;
  const c = data.certainty;
  const r = data.readiness;

  const go = (s: CellStatus) => {
    setPage('comparison');
    if (s === 'needs_review' || s === 'assumed' || s === 'conflict') {
      setStatusFilter(null);
      setTab('review');
    } else {
      setStatusFilter(s);
      setTab('grid');
    }
  };
  const shown: CellStatus[] = ['confirmed', 'assumed', 'needs_review', ...(c.conflict > 0 ? (['conflict'] as CellStatus[]) : []), ...(c.missing > 0 ? (['missing'] as CellStatus[]) : [])];

  const Icon = r.level === 'ready' ? CircleCheck : r.level === 'ready_with_assumptions' ? TriangleAlert : OctagonX;
  const tone = r.level === 'ready' ? 'border-green-300 bg-green-50 text-status-confirmed' : r.level === 'ready_with_assumptions' ? 'border-amber-300 bg-amber-50 text-status-assumed' : 'border-red-300 bg-red-50 text-status-conflict';

  return (
    <div className="flex items-center gap-4">
      <div role="group" aria-label="Certainty counts, click one to see those cells" className="flex items-center gap-1 text-sm">
        {shown.map((s, i) => {
          const I = STATUS_ICON[s];
          return (
            <span key={s} className="flex items-center">
              <button
                type="button"
                onClick={() => go(s)}
                aria-label={`${LABEL[s](c[s])}. Show these cells`}
                className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 tabular hover:bg-muted', STATUS_TEXT_CLASS[s])}
                title={`Show ${STATUS_LABEL[s].toLowerCase()} cells`}
              >
                <I size={14} aria-hidden />
                <span className="font-semibold">{LABEL[s](c[s])}</span>
              </button>
              {i < shown.length - 1 ? <span className="text-muted-foreground" aria-hidden>,</span> : null}
            </span>
          );
        })}
        <span className="ml-1 text-xs text-muted-foreground tabular">of {c.total} cells</span>
      </div>
      <div className="relative">
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((o) => !o)}
          className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium', tone)}
        >
          <Icon size={15} aria-hidden />
          <span className="sr-only">Decision readiness: </span>
          {r.label}
        </button>
        {open ? (
          <div role="dialog" aria-label="Decision readiness details" className="absolute right-0 top-9 z-40 w-[440px] rounded-lg border border-border bg-card p-3 text-sm shadow-lg">
            <p className="font-medium">{r.label}</p>
            <p className="mt-0.5 text-muted-foreground">{r.summary}</p>
            {r.blockers.length > 0 ? (
              <ul className="mt-2 max-h-64 space-y-1.5 overflow-auto">
                {r.blockers.map((b, i) => (
                  <li key={i} className="flex gap-2 text-xs">
                    <OctagonX size={13} className="mt-0.5 shrink-0 text-status-conflict" aria-hidden />
                    <span>
                      {b.vendor ? <span className="font-medium">{b.vendor}: </span> : null}
                      {b.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3 flex justify-end gap-2">
              <Btn
                small
                onClick={() => {
                  setOpen(false);
                  setPage('comparison');
                  setTab('review');
                }}
              >
                Open review queue
              </Btn>
              <Btn small variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Btn>
            </div>
          </div>
        ) : null}
      </div>
      {busy > 0 ? (
        <span role="status" className="text-xs text-muted-foreground">
          Saving
        </span>
      ) : null}
      <StoredLabel stored={data.stored} className="ml-auto" />
    </div>
  );
}
