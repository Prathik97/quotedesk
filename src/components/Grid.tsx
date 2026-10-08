// The comparison grid (FR-6.1 to FR-6.3, FR-6.6): 30 lines by 5 vendors, with the
// status vocabulary, vendor headers, lowest eligible price and the four toggles.
import { VendorNotes } from './VendorNotes';
import { Check, CircleCheck, Clock, OctagonX, Paperclip, Tag } from 'lucide-react';
import { useMemo, useRef, type KeyboardEvent } from 'react';
import { certaintyCounts, toCellStatus } from '../../engine/certainty';
import { formatIndian, formatInrCompact, formatPct, formatQty, formatRupee } from '../../engine/format';
import { discountedPrice, evaluateDiscounts, type ConditionalDiscount, type DiscountOutcome } from '../../engine/scenario';
import { lowestIndices, vendorTotal } from '../../engine/totals';
import type { GridCell, VendorHeader } from '@/lib/api-types';
import { useApp } from '@/lib/store';
import { STATUS_LABEL, StatusMark } from '@/lib/status';
import { cn } from '@/lib/utils';
import { Legend } from './Legend';
import { Chip } from './ui';

type Shown = { cell: GridCell; base: number | null; price: number | null; discountPct: number | null; delta: number | null; value: number | null };

