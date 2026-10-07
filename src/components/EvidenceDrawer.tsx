// The evidence drawer (FR-6.4): one click from any number to its source, the raw
// value, every conversion with its factors, the assumptions (editable), flags and a
// plain language reason for the status.
import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatIndian, formatPct, formatRupee } from '../../engine/format';
import { api } from '@/lib/api';
import type { EvidenceResponse } from '@/lib/api-types';
import { useApp } from '@/lib/store';
import { StatusMark } from '@/lib/status';
import { cn } from '@/lib/utils';
import { ReviewActions } from './ReviewActions';
import { SourceBlock } from './sourceViews';
import { Btn, StoredLabel } from './ui';

const trim = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 4 });

export function EvidenceDrawer() {
  const { selection, closeDrawer, data } = useApp();
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!selection) return;
    opener.current = document.activeElement;
    closeRef.current?.focus();
    const o = opener.current;
    window.setTimeout(() => o instanceof HTMLElement && o.scrollIntoView({ block: 'nearest', inline: 'center' }), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [selection === null, closeDrawer]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!selection || !data) return null;
  return (
    <aside ref={ref} role="dialog" aria-label="Evidence" aria-modal="false" className="fixed bottom-8 right-0 top-[88px] z-30 flex w-[500px] max-w-full flex-col border-l border-border bg-card shadow-2xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">Evidence</h2>
        <button ref={closeRef} type="button" onClick={closeDrawer} aria-label="Close evidence drawer" className="rounded p-1 hover:bg-muted">
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{selection.kind === 'cell' ? <CellEvidence key={`${selection.vendor_id}:${selection.rfx_line_id}`} sel={selection} /> : <AnswerEvidence sel={selection} />}</div>
    </aside>
  );
}

