// Review actions for one cell or item (FR-6.5): accept as read, edit value, set unit
// meaning, mark not quoted, dismiss with reason, and undo. Each one is a correction
// on the server and recomputes at once.
import { Check, Pencil, Ruler, Undo2, Ban, X } from 'lucide-react';
import { useId, useState } from 'react';
import { parseUnit } from '../../engine/convert';
import { useApp } from '@/lib/store';
import { Btn } from './ui';

type Kind = 'accept' | 'edit' | 'unit' | 'not_quoted' | 'dismiss' | 'undo';

export type ActionTarget = {
  quote_line_id: string | null;
  review_item_id?: string | null;
  actions: Kind[];
  base_uom: string | null;
  quoted_uom: string | null;
  quoted_price: number | null;
  quoted_currency: string | null;
};

export function ReviewActions({ t, onDone, compact }: { t: ActionTarget; onDone?: () => void; compact?: boolean }) {
  const { act, busy } = useApp();
  const [open, setOpen] = useState<Kind | null>(null);
  const [price, setPrice] = useState(t.quoted_price != null ? String(t.quoted_price) : '');
  const [currency, setCurrency] = useState<'INR' | 'USD'>(t.quoted_currency === 'USD' ? 'USD' : 'INR');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  // A unit meaning only matters when the quoted unit is a pack or cannot be read.
  const unitKind = parseUnit(t.quoted_uom).kind;
  const has = (k: Kind) => t.actions.includes(k) && (k !== 'unit' || unitKind === 'pack' || unitKind === 'unknown');
  const q = t.quote_line_id;
  const unitLabel = (t.quoted_uom ?? 'unit').replace(/^\s*per\s+/i, '');

  const run = async (a: Parameters<typeof act>[0]) => {
    setErr(null);
    const ok = await act(a);
    if (ok) {
      setOpen(null);
      setReason('');
      onDone?.();
    }
  };
  const need = (v: string, min = 3) => (v.trim().length >= min ? null : 'Add a short reason.');
  const itemId = t.review_item_id && !t.review_item_id.startsWith('cell:') ? t.review_item_id : undefined;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Review actions">
        {has('accept') && q ? (
          <Btn small variant="primary" disabled={busy > 0} onClick={() => run({ action: 'accept', quote_line_id: q, review_item_id: itemId })} title="You checked the value against the source and accept it as read">
            <Check size={13} aria-hidden /> Accept as read
          </Btn>
        ) : null}
        {has('edit') && q ? (
          <Btn small aria-expanded={open === 'edit'} onClick={() => setOpen(open === 'edit' ? null : 'edit')}>
            <Pencil size={13} aria-hidden /> Edit value
          </Btn>
        ) : null}
        {has('unit') && q ? (
          <Btn small aria-expanded={open === 'unit'} onClick={() => setOpen(open === 'unit' ? null : 'unit')}>
            <Ruler size={13} aria-hidden /> Set unit meaning
          </Btn>
        ) : null}
        {has('not_quoted') && q ? (
          <Btn small aria-expanded={open === 'not_quoted'} onClick={() => setOpen(open === 'not_quoted' ? null : 'not_quoted')}>
            <Ban size={13} aria-hidden /> Mark not quoted
          </Btn>
        ) : null}
        {has('dismiss') && t.review_item_id && itemId ? (
          <Btn small aria-expanded={open === 'dismiss'} onClick={() => setOpen(open === 'dismiss' ? null : 'dismiss')}>
            <X size={13} aria-hidden /> Dismiss with reason
          </Btn>
        ) : null}
        {has('undo') && q ? (
          <Btn small variant="ghost" disabled={busy > 0} onClick={() => run({ action: 'undo', quote_line_id: q })}>
            <Undo2 size={13} aria-hidden /> Undo my changes
          </Btn>
        ) : null}
      </div>

      {open === 'edit' && q ? (
        <Form compact={compact}>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Price as quoted" id={`${id}-p`}>
              <input id={`${id}-p`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="w-28 rounded border border-border px-2 py-1 text-sm tabular" />
            </Field>
            <Field label="Currency" id={`${id}-c`}>
              <select id={`${id}-c`} value={currency} onChange={(e) => setCurrency(e.target.value as 'INR' | 'USD')} className="rounded border border-border px-2 py-1 text-sm">
                <option value="INR">INR</option>
                <option value="USD">USD</option>
              </select>
            </Field>
            <span className="pb-1.5 text-xs text-muted-foreground">{t.quoted_uom ? `per ${unitLabel}, unit unchanged` : ''}</span>
          </div>
          <ReasonField id={`${id}-r`} value={reason} onChange={setReason} optional hint="Optional. Defaults to: Value corrected against the source." />
          <Submit
            label="Apply edit"
            error={err}
            onClick={() => {
              const n = Number(price.replace(/,/g, ''));
              if (!Number.isFinite(n) || n <= 0) return setErr('Enter a price above zero.');
              void run({ action: 'edit', quote_line_id: q, price: n, currency, reason: reason.trim() || undefined, review_item_id: itemId });
            }}
            onCancel={() => setOpen(null)}
          />
        </Form>
      ) : null}

      {open === 'unit' && q ? (
        <Form compact={compact}>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <span className="pb-1.5">1 {unitLabel} =</span>
            <Field label={`Number of ${t.base_uom ?? 'units'}`} id={`${id}-n`}>
              <input id={`${id}-n`} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className="w-24 rounded border border-border px-2 py-1 text-sm tabular" />
            </Field>
            <span className="pb-1.5">{t.base_uom}</span>
          </div>
          <ReasonField id={`${id}-r`} value={reason} onChange={setReason} optional hint="Optional. For example: the vendor footnote says 1 box = 100 pcs." />
          <Submit
            label="Set unit meaning"
            error={err}
            onClick={() => {
              const n = Number(qty.replace(/,/g, ''));
              if (!Number.isFinite(n) || n <= 0) return setErr('Enter how many units one pack holds.');
              void run({ action: 'unit', quote_line_id: q, quantity: n, reason: reason.trim() || undefined, review_item_id: itemId });
            }}
            onCancel={() => setOpen(null)}
          />
        </Form>
      ) : null}

      {open === 'not_quoted' && q ? (
        <Form compact={compact}>
          <p className="text-xs text-muted-foreground">The cell will show Not quoted and drop out of totals. The original reading is kept and Undo restores it.</p>
          <ReasonField id={`${id}-r`} value={reason} onChange={setReason} />
          <Submit
            label="Mark not quoted"
            error={err}
            onClick={() => {
              const e = need(reason);
              if (e) return setErr(e);
              void run({ action: 'not_quoted', quote_line_id: q, reason: reason.trim(), review_item_id: itemId });
            }}
            onCancel={() => setOpen(null)}
          />
        </Form>
      ) : null}

      {open === 'dismiss' && itemId ? (
        <Form compact={compact}>
          <p className="text-xs text-muted-foreground">Dismissing closes this item and records why. A cell keeps its status; only the queue entry closes.</p>
          <ReasonField id={`${id}-r`} value={reason} onChange={setReason} />
          <Submit
            label="Dismiss"
            error={err}
            onClick={() => {
              const e = need(reason);
              if (e) return setErr(e);
              void run({ action: 'dismiss', review_item_id: itemId, reason: reason.trim() });
            }}
            onCancel={() => setOpen(null)}
          />
        </Form>
      ) : null}
    </div>
  );
}

