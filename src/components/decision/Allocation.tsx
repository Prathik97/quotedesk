// The scenario result: totals, allocation by vendor and by line, concentration, coverage gaps and landed
// cost completeness. Every price opens the evidence drawer.
import type { AwardResult } from '../../../engine/award';
import { toCellStatus } from '../../../engine/certainty';
import { formatIndian, formatInrCompact } from '../../../engine/format';
import type { CompareResponse } from '@/lib/api-types';
import { useApp } from '@/lib/store';
import { StatusMark } from '@/lib/status';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('tabular mt-0.5 text-lg font-semibold', tone === 'warn' && 'text-status-assumed')}>{value}</p>
      {sub ? <p className="tabular text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function Totals({ result }: { result: AwardResult }) {
  const t = result.totals;
  const c = result.concentration;
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5" aria-label="Scenario totals">
      <Metric label="Goods total, excluding GST" value={formatInrCompact(t.goods_total_inr)} sub={`Rs ${formatIndian(t.goods_total_inr, 0)}`} />
      <Metric
        label={t.landed_complete ? 'Landed total' : 'Landed total, at least'}
        value={formatInrCompact(t.landed_total_inr)}
        sub={t.landed_complete ? 'Freight known for every vendor' : 'Freight unknown for a vendor in the award'}
        tone={t.landed_complete ? undefined : 'warn'}
      />
      <Metric
        label={t.savings_vs_ly_inr >= 0 ? 'Saving against last year' : 'Extra cost against last year'}
        value={formatInrCompact(Math.abs(t.savings_vs_ly_inr))}
        sub={`${t.savings_vs_ly_pct == null ? 'n/a' : `${Math.abs(t.savings_vs_ly_pct).toFixed(2)}%`} on the same ${t.lines_awarded} lines`}
      />
      <Metric label="Lines awarded" value={`${t.lines_awarded} of ${t.lines_total}`} sub={result.coverage_gaps.length ? `${result.coverage_gaps.length} not covered` : 'No coverage gaps'} tone={result.coverage_gaps.length ? 'warn' : undefined} />
      <Metric label="Concentration" value={c.top_vendor_key ? `${c.top_vendor_key} ${(c.top_share * 100).toFixed(1)}%` : 'None'} sub={`${c.vendor_count} ${c.vendor_count === 1 ? 'vendor' : 'vendors'}, Herfindahl ${c.hhi.toFixed(3)}`} />
    </div>
  );
}

