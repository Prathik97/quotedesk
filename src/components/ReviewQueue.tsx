// The review queue (FR-6.5), sorted by value at stake.
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatInrCompact } from '../../engine/format';
import { api } from '@/lib/api';
import type { ReviewItem, ReviewResponse } from '@/lib/api-types';
import { useApp } from '@/lib/store';
import { StatusMark } from '@/lib/status';
import { cn } from '@/lib/utils';
import { ReviewActions } from './ReviewActions';
import { Btn, Chip, ErrorBox, Loading, StoredLabel } from './ui';

const KIND_LABEL: Record<string, string> = {
  line_needs_review: 'Needs review',
  conflict: 'Conflict',
  assumed_cell: 'Assumed value',
  total_mismatch: 'Stated total does not add up',
  knockout_failed: 'Knockout failed',
  knockout_pending: 'Knockout undecided',
  freight_amount_unknown: 'Freight amount missing',
  freight_terms_unknown: 'Freight not stated',
  certificate_expired: 'Certificate expired',
  attachment_name_mismatch: 'Legal name mismatch',
  suspicious_content: 'Instruction like text, ignored',
  low_visibility_text: 'Tiny or faint text',
  hidden_sheet: 'Hidden sheet',
  not_quoted: 'Lines not quoted',
  unmatched_vendor_line: 'Unmatched vendor line',
};

type Filter = 'open' | 'needs_review' | 'assumed' | 'vendor' | 'closed';

export function ReviewQueue() {
  const { version, openCell, openSource, data } = useApp();
  const [r, setR] = useState<ReviewResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');

  const load = () =>
    api<ReviewResponse>('review')
      .then((x) => {
        setR(x);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
  }, [version]);

  if (err) return <ErrorBox message={err} onRetry={() => void load()} />;
  if (!r) return <Loading what="the review queue" />;

  const open = r.items.filter((i) => i.state === 'open');
  const shown = r.items.filter((i) => (filter === 'closed' ? i.state !== 'open' : i.state === 'open' && (filter === 'open' || i.tier === filter)));
  const tabs: { id: Filter; label: string; n: number }[] = [
    { id: 'open', label: 'All open', n: open.length },
    { id: 'needs_review', label: 'Needs review', n: r.counts.needs_review },
    { id: 'assumed', label: 'Assumed values', n: r.counts.assumed },
    { id: 'vendor', label: 'Vendor issues', n: r.counts.vendor },
    { id: 'closed', label: 'Closed', n: r.counts.resolved },
  ];
  const line = (i: ReviewItem) => data?.cells.find((c) => c.quote_line_id === i.quote_line_id);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Review queue filters" className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={filter === t.id}
              onClick={() => setFilter(t.id)}
              className={cn('rounded-md border px-2.5 py-1 text-sm', filter === t.id ? 'border-accent bg-accent text-accent-foreground' : 'border-border bg-card hover:bg-muted')}
            >
              {t.label} <span className="tabular opacity-80">({t.n})</span>
            </button>
          ))}
        </div>
        <StoredLabel stored={r.stored} />
      </div>
      <p className="text-xs text-muted-foreground">Sorted by value at stake, highest first. For a vendor level issue the value is that vendor's whole annual total, the most that depends on the answer.</p>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">{filter === 'closed' ? 'Nothing has been closed yet.' : 'Nothing is open here. Check another filter.'}</div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card" aria-label="Review items">
          {shown.map((i) => {
            const cell = line(i);
            return (
              <li key={i.id} className="px-4 py-3" data-item={i.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {i.tier === 'assumed' ? <StatusMark status="assumed" /> : i.tier === 'needs_review' ? <StatusMark status={i.kind === 'conflict' ? 'conflict' : 'needs_review'} /> : <Chip tone={i.is_blocker ? 'bad' : 'neutral'}>{KIND_LABEL[i.kind] ?? i.kind}</Chip>}
                      {i.is_blocker && i.state === 'open' ? <Chip tone="bad">Blocks decision</Chip> : null}
                      <span className="font-medium">
                        {i.vendor_key} {i.vendor_name}
                      </span>
                      {i.rfx_line_code ? <span className="tabular text-muted-foreground">{i.rfx_line_code}</span> : null}
                    </div>
                    <p className="mt-1 text-sm">{i.message}</p>
                    {i.state !== 'open' ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {i.state === 'dismissed' ? 'Dismissed' : 'Resolved'}: {i.resolution?.reason ?? i.resolution?.note ?? 'No reason recorded.'}
                      </p>
                    ) : null}
                  </div>
                  <div className="w-36 shrink-0 text-right">
                    <div className="text-sm font-semibold tabular">{i.value_at_stake_inr != null ? formatInrCompact(i.value_at_stake_inr) : 'Not priced'}</div>
                    <div className="text-[11px] text-muted-foreground">value at stake</div>
                  </div>
                </div>
                {i.state === 'open' ? (
                  <div className="mt-2 flex flex-wrap items-start gap-3">
                    {i.quote_line_id && cell ? (
                      <Btn small onClick={() => openCell(cell.vendor_id, cell.rfx_line_id, cell.quote_line_id)}>
                        Open evidence
                      </Btn>
                    ) : i.document_id ? (
                      <Btn small onClick={() => openSource({ vendor_id: i.vendor_id, document_id: i.document_id })}>
                        <ExternalLink size={13} aria-hidden /> Open source
                      </Btn>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <ReviewActions
                        compact
                        t={{
                          quote_line_id: i.quote_line_id,
                          review_item_id: i.id,
                          actions: i.actions,
                          base_uom: i.base_uom,
                          quoted_uom: i.quoted_uom,
                          quoted_price: i.quoted_price,
                          quoted_currency: i.quoted_currency,
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