function Form({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  return <div className={`space-y-2 rounded-md border border-border bg-slate-50 ${compact ? 'p-2' : 'p-3'}`}>{children}</div>;
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={id} className="text-[11px] font-medium text-ink-2">
        {label}
      </label>
      {children}
    </div>
  );
}

function ReasonField({ id, value, onChange, optional, hint }: { id: string; value: string; onChange: (v: string) => void; optional?: boolean; hint?: string }) {
  return (
    <Field label={optional ? 'Reason (optional)' : 'Reason (required)'} id={id}>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={500} aria-describedby={hint ? `${id}-h` : undefined} className="w-full rounded border border-border px-2 py-1 text-sm" />
      {hint ? (
        <span id={`${id}-h`} className="text-[11px] text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </Field>
  );
}

function Submit({ label, onClick, onCancel, error }: { label: string; onClick: () => void; onCancel: () => void; error: string | null }) {
  const { busy } = useApp();
  return (
    <div className="flex items-center gap-2">
      <Btn small variant="primary" disabled={busy > 0} onClick={onClick}>
        {label}
      </Btn>
      <Btn small variant="ghost" onClick={onCancel}>
        Cancel
      </Btn>
      {error ? (
        <span role="alert" className="text-xs text-status-conflict">
          {error}
        </span>
      ) : null}
    </div>
  );
}