export function ByVendor({ result }: { result: AwardResult }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="px-3 py-2 text-left text-sm font-semibold">Allocation by vendor</caption>
        <thead>
          <tr className="border-y border-border bg-muted text-left text-xs text-ink-2">
            <th className="px-3 py-1.5 font-medium">Vendor</th>
            <th className="px-3 py-1.5 text-right font-medium">Lines</th>
            <th className="px-3 py-1.5 text-right font-medium">Goods value (Rs)</th>
            <th className="px-3 py-1.5 text-right font-medium">Share</th>
            <th className="px-3 py-1.5 font-medium">Freight</th>
            <th className="px-3 py-1.5 text-right font-medium">Landed total (Rs)</th>
            <th className="px-3 py-1.5 font-medium">Questionnaire</th>
          </tr>
        </thead>
        <tbody>
          {result.by_vendor.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-4 text-muted-foreground">
                No vendor receives a line under these filters.
              </td>
            </tr>
          ) : null}
          {result.by_vendor.map((v) => (
            <tr key={v.vendor_key} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5">
                <span className="font-medium">{v.vendor_key}</span> {v.vendor_name}
              </td>
              <td className="tabular px-3 py-1.5 text-right">{v.lines}</td>
              <td className="tabular px-3 py-1.5 text-right">{formatIndian(v.goods_value_inr, 0)}</td>
              <td className="px-3 py-1.5 text-right">
                <span className="tabular">{(v.share * 100).toFixed(1)}%</span>
                <span className="ml-2 inline-block h-1.5 w-16 rounded bg-muted align-middle" aria-hidden>
                  <span className="block h-1.5 rounded bg-accent" style={{ width: `${Math.min(100, v.share * 100)}%` }} />
                </span>
              </td>
              <td className="px-3 py-1.5">{v.freight_terms === 'included' ? 'Included' : v.freight_terms === 'extra' ? (v.freight_amount_inr == null ? <span className="text-status-assumed">Extra, no amount</span> : `Extra, Rs ${formatIndian(v.freight_amount_inr, 0)}`) : <span className="text-status-assumed">Not stated</span>}</td>
              <td className="tabular px-3 py-1.5 text-right">
                {formatIndian(v.landed_total_inr, 0)}
                {v.landed_complete ? null : <span className="ml-1 text-xs text-status-assumed">at least</span>}
              </td>
              <td className="px-3 py-1.5">{v.questionnaire ?? 'Not read'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.by_vendor.some((v) => !v.landed_complete) ? (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Landed totals marked "at least" leave out freight that the vendor has not priced. Freight is never assumed to be zero.
        </p>
      ) : null}
    </Card>
  );
}

export function ByLine({ result, data }: { result: AwardResult; data: CompareResponse }) {
  const { openCell } = useApp();
  const vendorId = new Map(data.vendors.map((v) => [v.key, v.id]));
  const desc = new Map(data.lines.map((l) => [l.code, l.description]));
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="px-3 py-2 text-left text-sm font-semibold">Allocation by line</caption>
        <thead>
          <tr className="border-y border-border bg-muted text-left text-xs text-ink-2">
            <th className="px-3 py-1.5 font-medium">Line</th>
            <th className="px-3 py-1.5 font-medium">Vendor</th>
            <th className="px-3 py-1.5 text-right font-medium">Annual qty</th>
            <th className="px-3 py-1.5 text-right font-medium">Price (Rs)</th>
            <th className="px-3 py-1.5 font-medium">Status</th>
            <th className="px-3 py-1.5 text-right font-medium">Annual value (Rs)</th>
            <th className="px-3 py-1.5 text-right font-medium">Saving vs last year (Rs)</th>
            <th className="px-3 py-1.5 font-medium">Next best</th>
          </tr>
        </thead>
        <tbody>
          {result.allocation.map((a) => (
            <tr key={a.line_id} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5">
                <span className="font-medium">{a.line_code}</span>
                <span className="block max-w-[22rem] truncate text-xs text-muted-foreground" title={desc.get(a.line_code)}>
                  {desc.get(a.line_code)}
                </span>
              </td>
              <td className="px-3 py-1.5 font-medium">{a.vendor_key ?? <span className="font-normal text-status-assumed">Not covered</span>}</td>
              <td className="tabular px-3 py-1.5 text-right">
                {formatIndian(a.annual_qty, 0)} <span className="text-xs text-muted-foreground">{a.uom}</span>
              </td>
              <td className="tabular px-3 py-1.5 text-right">
                {a.price == null || !a.vendor_key ? (
                  <span className="text-muted-foreground">n/a</span>
                ) : (
                  <button
                    type="button"
                    className="rounded px-1 underline decoration-dotted underline-offset-2 hover:bg-muted"
                    title="Open the evidence for this price"
                    aria-label={`${a.line_code} ${a.vendor_key} price ${a.price.toFixed(2)}. Open evidence`}
                    onClick={() => openCell(vendorId.get(a.vendor_key as string) ?? '', a.line_id, a.quote_line_id)}
                  >
                    {formatIndian(a.price, 2)}
                    {a.discount_pct ? '*' : ''}
                  </button>
                )}
              </td>
              <td className="px-3 py-1.5">{a.status ? <StatusMark status={toCellStatus(a.status)} /> : <StatusMark status="missing" />}</td>
              <td className="tabular px-3 py-1.5 text-right">{a.annual_value_inr == null ? 'n/a' : formatIndian(a.annual_value_inr, 0)}</td>
              <td className={cn('tabular px-3 py-1.5 text-right', a.saving_vs_ly_inr != null && a.saving_vs_ly_inr < 0 && 'text-status-conflict')}>{a.saving_vs_ly_inr == null ? 'n/a' : formatIndian(a.saving_vs_ly_inr, 0)}</td>
              <td className="tabular px-3 py-1.5 text-xs text-muted-foreground">{a.runner_up ? `${a.runner_up.vendor_key} at ${formatIndian(a.runner_up.price, 2)}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        Prices are INR per base unit excluding GST. * is after a conditional discount. Not covered means no eligible vendor quoted a usable price: it is a gap, never zero.
      </p>
    </Card>
  );
}

export function Extras({ result }: { result: AwardResult }) {
  const discounts = result.discounts;
  return (
    <>
      {discounts.length > 0 ? (
        <Card className="p-3">
          <h3 className="text-sm font-semibold">Conditional discounts</h3>
          <ul className="mt-1.5 space-y-1.5 text-sm">
            {discounts.map((d, i) => (
              <li key={i}>
                <span className="font-medium">
                  {d.vendor_key}, {d.percent} percent:
                </span>{' '}
                {d.condition}. {d.applied ? `Applied, saving Rs ${formatIndian(d.saving_inr, 0)}.` : d.met === false ? `Not met: the allocation is Rs ${formatIndian(d.vendor_po_value_inr, 0)} at list price${d.gap_to_threshold_inr ? `, Rs ${formatIndian(d.gap_to_threshold_inr, 0)} short` : ''}.` : d.met == null ? 'The threshold could not be read, so it is not applied.' : 'Met, but not applied in this scenario.'}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-muted-foreground">{result.fixed_point.note}</p>
        </Card>
      ) : null}
      {result.warnings.length > 0 ? (
        <Card className="p-3">
          <h3 className="text-sm font-semibold">Notes from the award engine</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card className="p-3 text-sm">
        <h3 className="font-semibold">Prices this result relies on</h3>
        <p className="mt-1">
          {result.reliance.confirmed} Confirmed (Rs {formatIndian(result.reliance.confirmed_value_inr, 0)}), {result.reliance.assumed} Assumed (Rs {formatIndian(result.reliance.assumed_value_inr, 0)}), {result.reliance.needs_review} Needs review, {result.reliance.conflict} Conflict, {result.reliance.missing} lines not covered.
        </p>
        {result.unresolved_that_change_result.length > 0 ? <p className="mt-1 text-status-conflict">{result.unresolved_that_change_result.length} unresolved prices would change this result if taken as read.</p> : null}
      </Card>
    </>
  );
}
