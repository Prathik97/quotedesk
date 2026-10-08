// The vendor's own notes for the whole quote, shown as written. Reading aid only: nothing here changes a price or a status.
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export function VendorNotes({ notes, warning, statements, compact = false, className }: { notes?: string[]; warning?: string | null; statements?: { text: string; applies_to?: string | null }[]; compact?: boolean; className?: string }) {
  const list = notes ?? [];
  const said = statements ?? [];
  if (list.length === 0 && said.length === 0 && !warning) return null;
  const body = (
    <>
      {warning ? (
        <p className="flex items-start gap-1 font-medium text-status-assumed">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden /> {warning}
        </p>
      ) : null}
      {list.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {list.map((n, i) => <li key={i} className="break-words">{n}</li>)}
        </ul>
      ) : null}
      {said.length > 0 ? (
        <div>
          <p className="font-medium">Vendor statements about price, shown as written and never applied</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {said.map((s, i) => <li key={i} className="break-words">{s.text}{s.applies_to ? ` (applies to: ${s.applies_to})` : ''}</li>)}
          </ul>
        </div>
      ) : null}
    </>
  );
  if (compact) {
    return (
      <div className={cn('text-[11px]', className)}>
        {warning ? <p className="flex items-start gap-1 font-medium text-status-assumed"><TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden /> {warning}</p> : null}
        {list.length + said.length > 0 ? (
          <details>
            <summary className="cursor-pointer rounded hover:bg-muted">Vendor notes ({list.length + said.length})</summary>
            <div className="mt-1 space-y-1 text-muted-foreground">
              {list.length > 0 ? <ul className="list-disc space-y-0.5 pl-4">{list.map((n, i) => <li key={i} className="break-words">{n}</li>)}</ul> : null}
              {said.length > 0 ? <ul className="list-disc space-y-0.5 pl-4">{said.map((s, i) => <li key={i} className="break-words">{s.text}</li>)}</ul> : null}
            </div>
          </details>
        ) : null}
      </div>
    );
  }
  return <div className={cn('space-y-2 text-sm', className)}>{body}</div>;
}
