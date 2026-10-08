// FR-8.1 sensitivity: the USD rate at 85, 96 and 105 with and without the conditional discount, and the
// cost if the top vendor is lost. Each figure is the award engine run again, nothing is estimated.
import type { Sensitivity, SensitivityCell } from '../../../engine/decision';
import { formatIndian } from '../../../engine/format';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';

function money(c: SensitivityCell): string {
  return c.ok ? formatIndian(c.goods_inr, 0) : 'n/a';
}

export function SensitivityPanel({ s }: { s: Sensitivity }) {
  const lost = s.top_vendor_lost;
  return (
    <Card className="p-4" aria-label="Sensitivity">
      <h2 className="text-sm font-semibold">Sensitivity</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Each figure is the award run again with one thing changed. Goods totals, excluding GST, in rupees.</p>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-y border-border bg-muted text-left text-xs text-ink-2">
            <th className="px-3 py-1.5 font-medium">USD to INR rate</th>
            <th className="px-3 py-1.5 text-right font-medium">Without the conditional discount</th>
            <th className="px-3 py-1.5 text-right font-medium">With the conditional discount</th>
          </tr>
        </thead>
        <tbody>
          {s.fx.map((r) => (
            <tr key={r.usd_inr} className={cn('border-b border-border last:border-0', r.is_current && 'bg-teal-50')}>
              <td className="tabular px-3 py-1.5 font-medium">
                {r.usd_inr}
                {r.is_current ? <span className="ml-2 text-xs font-normal text-muted-foreground">current rate</span> : null}
              </td>
              <td className="tabular px-3 py-1.5 text-right">{money(r.without_discount)}</td>
              <td className="tabular px-3 py-1.5 text-right">{money(r.with_discount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-xs text-muted-foreground">{s.fx_note}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{s.discount_note}</p>

      <h3 className="mt-4 text-sm font-semibold">If the top vendor is lost</h3>
      {!lost ? (
        <p className="mt-1 text-sm text-muted-foreground">No vendor holds any award, so there is nothing to lose.</p>
      ) : (
        <div className="mt-1 text-sm">
          {lost.strategy_note ? <p className="mb-1 text-status-assumed">{lost.strategy_note}</p> : null}
          <p>
            <span className="font-medium">{lost.vendor_key}</span> holds {lost.share_pct.toFixed(1)}% of the award.{' '}
            {lost.cell.ok ? (
              <>
                Without {lost.vendor_key} the goods total is <span className="tabular font-medium">Rs {formatIndian(lost.cell.goods_inr, 0)}</span> for {lost.cell.lines_awarded} of {lost.cell.lines_total} lines
                {lost.goods_delta_inr != null ? (
                  <>
                    , {lost.goods_delta_inr >= 0 ? 'an increase' : 'a decrease'} of <span className="tabular font-medium">Rs {formatIndian(Math.abs(lost.goods_delta_inr), 0)}</span>
                    {lost.goods_delta_pct != null ? ` (${Math.abs(lost.goods_delta_pct).toFixed(2)}%)` : ''}
                  </>
                ) : null}
                . {lost.note}
                {lost.new_top_vendor ? ` The largest vendor would then be ${lost.new_top_vendor}.` : ''}
              </>
            ) : (
              lost.note
            )}
          </p>
          {lost.cell.ok ? <p className="mt-0.5 text-xs text-muted-foreground">Readiness without {lost.vendor_key}: {lost.readiness_label ?? 'n/a'}.</p> : null}
        </div>
      )}
    </Card>
  );
}