function CellEvidence({ sel }: { sel: { vendor_id: string; rfx_line_id: string; quote_line_id: string | null } }) {
  const { version, openSource, data, setAssumption, busy, setTab, closeDrawer } = useApp();
  const [ev, setEv] = useState<EvidenceResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const qs = sel.quote_line_id ? `quote_line_id=${sel.quote_line_id}` : `vendor_id=${sel.vendor_id}&rfx_line_id=${sel.rfx_line_id}`;
    api<EvidenceResponse>(`evidence?${qs}`)
      .then((r) => {
        if (live) {
          setEv(r);
          setErr(null);
        }
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [sel.quote_line_id, sel.vendor_id, sel.rfx_line_id, version]);

  if (err) return <p role="alert" className="text-sm text-status-conflict">{err}</p>;
  if (!ev) return <p role="status" className="text-sm text-muted-foreground">Loading evidence</p>;

  const lineStatusFromGrid = data?.cells.find((c) => c.vendor_id === sel.vendor_id && c.rfx_line_id === sel.rfx_line_id);
  const status = lineStatusFromGrid?.status ?? ev.status;
  const hasOverrides = Object.keys(ev.overrides).length > 0;
  const qId = ev.quote_line_id;
  const usedCount = (key: string) => data?.cells.filter((c) => c.assumption_keys.includes(key)).length ?? 0;

  return (
    <div className="space-y-5 text-sm">
      <header>
        <div className="text-xs text-muted-foreground">
          {ev.vendor.name} ({ev.vendor.key})
        </div>
        <h3 className="mt-0.5 font-semibold leading-snug">
          <span className="tabular">{ev.line.code}</span> {ev.line.description}
        </h3>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {ev.price != null ? (
            <span className="text-xl font-semibold tabular">
              {formatRupee(ev.price)} <span className="text-sm font-normal text-muted-foreground">per {ev.base_uom}, excl. GST</span>
            </span>
          ) : (
            <span className="text-xl font-semibold">Not quoted</span>
          )}
          <StatusMark status={status} size={16} className="text-sm" />
          {ev.buyer_verified ? <span className="text-xs text-ink-2">Checked by a person</span> : null}
        </div>
        {ev.price != null ? (
          <p className="mt-1 text-xs text-muted-foreground tabular">
            {ev.delta_pct != null ? `${formatPct(ev.delta_pct)} against last year's ${formatRupee(ev.line.ly_rate ?? 0)}. ` : ''}Annual value {formatRupee(ev.annual_value ?? 0, 0)} at {formatIndian(ev.line.annual_qty, 0)} {ev.base_uom}.
          </p>
        ) : null}
      </header>

      <Section title="Why this status">
        <ul className="list-disc space-y-1 pl-4">
          {ev.explanation.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
        {ev.flags.length > 0 ? (
          <div className="mt-2 space-y-1">
            <h4 className="text-xs font-semibold text-ink-2">Flags</h4>
            <ul className="space-y-1">
              {ev.flags.map((f) => (
                <li key={f.flag} className="rounded border border-border bg-slate-50 px-2 py-1 text-xs">
                  <span className="font-mono text-[11px] text-ink-2">{f.flag}</span>: {f.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {ev.match_confidence != null ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Matched to this RFx line as "{ev.vendor_description}" with confidence {ev.match_confidence.toFixed(2)}. {ev.match_reason ?? ''}
          </p>
        ) : null}
      </Section>

      {ev.source ? (
        <Section title="Source">
          <SourceBlock source={ev.source} context={ev.context} footnote={ev.unit_definition ? { region: ev.unit_definition.region, quote: ev.unit_definition.quote, document_id: ev.unit_definition.document_id } : null} />
          <Btn small className="mt-2" onClick={() => openSource({ vendor_id: ev.vendor.id, document_id: ev.source?.document_id, quote_line_id: qId })}>
            <ExternalLink size={13} aria-hidden /> Open in source view
          </Btn>
        </Section>
      ) : null}

      {ev.price != null || ev.conversion_error ? (
        <Section title="Raw value and conversions">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">As quoted</dt>
            <dd className="tabular">
              {ev.quoted.inherits_last_year && ev.quoted.price == null ? (
                <>Same as last year (no number given)</>
              ) : (
                <>
                  {ev.quoted.currency && ev.quoted.currency !== 'INR' ? `${ev.quoted.currency} ` : '₹'}
                  {ev.quoted.price != null ? formatIndian(ev.quoted.price, 2) : 'no number'} {ev.quoted.uom_text ?? ''}
                </>
              )}
            </dd>
            {ev.quoted.tax_basis ? (
              <>
                <dt className="text-muted-foreground">GST basis</dt>
                <dd>{ev.quoted.tax_basis === 'excl_gst' ? 'Excluding GST' : ev.quoted.tax_basis === 'incl_gst' ? 'Including GST' : 'Not stated'}</dd>
              </>
            ) : null}
          </dl>
          {ev.conversion_error ? <p className="mt-2 rounded border border-orange-200 bg-orange-50 px-2 py-1 text-xs">{ev.conversion_error.detail}</p> : null}
          {ev.trace ? (
            ev.trace.rows.length > 0 ? (
              <ol className="mt-2 space-y-1.5" aria-label="Conversion steps">
                {ev.trace.rows.map((r, i) => (
                  <li key={i} className="rounded border border-border px-2 py-1.5 text-xs">
                    <div className="tabular">
                      <span className="font-semibold">{trim(r.before)}</span> {r.op === 'multiply' ? 'multiplied by' : 'divided by'} <span className="font-semibold">{trim(r.factor)}</span> = <span className="font-semibold">{trim(r.after)}</span>
                    </div>
                    <div className="text-muted-foreground">{r.reason}</div>
                  </li>
                ))}
                <li className="px-2 text-xs tabular">
                  Result: <span className="font-semibold">{ev.trace.end != null ? formatRupee(ev.trace.end, 4).replace(/\.?0+$/, '') : ''}</span> per {ev.base_uom}, excluding GST
                  {!ev.trace.consistent ? <span className="ml-2 text-status-conflict">The steps do not add up to the stored value. Recompute.</span> : null}
                </li>
              </ol>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{ev.quoted.inherits_last_year && ev.quoted.price == null ? "Taken straight from last year's contract rate. " : 'No conversion needed, the quoted unit already matches. '}</p>
            )
          ) : null}
          {ev.conversion_notes.map((n, i) => (
            <p key={i} className="mt-1 text-xs text-muted-foreground">
              {n}
            </p>
          ))}
          {ev.conditions.length > 0 ? (
            <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs">
              Conditions on this price, not applied to the number above: {ev.conditions.join('; ')}
            </p>
          ) : null}
        </Section>
      ) : null}

      {ev.assumptions_used.length > 0 ? (
        <Section title="Assumptions used">
          <ul className="space-y-2">
            {ev.assumptions_used.map((a) => (
              <li key={a.key} className="rounded border border-border px-2 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] text-ink-2">{a.key}</span>
                  {a.accepted ? <span className="text-[11px] text-ink-2">Accepted by the buyer</span> : null}
                </div>
                <p className="mt-0.5 text-xs">{a.text}</p>
                {a.editable && a.value != null ? <InlineAssumption k={a.key as 'usd_inr' | 'gst_pct'} value={a.value} unit={a.unit ?? ''} used={usedCount(a.key)} disabled={busy > 0} onSet={setAssumption} /> : null}
              </li>
            ))}
          </ul>
          <button type="button" className="mt-2 text-xs font-medium text-accent underline" onClick={() => { closeDrawer(); setTab('assumptions'); }}>
            Open all assumptions
          </button>
        </Section>
      ) : null}

      {qId || ev.review_items.length > 0 ? (
        <Section title="Review actions">
          {qId ? (
            <ReviewActions
              t={{
                quote_line_id: qId,
                review_item_id: ev.review_items.find((i) => i.state === 'open')?.id ?? null,
                actions: status === 'missing' ? (hasOverrides ? ['undo'] : []) : ['accept', 'edit', 'unit', 'not_quoted', ...(ev.review_items.some((i) => i.state === 'open') ? (['dismiss'] as const) : []), ...(hasOverrides ? (['undo'] as const) : [])],
                base_uom: ev.base_uom,
                quoted_uom: ev.quoted.uom_text,
                quoted_price: ev.quoted.price,
                quoted_currency: ev.quoted.currency,
              }}
              compact
            />
          ) : (
            <p className="text-xs text-muted-foreground">Nothing to act on for a line the vendor did not quote.</p>
          )}
          {ev.review_items.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {ev.review_items.map((i) => (
                <li key={i.id}>
                  <span className="font-medium">{i.state}</span>: {i.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {ev.corrections.length > 0 ? (
        <Section title="Corrections on this cell">
          <ul className="space-y-1">
            {ev.corrections.map((c) => (
              <li key={c.id} className="rounded border border-border bg-slate-50 px-2 py-1 text-xs">
                <span className="font-medium">{c.action ?? c.field}</span> {c.field}: {JSON.stringify(c.old_value)} to {JSON.stringify(c.new_value)}
                <div className="text-muted-foreground">
                  {c.reason} ({new Date(c.created_at).toLocaleString('en-IN')})
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <footer className="border-t border-border pt-2">
        <StoredLabel stored={ev.stored} />
        <p className="mt-0.5 text-[11px] text-muted-foreground">Nothing on this panel was produced by a model just now. It reads the stored extraction and the engine.</p>
      </footer>
    </div>
  );
}

function InlineAssumption({ k, value, unit, used, disabled, onSet }: { k: 'usd_inr' | 'gst_pct'; value: number; unit: string; used: number; disabled: boolean; onSet: (k: 'usd_inr' | 'gst_pct', v: number | null) => Promise<void> }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const id = `ia-${k}`;
  const n = Number(v);
  const valid = Number.isFinite(n) && n > 0 && (k === 'usd_inr' ? n <= 10000 : n <= 100);
  return (
    <div className="mt-1.5 flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-[11px] font-medium text-ink-2">
          {k === 'usd_inr' ? 'USD 1 equals INR' : 'GST percent'}
        </label>
        <input id={id} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} className="w-24 rounded border border-border px-2 py-1 text-sm tabular" />
      </div>
      <Btn small variant="primary" disabled={disabled || !valid || n === value} onClick={() => void onSet(k, n)}>
        Apply and recompute
      </Btn>
      <span className="pb-1 text-[11px] text-muted-foreground">
        {unit}. Changes {used} {used === 1 ? 'cell' : 'cells'} everywhere.
      </span>
    </div>
  );
}

function AnswerEvidence({ sel }: { sel: { vendor_id: string; question_id: string } }) {
  const { data, openSource } = useApp();
  if (!data) return null;
  const q = data.questions.find((x) => x.id === sel.question_id);
  const v = data.vendors.find((x) => x.id === sel.vendor_id);
  const a = q?.answers[sel.vendor_id];
  if (!q || !v) return null;
  return (
    <div className="space-y-4 text-sm">
      <header>
        <div className="text-xs text-muted-foreground">
          {v.name} ({v.key}), questionnaire
        </div>
        <h3 className="mt-0.5 font-semibold">
          {q.code}. {q.text}
        </h3>
        {q.is_knockout ? <p className="mt-1 text-xs text-muted-foreground">Knockout question. Rule: {q.rule_text}</p> : null}
      </header>
      {!a ? (
        <p>No answer was found in any document.</p>
      ) : (
        <>
          <Section title="Answer as written">
            <p className="rounded border border-border bg-slate-50 px-2 py-1.5">{a.raw ?? 'No text'}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Status: {a.status}. {a.basis === 'inferred' ? 'The reader inferred this from an indirect statement, so it never decides a knockout on its own.' : 'Stated by the vendor.'}
            </p>
          </Section>
          {a.outcome ? (
            <Section title="Against the rule">
              <p className={cn('font-medium', a.outcome.outcome === 'pass' && 'text-status-confirmed', a.outcome.outcome === 'fail' && 'text-status-conflict', a.outcome.outcome === 'pending' && 'text-status-assumed')}>
                {a.outcome.outcome === 'pass' ? 'Passes' : a.outcome.outcome === 'fail' ? 'Fails' : 'Cannot be decided yet'}
              </p>
              <p className="text-xs">{a.outcome.reason}</p>
              {a.outcome.tentative ? <p className="mt-1 text-xs text-muted-foreground">Tentative reading: {a.outcome.tentative}. Confirm with the vendor before deciding.</p> : null}
            </Section>
          ) : null}
          {a.evidence ? (
            <Section title="Source">
              <p className="text-xs text-muted-foreground">{a.evidence.locator}</p>
              {a.evidence.quote ? <blockquote className="mt-1 rounded-md border-l-4 border-yellow-500 bg-yellow-50 px-2 py-1 text-xs">{a.evidence.quote}</blockquote> : null}
              <Btn small className="mt-2" onClick={() => openSource({ vendor_id: v.id, document_id: a.document_id })}>
                <ExternalLink size={13} aria-hidden /> Open in source view
              </Btn>
            </Section>
          ) : null}
        </>
      )}
      <footer className="border-t border-border pt-2">
        <StoredLabel stored={data.stored} />
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">{title}</h4>
      {children}
    </section>
  );
}