export function Grid() {
  const { data, toggles, setToggle, statusFilter, setStatusFilter, openCell, setTab, flashIds } = useApp();
  const wrap = useRef<HTMLTableElement>(null);

  const model = useMemo(() => {
    if (!data) return null;
    const lines = data.lines;
    const cellMap = new Map(data.cells.map((c) => [`${c.vendor_id}:${c.rfx_line_id}`, c]));
    const vendors = data.vendors;
    const outcomes = new Map<string, DiscountOutcome[]>();
    for (const v of vendors) {
      if (v.discounts.length === 0) continue;
      const cs = lines.map((l) => {
        const c = cellMap.get(`${v.id}:${l.id}`);
        return { code: l.code, price: c?.price ?? null, annual_qty: l.annual_qty, conditions: c?.conditions ?? [] };
      });
      outcomes.set(v.id, evaluateDiscounts(v.discounts as ConditionalDiscount[], cs));
    }
    const shown = new Map<string, Shown>();
    for (const l of lines) {
      for (const v of vendors) {
        const c = cellMap.get(`${v.id}:${l.id}`);
        if (!c) continue;
        const base = c.price;
        let price = base;
        let pct: number | null = null;
        if (base != null && toggles.includeDiscounts) {
          const d = discountedPrice(base, l.code, outcomes.get(v.id) ?? []);
          price = d.price;
          pct = d.applied.length ? d.applied.reduce((a, b) => a + b, 0) : null;
        }
        shown.set(`${v.id}:${l.id}`, {
          cell: c,
          base,
          price,
          discountPct: pct,
          delta: price != null && l.ly_rate ? (price / l.ly_rate - 1) * 100 : null,
          value: price != null ? price * l.annual_qty : null,
        });
      }
    }
    const eligible = (v: VendorHeader) => !toggles.onlyCleared || v.questionnaire === 'Cleared';
    // Lowest eligible price per line: confirmed or assumed values from eligible vendors only.
    const lowest = new Map<string, Set<string>>();
    for (const l of lines) {
      const prices = vendors.map((v) => {
        const s = shown.get(`${v.id}:${l.id}`);
        return s && (s.cell.status === 'confirmed' || s.cell.status === 'assumed') ? s.price : null;
      });
      const idx = lowestIndices(prices, vendors.map(eligible));
      lowest.set(l.id, new Set(idx.map((i) => vendors[i]?.id ?? '')));
    }
    const totals = new Map(
      vendors.map((v) => [
        v.id,
        vendorTotal(
          lines.map((l) => {
            const s = shown.get(`${v.id}:${l.id}`);
            return { annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate, price: s?.price ?? null, status: s?.cell.status ?? 'missing' };
          }),
          { terms: v.freight_terms, amount_inr: v.freight_amount_inr },
        ),
      ]),
    );
    const lyFor = (v: VendorHeader) => lines.reduce((s, l) => (shown.get(`${v.id}:${l.id}`)?.price != null ? s + (l.ly_rate ?? 0) * l.annual_qty : s), 0);
    return { lines, vendors, shown, outcomes, lowest, totals, eligible, lyFor };
  }, [data, toggles.includeDiscounts, toggles.onlyCleared]);

  if (!data || !model) return null;
  const { lines, vendors, shown, outcomes, lowest, totals, eligible, lyFor } = model;

  const needsAttention = (lineId: string) => vendors.some((v) => ['needs_review', 'conflict', 'missing'].includes(shown.get(`${v.id}:${lineId}`)?.cell.status ?? 'missing'));
  const hasStatus = (lineId: string, s: string) => vendors.some((v) => shown.get(`${v.id}:${lineId}`)?.cell.status === s);
  const visible = lines.filter((l) => (!toggles.onlyAttention || needsAttention(l.id)) && (!statusFilter || hasStatus(l.id, statusFilter)));

  // Section groups in RFx order
  const groups: { section: string; lines: typeof lines }[] = [];
  for (const l of visible) {
    const g = groups[groups.length - 1];
    if (g && g.section === l.section) g.lines.push(l);
    else groups.push({ section: l.section, lines: [l] });
  }

  const onKey = (e: KeyboardEvent<HTMLTableElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== 'BUTTON' || t.dataset.ri === undefined) return;
    const r = Number(t.dataset.ri);
    const c = Number(t.dataset.ci);
    let nr = r;
    let nc = c;
    if (e.key === 'ArrowDown') nr++;
    else if (e.key === 'ArrowUp') nr--;
    else if (e.key === 'ArrowRight') nc++;
    else if (e.key === 'ArrowLeft') nc--;
    else if (e.key === 'PageDown') nr += 5;
    else if (e.key === 'PageUp') nr -= 5;
    else if (e.key === 'Home') nc = 0;
    else if (e.key === 'End') nc = vendors.length - 1;
    else return;
    e.preventDefault();
    nr = Math.max(0, Math.min(visible.length - 1, nr));
    nc = Math.max(0, Math.min(vendors.length - 1, nc));
    wrap.current?.querySelector<HTMLButtonElement>(`button[data-ri="${nr}"][data-ci="${nc}"]`)?.focus();
  };

  const rowOf = new Map(visible.map((l, i) => [l.id, i]));
  const unitLabel = (u: string) => u;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-border bg-card px-3 py-2" role="group" aria-label="Grid filters and toggles">
        <Toggle label="Only vendors who cleared the questionnaire" checked={toggles.onlyCleared} onChange={(v) => setToggle('onlyCleared', v)} />
        <Toggle label="Include conditional discounts when the threshold is met" checked={toggles.includeDiscounts} onChange={(v) => setToggle('includeDiscounts', v)} />
        <Toggle label="Show annual value instead of unit price" checked={toggles.annualValue} onChange={(v) => setToggle('annualValue', v)} />
        <Toggle label="Show only lines needing attention" checked={toggles.onlyAttention} onChange={(v) => setToggle('onlyAttention', v)} />
      </div>
      {statusFilter ? (
        <div role="status" className="flex items-center gap-3 rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm">
          <span>
            Showing lines with at least one <strong>{STATUS_LABEL[statusFilter]}</strong> cell. Other cells are dimmed.
          </span>
          <button type="button" className="rounded border border-border bg-card px-2 py-0.5 text-xs hover:bg-muted" onClick={() => setStatusFilter(null)}>
            Clear filter
          </button>
        </div>
      ) : null}
      {toggles.onlyCleared ? (
        <p className="text-xs text-muted-foreground">
          Vendors who did not clear the questionnaire are dimmed and cannot hold the lowest price. Pending and Failed are both left out; the questionnaire tab shows why.
        </p>
      ) : null}

      <div className="max-h-[calc(100vh-17rem)] min-h-[420px] overflow-auto rounded-lg border border-border bg-card">
        <table ref={wrap} role="grid" aria-label="Normalized unit price by line and vendor, INR per base unit excluding GST" aria-rowcount={visible.length} onKeyDown={onKey} className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: 220 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 76 }} />
            {vendors.map((v) => (
              <col key={v.id} style={{ width: 130 }} />
            ))}
          </colgroup>
          <thead>
            <tr className="sticky top-0 z-20 bg-slate-100 text-left text-xs">
              <th scope="col" className="sticky left-0 z-30 border-b border-r border-border bg-slate-100 px-2 py-2 font-semibold">
                Line
              </th>
              <th scope="col" className="border-b border-r border-border px-2 py-2 text-right font-semibold">
                Annual qty
              </th>
              <th scope="col" className="border-b border-r border-border px-2 py-2 text-right font-semibold">
                Last year rate
              </th>
              {vendors.map((v) => (
                <th key={v.id} scope="col" className={cn('border-b border-r border-border px-2 py-2 align-top', !eligible(v) && 'opacity-50')}>
                  <div className="font-semibold leading-tight">{v.name}</div>
                  <div className="text-[11px] font-normal text-muted-foreground">{v.key}</div>
                </th>
              ))}
            </tr>
            <tr className="bg-white text-[11px] align-top">
              <th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-white px-2 py-2 text-left font-medium text-muted-foreground">
                Vendor summary
              </th>
              <td className="border-b border-r border-border" />
              <td className="border-b border-r border-border" />
              {vendors.map((v) => (
                <td key={v.id} className={cn('border-b border-r border-border px-2 py-2 align-top', !eligible(v) && 'opacity-50')}>
                  <VendorDetails v={v} outcomes={outcomes.get(v.id)} excluded={!eligible(v)} onTab={setTab} />
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <SectionRows key={g.section} g={g} />
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={3 + vendors.length} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No lines match these filters. Clear a filter to see all 30 lines.
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 text-xs">
              <th scope="row" colSpan={3} className="sticky left-0 border-t border-r border-border bg-slate-50 px-2 py-2 text-left font-semibold">
                Total at annual quantity, quoted lines only
                <div className="font-normal text-muted-foreground">Last year, same lines, shown beneath</div>
              </th>
              {vendors.map((v) => {
                const t = totals.get(v.id);
                const ly = lyFor(v);
                const d = ly > 0 && t ? (t.goods_total_inr / ly - 1) * 100 : null;
                return (
                  <td key={v.id} className={cn('border-t border-r border-border px-2 py-2 align-top tabular', !eligible(v) && 'opacity-50')}>
                    <div className="text-sm font-semibold">{t ? formatInrCompact(t.goods_total_inr) : ''}</div>
                    <div className="text-muted-foreground">
                      {formatInrCompact(ly)} {d != null ? <span>({formatPct(d)})</span> : null}
                    </div>
                    <div className="text-muted-foreground">
                      {t?.lines_priced} of {t?.lines_total} lines
                    </div>
                  </td>
                );
              })}
            </tr>
            <tr className="bg-slate-50 text-xs">
              <th scope="row" colSpan={3} className="sticky left-0 border-b border-r border-border bg-slate-50 px-2 py-2 text-left font-semibold">
                Landed total with freight
                <div className="font-normal text-muted-foreground">Unknown freight is never counted as zero</div>
              </th>
              {vendors.map((v) => {
                const t = totals.get(v.id);
                if (!t) return <td key={v.id} className="border-b border-r border-border" />;
                return (
                  <td key={v.id} className={cn('border-b border-r border-border px-2 py-2 align-top tabular', !eligible(v) && 'opacity-50')}>
                    {t.complete ? (
                      <div className="text-sm font-semibold">{formatInrCompact(t.landed_total_inr)}</div>
                    ) : (
                      <div title={t.incomplete_reasons.join(' ')}>
                        <Chip tone="warn">Incomplete</Chip>
                        <div className="mt-1 text-muted-foreground">At least {formatInrCompact(t.landed_total_inr)}</div>
                        <div className="text-muted-foreground">{t.incomplete_reasons.map((r) => r.replace(/\.$/, '')).join('. ')}</div>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <Legend />
    </div>
  );

  function SectionRows({ g }: { g: { section: string; lines: typeof lines } }) {
    return (
      <>
        <tr className="bg-slate-50">
          <th scope="rowgroup" colSpan={3 + vendors.length} className="sticky left-0 border-b border-t border-border px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-2">
            {g.section} <span className="font-normal normal-case text-muted-foreground">({g.lines.length} {g.lines.length === 1 ? 'line' : 'lines'})</span>
          </th>
        </tr>
        {g.lines.map((l) => {
          const ri = rowOf.get(l.id) ?? 0;
          return (
            <tr key={l.id} className="group">
              <th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-card px-2 py-1.5 text-left align-top font-normal">
                <div className="text-xs font-semibold tabular text-ink-2">{l.code}</div>
                <div className="line-clamp-2 text-xs leading-snug" title={l.description}>
                  {l.description}
                </div>
              </th>
              <td className="border-b border-r border-border px-2 py-1.5 text-right align-top text-xs tabular">
                {formatQty(l.annual_qty)}
                <div className="text-muted-foreground">{unitLabel(l.uom)}</div>
              </td>
              <td className="border-b border-r border-border px-2 py-1.5 text-right align-top text-xs tabular">{l.ly_rate != null ? formatIndian(l.ly_rate, 2) : <span className="text-muted-foreground">Not available</span>}</td>
              {vendors.map((v, ci) => {
                const s = shown.get(`${v.id}:${l.id}`);
                if (!s) return <td key={v.id} className="border-b border-r border-border" />;
                const status = toCellStatus(s.cell.status);
                const isLowest = lowest.get(l.id)?.has(v.id) === true && s.price != null;
                const dim = !eligible(v) || (statusFilter != null && status !== statusFilter);
                const showValue = toggles.annualValue;
                const main = s.price == null ? null : showValue ? formatIndian(s.value ?? 0, 0) : formatIndian(s.price, 2);
                const label = `${v.name}, ${l.code}: ${main == null ? 'not quoted' : `${showValue ? 'annual value' : 'unit price'} rupees ${main}`}${s.delta != null ? `, ${formatPct(s.delta)} against last year` : ''}, ${STATUS_LABEL[status]}${isLowest ? ', lowest price' : ''}. Open evidence.`;
                const flashing = flashIds.has(`${v.id}:${l.id}`);
                const conditional = s.cell.conditions.length > 0 && s.discountPct == null;
                return (
                  <td key={v.id} role="gridcell" className={cn('border-b border-r border-border p-0 align-top', isLowest && 'bg-accent-soft', dim && 'opacity-40')}>
                    <button
                      type="button"
                      data-ri={ri}
                      data-ci={ci}
                      aria-label={label}
                      onClick={() => openCell(v.id, l.id, s.cell.quote_line_id)}
                      tabIndex={ri === 0 && ci === 0 ? 0 : -1}
                      onFocus={(e) => e.currentTarget.setAttribute('tabindex', '0')}
                      onBlur={(e) => e.currentTarget.setAttribute('tabindex', '-1')}
                      className={cn('block h-full w-full px-2 py-1.5 text-left hover:bg-slate-50', isLowest && 'border-l-[3px] border-accent hover:bg-teal-100', flashing && 'qd-flash')}
                    >
                      {main == null ? (
                        <div className="py-1">
                          <StatusMark status="missing" />
                          <div className="text-[11px] text-muted-foreground">Not quoted</div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-baseline justify-between gap-1 tabular">
                            <span className="text-sm font-semibold">{showValue ? '' : '₹'}{main}</span>
                            {s.delta != null ? <span className="text-[11px] text-muted-foreground">{formatPct(s.delta)}</span> : null}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5">
                            <StatusMark status={status} />
                            {s.cell.buyer_verified ? (
                              <span className="inline-flex items-center gap-0.5 text-[11px] text-ink-2" title="A person checked this value against the source">
                                <Check size={11} aria-hidden /> Checked
                              </span>
                            ) : null}
                          </div>
                          {isLowest ? (
                            <div className="text-[11px] font-semibold text-accent">
                              Lowest price
                              {v.questionnaire !== 'Cleared' ? <span className="block font-semibold text-status-conflict">Questionnaire {v.questionnaire?.toLowerCase() ?? 'not assessed'}</span> : null}
                            </div>
                          ) : null}
                          {s.discountPct != null ? (
                            <div className="text-[11px] text-ink-2 tabular" title="Conditional discount applied because the threshold is met">
                              {formatPct(-s.discountPct, 0)} discount applied
                              {s.base != null ? <span className="text-muted-foreground"> from {formatIndian(s.base, 2)}</span> : null}
                            </div>
                          ) : conditional ? (
                            <div className="inline-flex items-center gap-0.5 text-[11px] text-ink-2" title={s.cell.conditions.join('; ')}>
                              <Tag size={11} aria-hidden /> Conditional discount, not applied
                            </div>
                          ) : null}
                        </>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          );
        })}
      </>
    );
  }
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-teal-700" />
      {label}
    </label>
  );
}

function VendorDetails({ v, outcomes, excluded, onTab }: { v: VendorHeader; outcomes?: DiscountOutcome[]; excluded: boolean; onTab: (t: 'review' | 'questionnaire' | 'attachments') => void }) {
  const q = v.questionnaire;
  const counts = certaintyCounts([]);
  void counts;
  return (
    <div className="space-y-1 leading-snug">
      <div className="font-medium tabular">
        {v.coverage.quoted} of {v.coverage.total} quoted
      </div>
      <button type="button" onClick={() => onTab('questionnaire')} className="inline-flex items-center gap-1 rounded hover:bg-muted" aria-label={`Questionnaire result: ${q ?? 'Not assessed'}. Open the questionnaire tab`}>
        {q === 'Cleared' ? <CircleCheck size={13} className="text-status-confirmed" aria-hidden /> : q === 'Failed' ? <OctagonX size={13} className="text-status-conflict" aria-hidden /> : <Clock size={13} className="text-status-assumed" aria-hidden />}
        <span className={cn('font-medium', q === 'Cleared' && 'text-status-confirmed', q === 'Failed' && 'text-status-conflict', q === 'Pending' && 'text-status-assumed')}>Questionnaire {q ?? 'not assessed'}</span>
      </button>
      {excluded ? <div className="font-medium text-status-conflict">Excluded by the filter</div> : null}
      <div>
        Freight <span className="font-medium">{v.freight_terms === 'included' ? 'included' : v.freight_terms === 'extra' ? (v.freight_amount_inr != null ? `extra, ${formatRupee(v.freight_amount_inr, 0)}` : 'extra, no amount') : 'not stated'}</span>
      </div>
      <div>
        Payment <span className="font-medium">{v.payment_terms_days != null ? `${v.payment_terms_days} days` : 'not stated'}</span>
      </div>
      {v.validity_text ? (
        <div>
          Validity <span className="font-medium">{v.validity_text}</span>
        </div>
      ) : null}
      <VendorNotes notes={v.notes} warning={v.validity_warning} compact />
      <button type="button" onClick={() => onTab('attachments')} className="inline-flex items-center gap-1 rounded hover:bg-muted">
        <Paperclip size={12} aria-hidden /> {v.attachments} {v.attachments === 1 ? 'attachment' : 'attachments'}
      </button>
      <div>
        <button type="button" onClick={() => onTab('review')} className="rounded text-left hover:bg-muted" aria-label={`${v.open_warnings} open warnings. Open the review queue`}>
          <span className={cn('font-medium tabular', v.open_warnings > 0 && 'text-status-assumed')}>{v.open_warnings}</span> open {v.open_warnings === 1 ? 'warning' : 'warnings'}
        </button>
      </div>
      <div className="text-muted-foreground">Extraction: {v.extraction.status.toLowerCase()}</div>
      {outcomes?.map((o) => (
        <div key={o.discount_id} className="rounded border border-border bg-slate-50 px-1.5 py-1 text-[11px]">
          <div className="font-medium">
            {o.percent}% conditional discount{o.threshold_inr != null ? ` above ${formatInrCompact(o.threshold_inr)}` : ''}
          </div>
          <div className="text-muted-foreground">
            {o.met === null ? 'Threshold not understood, never applied.' : o.met ? `Threshold met at ${formatInrCompact(o.po_value_inr)}. Saves ${formatInrCompact(o.potential_saving_inr)} when applied.` : `Below threshold at ${formatInrCompact(o.po_value_inr)}.`}
            {o.single_po_only ? ' One PO only.' : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
