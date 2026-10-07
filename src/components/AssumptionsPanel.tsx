// Assumptions panel (FR-6.9, FR-9.4). Editing FX or GST recomputes every affected cell at once.
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import { Btn, Chip, StoredLabel } from './ui';

export function AssumptionsPanel() {
  const { data, setAssumption, busy } = useApp();
  if (!data) return null;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Nothing is assumed silently. Every number a vendor did not state, and every reading of a document that a person could dispute, is listed here.</p>
        <StoredLabel stored={data.stored} />
      </div>

      <section aria-label="Global assumptions" className="rounded-lg border border-border bg-card">
        <h3 className="border-b border-border px-4 py-2 text-sm font-semibold">Global assumptions you can edit</h3>
        <ul className="divide-y divide-border">
          {data.assumptions.map((a) => (
            <GlobalRow key={a.key} a={a} used={data.cells.filter((c) => c.assumption_keys.includes(a.key)).length} disabled={busy > 0} onSet={setAssumption} />
          ))}
        </ul>
      </section>

      <section aria-label="Assumptions derived from documents" className="rounded-lg border border-border bg-card">
        <h3 className="border-b border-border px-4 py-2 text-sm font-semibold">Applied from the documents, by vendor</h3>
        {data.derived_assumptions.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">No document level assumptions apply.</p>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="w-[26%] px-4 py-1.5 font-medium">Assumption</th>
                <th scope="col" className="w-[18%] px-2 py-1.5 font-medium">Vendor</th>
                <th scope="col" className="px-2 py-1.5 font-medium">What was applied</th>
                <th scope="col" className="w-[10%] px-2 py-1.5 text-right font-medium">Cells</th>
                <th scope="col" className="w-[10%] px-4 py-1.5 font-medium">Set by</th>
              </tr>
            </thead>
            <tbody>
              {data.derived_assumptions.map((d, i) => (
                <tr key={i} className="border-t border-border align-top text-xs">
                  <td className="px-4 py-2 font-medium">{d.label}</td>
                  <td className="px-2 py-2">{d.vendor_key} {d.vendor_name}</td>
                  <td className="px-2 py-2 text-muted-foreground">{d.detail}</td>
                  <td className="px-2 py-2 text-right tabular">{d.lines}</td>
                  <td className="px-4 py-2">{d.set_by === 'buyer' ? 'Buyer' : 'System'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function GlobalRow({ a, used, disabled, onSet }: { a: { key: string; label: string; value: number | string; default_value: number | null; set_by: 'system' | 'buyer'; note: string | null; unit: string | null }; used: number; disabled: boolean; onSet: (k: 'usd_inr' | 'gst_pct', v: number | null) => Promise<void> }) {
  const [v, setV] = useState(String(a.value));
  useEffect(() => setV(String(a.value)), [a.value]);
  const k = a.key as 'usd_inr' | 'gst_pct';
  const n = Number(v);
  const valid = Number.isFinite(n) && n > 0 && (k === 'usd_inr' ? n <= 10000 : n <= 100);
  const id = `g-${a.key}`;
  return (
    <li className="flex flex-wrap items-end gap-4 px-4 py-3">
      <div className="min-w-48">
        <label htmlFor={id} className="block text-sm font-medium">
          {a.label}
        </label>
        <div className="text-xs text-muted-foreground">{a.unit}. System default {a.default_value}.</div>
      </div>
      <input id={id} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && n !== Number(a.value) && void onSet(k, n)} className="w-28 rounded border border-border px-2 py-1.5 text-sm tabular" />
      <Btn variant="primary" disabled={disabled || !valid || n === Number(a.value)} onClick={() => void onSet(k, n)}>
        Apply and recompute
      </Btn>
      <Btn disabled={disabled || (a.set_by === 'system' && Number(a.value) === a.default_value)} onClick={() => void onSet(k, null)}>
        <RotateCcw size={13} aria-hidden /> Reset to default
      </Btn>
      <div className="ml-auto text-right text-xs">
        <Chip tone={a.set_by === 'buyer' ? 'accent' : 'neutral'}>Set by {a.set_by === 'buyer' ? 'the buyer' : 'the system'}</Chip>
        <div className="mt-1 text-muted-foreground tabular">Used by {used} {used === 1 ? 'cell' : 'cells'}</div>
      </div>
    </li>
  );
}
