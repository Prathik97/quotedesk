// Scenario controls for the Decision page (strategy, eligible vendors, discounts, price basis).
import { TriangleAlert } from 'lucide-react';
import type { CompareResponse } from '@/lib/api-types';
import { DEFAULT_CONTROLS, STRATEGY_HELP, STRATEGY_LABEL, type Controls } from '@/lib/decision';
import { Btn, Card } from '@/components/ui';
import { cn } from '@/lib/utils';

const STRATEGIES: Controls['strategy'][] = ['cheapest_per_line', 'single_vendor', 'split_cap', 'cheapest_per_section'];

function Group({ legend, children, className }: { legend: string; children: React.ReactNode; className?: string }) {
  return (
    <fieldset className={cn('border-t border-border pt-3', className)}>
      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function ScenarioControls({ value, onChange, data }: { value: Controls; onChange: (c: Controls) => void; data: CompareResponse }) {
  const set = (p: Partial<Controls>) => onChange({ ...value, ...p });
  const eligible = (q: string | null) => q === 'Cleared' || (value.include_pending && q === 'Pending');
  const picked = data.vendors.find((v) => v.key === value.vendor);
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Scenario</h2>
        <Btn small variant="ghost" onClick={() => onChange(DEFAULT_CONTROLS)} disabled={JSON.stringify(value) === JSON.stringify(DEFAULT_CONTROLS)}>
          Reset
        </Btn>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Strategy</legend>
        <div className="space-y-1.5">
          {STRATEGIES.map((s) => (
            <label key={s} className={cn('flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm', value.strategy === s ? 'border-accent bg-teal-50' : 'border-border hover:bg-muted')}>
              <input type="radio" name="strategy" className="mt-1" checked={value.strategy === s} onChange={() => set({ strategy: s, vendor: s === 'single_vendor' ? (value.vendor ?? data.vendors.find((v) => eligible(v.questionnaire))?.key ?? null) : value.vendor })} />
              <span>
                <span className="font-medium">{STRATEGY_LABEL[s]}</span>
                {value.strategy === s ? <span className="mt-0.5 block text-xs text-muted-foreground">{STRATEGY_HELP[s]}</span> : null}
              </span>
            </label>
          ))}
        </div>
        {value.strategy === 'single_vendor' ? (
          <div className="mt-2">
            <label htmlFor="sc-vendor" className="text-xs font-medium">
              Vendor
            </label>
            <select id="sc-vendor" value={value.vendor ?? ''} onChange={(e) => set({ vendor: e.target.value || null })} className="mt-0.5 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm">
              <option value="">Choose a vendor</option>
              {data.vendors.map((v) => (
                <option key={v.key} value={v.key} disabled={!eligible(v.questionnaire)}>
                  {v.key} {v.name}
                  {!eligible(v.questionnaire) ? ` (${v.questionnaire === 'Failed' ? 'failed a knockout' : v.questionnaire === 'Pending' ? 'knockout undecided' : 'not eligible'})` : ''}
                </option>
              ))}
            </select>
            {picked && !eligible(picked.questionnaire) ? <p className="mt-1 text-xs text-status-conflict">{picked.key} is not eligible under these filters.</p> : null}
          </div>
        ) : null}
        {value.strategy === 'split_cap' ? (
          <div className="mt-2">
            <label htmlFor="sc-cap" className="text-xs font-medium">
              Most any one vendor may hold (percent of value)
            </label>
            <input
              id="sc-cap"
              type="number"
              min={10}
              max={100}
              step={5}
              value={value.max_share_pct}
              onChange={(e) => set({ max_share_pct: Math.min(100, Math.max(10, Number(e.target.value) || 60)) })}
              className="tabular mt-0.5 w-24 rounded-md border border-border bg-card px-2 py-1.5 text-sm"
            />
          </div>
        ) : null}
      </fieldset>

      <Group legend="Eligible vendors" className="mt-4">
        <p className="text-sm">Cleared vendors only, by default: those who passed all three knockout questions.</p>
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={value.include_pending} onChange={(e) => set({ include_pending: e.target.checked })} />
          <span>
            Also include Pending vendors
            <span className="block text-xs text-muted-foreground">Their knockout answers are undecided and they may still fail.</span>
          </span>
        </label>
        {value.include_pending ? (
          <p className="mt-1.5 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-status-assumed">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
            Pending vendors are included. An award that relies on one is not defensible until its knockouts are decided. Vendors who failed a knockout are never included here.
          </p>
        ) : null}
      </Group>

      <Group legend="Conditional discounts" className="mt-4">
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={value.apply_discounts} onChange={(e) => set({ apply_discounts: e.target.checked })} />
          <span>
            Include conditional discounts when the threshold is met
            <span className="block text-xs text-muted-foreground">A discount applies only if the vendor's allocation, as one PO at list price, is above its threshold.</span>
          </span>
        </label>
      </Group>

      <Group legend="Price basis" className="mt-4">
        {(
          [
            ['confirmed', 'Confirmed only', 'Prices a person need not check, with no assumption behind them.'],
            ['confirmed_assumed', 'Confirmed and Assumed', 'Also prices that depend on an FX rate, a pack size, a photo or last year.'],
          ] as const
        ).map(([id, label, help]) => (
          <label key={id} className="mb-1 flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name="basis" className="mt-1" checked={value.price_basis === id} onChange={() => set({ price_basis: id })} />
            <span>
              {label}
              <span className="block text-xs text-muted-foreground">{help}</span>
            </span>
          </label>
        ))}
        <p className="mt-1 text-xs text-muted-foreground">Needs review and Conflict prices never decide a line.</p>
      </Group>
    </Card>
  );
}
