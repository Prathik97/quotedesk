// Shows what a recompute changed, so an edit never moves numbers silently.
import { X } from 'lucide-react';
import { formatIndian } from '../../engine/format';
import { useApp } from '@/lib/store';
import { STATUS_LABEL } from '@/lib/status';
import type { CellStatus } from '../../engine/certainty';
import { Btn } from './ui';

export function ChangeBanner() {
  const { change, clearChange } = useApp();
  if (!change) return null;
  const n = change.changes.length;
  return (
    <div role="status" className="mb-3 rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-semibold">{change.title}.</span>{' '}
          {n === 0 ? 'No cell value or status changed.' : `${n} ${n === 1 ? 'cell' : 'cells'} recomputed.`}{' '}
          <span className="text-xs text-muted-foreground">
            {change.pending ? 'Saving to the server' : `Saved. Server recompute took ${change.server_ms} ms`}
            {change.local_ms >= 0 ? `, shown in the browser in ${change.local_ms} ms` : ''}.
          </span>
        </div>
        <Btn small variant="ghost" onClick={clearChange} aria-label="Dismiss this message">
          <X size={13} aria-hidden />
        </Btn>
      </div>
      {n > 0 ? (
        <ul className="mt-1.5 grid max-h-28 grid-cols-1 gap-x-6 overflow-auto text-xs tabular md:grid-cols-2">
          {change.changes.slice(0, 12).map((c, i) => (
            <li key={i}>
              <span className="font-medium">{c.vendor_key} {c.code}</span>:{' '}
              {c.before != null ? formatIndian(c.before, 2) : 'Not quoted'} to {c.after != null ? formatIndian(c.after, 2) : 'Not quoted'}
              {c.status_before !== c.status_after ? `, ${STATUS_LABEL[(c.status_before === 'rejected' ? 'missing' : c.status_before) as CellStatus] ?? c.status_before} to ${STATUS_LABEL[(c.status_after === 'rejected' ? 'missing' : c.status_after) as CellStatus] ?? c.status_after}` : ''}
            </li>
          ))}
          {n > 12 ? <li className="text-muted-foreground">and {n - 12} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
