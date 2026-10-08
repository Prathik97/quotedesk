// Scenario readiness: Ready, Ready with open items, or Not ready with blockers. Every blocker and every
// open item is listed, and each one links to the place where it is resolved or to the evidence drawer.
import { CircleCheck, OctagonX, TriangleAlert } from 'lucide-react';
import type { AwardResult } from '../../../engine/award';
import { formatIndian } from '../../../engine/format';
import type { CompareResponse } from '@/lib/api-types';
import { useApp, type Tab } from '@/lib/store';
import { Btn, Card } from '@/components/ui';
import { StatusMark } from '@/lib/status';
import { cn } from '@/lib/utils';

/** Where each kind of item is resolved. */
export function targetFor(kind: string): { tab: Tab; label: string } {
  if (kind.startsWith('knockout')) return { tab: 'questionnaire', label: 'Open questionnaire' };
  if (['attachment_name_mismatch', 'certificate_expired', 'certificate_expiring', 'suspicious_content', 'low_visibility_text'].includes(kind)) return { tab: 'attachments', label: 'Open attachments' };
  return { tab: 'review', label: 'Open review queue' };
}

type Cell = { vendor_key: string; line_code: string; status: 'needs_review' | 'conflict'; value: number; vendor_id: string; line_id: string; quote_line_id: string | null };

/** Needs review and Conflict cells of the vendors the scenario includes: the cells behind a blocker. */
export function unresolvedCells(data: CompareResponse, included: string[]): Cell[] {
  const vendor = new Map(data.vendors.map((v) => [v.id, v]));
  const line = new Map(data.lines.map((l) => [l.id, l]));
  const out: Cell[] = [];
  for (const c of data.cells) {
    const v = vendor.get(c.vendor_id);
    const l = line.get(c.rfx_line_id);
    if (!v || !l || !included.includes(v.key) || (c.status !== 'needs_review' && c.status !== 'conflict')) continue;
    out.push({ vendor_key: v.key, line_code: l.code, status: c.status, value: (c.price ?? 0) * l.annual_qty, vendor_id: v.id, line_id: l.id, quote_line_id: c.quote_line_id });
  }
  return out.sort((a, b) => b.value - a.value);
}

export function ReadinessPanel({ result, data }: { result: AwardResult; data: CompareResponse }) {
  const { setPage, setTab, openCell } = useApp();
  const r = result.readiness;
  const Icon = r.level === 'ready' ? CircleCheck : r.level === 'ready_with_open_items' ? TriangleAlert : OctagonX;
  const tone = r.level === 'ready' ? 'border-green-300 bg-green-50 text-status-confirmed' : r.level === 'ready_with_open_items' ? 'border-amber-300 bg-amber-50 text-status-assumed' : 'border-red-300 bg-red-50 text-status-conflict';
  const go = (tab: Tab) => {
    setPage('comparison');
    setTab(tab);
  };
  const cells = unresolvedCells(data, r.included_vendors);
  const idOf = (key: string, code: string) => ({ v: data.vendors.find((x) => x.key === key)?.id ?? '', l: data.lines.find((x) => x.code === code)?.id ?? '' });
  const assumed = result.reliance.not_confirmed.filter((x) => x.status === 'assumed');

  const Row = ({ vendor, message, kind, blocker }: { vendor: string | null; message: string; kind: string; blocker: boolean }) => {
    const t = targetFor(kind);
    return (
      <li className="flex items-start gap-2 text-sm">
        {blocker ? <OctagonX size={14} className="mt-0.5 shrink-0 text-status-conflict" aria-hidden /> : <TriangleAlert size={14} className="mt-0.5 shrink-0 text-status-assumed" aria-hidden />}
        <span className="min-w-0 flex-1">
          {vendor ? <span className="font-medium">{vendor}: </span> : null}
          {message}
        </span>
        {kind === 'assumed_cells' || kind === 'coverage_gaps' ? null : (
          <Btn small variant="ghost" className="shrink-0" onClick={() => go(t.tab)}>
            {t.label}
          </Btn>
        )}
      </li>
    );
  };

  return (
    <Card className="p-4" aria-label="Scenario readiness">
      <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2', tone)}>
        <Icon size={18} className="mt-0.5 shrink-0" aria-hidden />
        <div>
          <p className="text-base font-semibold">
            <span className="sr-only">Readiness for this scenario: </span>
            {r.label}
            {r.level === 'not_ready' ? ' with blockers' : ''}
          </p>
          <p className="text-sm text-foreground">
            {r.summary} Judged for the vendors in this scenario: {r.included_vendors.length ? r.included_vendors.join(', ') : 'none'}.
          </p>
        </div>
      </div>

      {r.blockers.length > 0 ? (
        <section className="mt-3" aria-label="Blockers">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Blockers ({r.blockers.length})</h3>
          <ul className="mt-1.5 space-y-1.5">
            {r.blockers.map((b, i) => (
              <Row key={i} vendor={b.vendor_key} message={b.message} kind={b.kind} blocker />
            ))}
          </ul>
          {cells.length > 0 ? (
            <details className="mt-2 rounded-md border border-border" open>
              <summary className="cursor-pointer px-3 py-1.5 text-sm font-medium">Cells behind these blockers ({cells.length})</summary>
              <ul className="divide-y divide-border">
                {cells.map((c) => (
                  <li key={`${c.vendor_key}${c.line_code}`} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                    <span className="w-8 font-medium">{c.vendor_key}</span>
                    <span className="w-24">{c.line_code}</span>
                    <StatusMark status={c.status} />
                    <span className="tabular ml-auto text-xs text-muted-foreground">Rs {formatIndian(c.value, 0)} a year</span>
                    <Btn small onClick={() => openCell(c.vendor_id, c.line_id, c.quote_line_id)}>
                      Open evidence
                    </Btn>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {r.open_items.length > 0 ? (
        <section className="mt-3" aria-label="Open items">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open items before a PO ({r.open_items.length})</h3>
          <ul className="mt-1.5 space-y-1.5">
            {r.open_items.map((o, i) => (
              <Row key={i} vendor={o.vendor_key} message={o.message} kind={o.kind} blocker={false} />
            ))}
          </ul>
          {assumed.length > 0 ? (
            <details className="mt-2 rounded-md border border-border">
              <summary className="cursor-pointer px-3 py-1.5 text-sm font-medium">Assumed prices this award relies on ({assumed.length})</summary>
              <ul className="divide-y divide-border">
                {assumed.map((c) => {
                  const ids = idOf(c.vendor_key, c.line_code);
                  return (
                    <li key={`${c.vendor_key}${c.line_code}`} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                      <span className="w-8 font-medium">{c.vendor_key}</span>
                      <span className="w-24">{c.line_code}</span>
                      <StatusMark status="assumed" />
                      <span className="tabular ml-auto text-xs text-muted-foreground">Rs {formatIndian(c.annual_value_inr, 0)} a year</span>
                      <Btn small onClick={() => openCell(ids.v, ids.l, c.quote_line_id)}>
                        Open evidence
                      </Btn>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
          {result.coverage_gaps.length > 0 ? (
            <details className="mt-2 rounded-md border border-border">
              <summary className="cursor-pointer px-3 py-1.5 text-sm font-medium">Lines not covered ({result.coverage_gaps.length})</summary>
              <ul className="divide-y divide-border">
                {result.coverage_gaps.map((g) => (
                  <li key={g.line_code} className="px-3 py-1.5 text-sm">
                    <span className="font-medium">{g.line_code}</span>: {g.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
      {r.blockers.length === 0 && r.open_items.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Nothing is open for the vendors in this scenario.</p> : null}
    </Card>
  );
}
