// The live structured RFx beside the co-pilot chat. Every cell is editable by the buyer; the co-pilot's tool
// calls change the same data. Validation is computed here with the same pure function the server uses.
import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { describeRule, type PassRule } from '../../../engine/questionnaire';
import { bySection, type AnswerType, type DraftLine, type DraftQuestion, type DraftRfx, type DraftTerms, type Validation } from '../../../engine/rfx';
import { Btn, Chip } from '@/components/ui';
import { cn } from '@/lib/utils';

const cell = 'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-sm hover:border-border focus:border-accent focus:bg-card disabled:opacity-70 disabled:hover:border-transparent';

type Props = { rfx: DraftRfx; validation: Validation; onChange: (next: DraftRfx) => void; locked: boolean };

const numOrNull = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const flag = (v: Validation, pred: (f: Validation['findings'][number]) => boolean) => v.findings.filter(pred);

export function RfxEditor({ rfx, validation, onChange, locked }: Props) {
  const t = rfx.terms;
  const setTerm = <K extends keyof DraftTerms>(k: K, v: DraftTerms[K]) => onChange({ ...rfx, terms: { ...t, [k]: v } });
  const setLine = (code: string, patch: Partial<DraftLine>) => onChange({ ...rfx, lines: rfx.lines.map((l) => (l.code === code ? { ...l, ...patch } : l)) });
  const setQuestion = (code: string, patch: Partial<DraftQuestion>) => onChange({ ...rfx, questions: rfx.questions.map((q) => (q.code === code ? { ...q, ...patch } : q)) });

  const addLine = (section: string) => {
    const prefix = (section.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'LIN').padEnd(3, 'X');
    let n = rfx.lines.filter((l) => l.code.startsWith(`${prefix}-`)).length + 1;
    while (rfx.lines.some((l) => l.code === `${prefix}-${String(n).padStart(2, '0')}`)) n++;
    onChange({ ...rfx, lines: [...rfx.lines, { code: `${prefix}-${String(n).padStart(2, '0')}`, section, description: '', spec: null, uom: null, pack_size: null, annual_qty: null }] });
  };
  const addSection = () => {
    const name = window.prompt('Section name, for example Cartons');
    if (name?.trim()) addLine(name.trim().slice(0, 80));
  };
  const addQuestion = () => {
    let n = rfx.questions.length + 1;
    while (rfx.questions.some((q) => q.code === `Q${n}`)) n++;
    onChange({ ...rfx, questions: [...rfx.questions, { code: `Q${n}`, text: '', answer_type: 'text', is_knockout: false, pass_rule: null }] });
  };

  return (
    <div className="space-y-5">
      <Findings v={validation} />

      <Section title="Scope and terms">
        <label className="block text-xs text-muted-foreground">
          Title
          <input className={cn(cell, 'mt-0.5 border-border text-sm font-medium')} disabled={locked} value={t.title ?? ''} maxLength={150} onChange={(e) => setTerm('title', e.target.value || null)} placeholder="RFx title" />
        </label>
        <label className="mt-2 block text-xs text-muted-foreground">
          Scope summary
          <textarea className={cn(cell, 'mt-0.5 min-h-[3.5rem] border-border')} disabled={locked} value={t.scope_summary ?? ''} maxLength={1200} onChange={(e) => setTerm('scope_summary', e.target.value || null)} placeholder="What is being bought and why" />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground lg:grid-cols-3">
          <Field label="Payment terms (days)" bad={validation.findings.some((f) => f.field === 'payment_terms_days')}>
            <input type="number" min={0} className={cn(cell, 'border-border')} disabled={locked} value={t.payment_terms_days ?? ''} onChange={(e) => setTerm('payment_terms_days', numOrNull(e.target.value))} />
          </Field>
          <Field label="Quote validity (days)" bad={validation.findings.some((f) => f.field === 'validity_days')}>
            <input type="number" min={0} className={cn(cell, 'border-border')} disabled={locked} value={t.validity_days ?? ''} onChange={(e) => setTerm('validity_days', numOrNull(e.target.value))} />
          </Field>
          <Field label="Delivery location" bad={validation.findings.some((f) => f.field === 'delivery_location')}>
            <input className={cn(cell, 'border-border')} disabled={locked} value={t.delivery_location ?? ''} maxLength={200} onChange={(e) => setTerm('delivery_location', e.target.value || null)} />
          </Field>
          <Field label="GST basis" bad={validation.findings.some((f) => f.field === 'gst_basis')}>
            <select className={cn(cell, 'border-border')} disabled={locked} value={t.gst_basis ?? ''} onChange={(e) => setTerm('gst_basis', (e.target.value || null) as DraftTerms['gst_basis'])}>
              <option value="">Not set</option>
              <option value="excl_gst">Excluding GST</option>
              <option value="incl_gst">Including GST</option>
            </select>
          </Field>
          <Field label="Currency">
            <select className={cn(cell, 'border-border')} disabled={locked} value={t.currency ?? 'INR'} onChange={(e) => setTerm('currency', e.target.value as 'INR' | 'USD')}>
              <option value="INR">INR</option>
              <option value="USD">USD</option>
            </select>
          </Field>
          <span />
          <Field label="Clarifications by (day)">
            <input type="number" min={0} className={cn(cell, 'border-border')} disabled={locked} value={t.clarifications_by_day ?? ''} onChange={(e) => setTerm('clarifications_by_day', numOrNull(e.target.value))} />
          </Field>
          <Field label="Quotes due (day)" bad={validation.findings.some((f) => f.field === 'quotes_due_day')}>
            <input type="number" min={0} className={cn(cell, 'border-border')} disabled={locked} value={t.quotes_due_day ?? ''} onChange={(e) => setTerm('quotes_due_day', numOrNull(e.target.value))} />
          </Field>
          <Field label="Award by (day)">
            <input type="number" min={0} className={cn(cell, 'border-border')} disabled={locked} value={t.award_by_day ?? ''} onChange={(e) => setTerm('award_by_day', numOrNull(e.target.value))} />
          </Field>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Timeline days count from the day the RFx is issued.</p>
      </Section>

      <Section title={`Line items (${rfx.lines.length})`} action={<Btn small disabled={locked} onClick={addSection}><Plus size={12} aria-hidden /> Add section</Btn>}>
        {rfx.lines.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No lines yet. Describe what you buy in the chat, or add a section here.</p> : null}
        {bySection(rfx.lines).map((g) => (
          <div key={g.section} className="mb-3">
            <div className="flex items-center justify-between bg-slate-50 px-2 py-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-2">{g.section}</h3>
              <Btn small variant="ghost" disabled={locked} onClick={() => addLine(g.section)}><Plus size={12} aria-hidden /> Add line</Btn>
            </div>
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                <tr className="text-left text-[11px] text-muted-foreground">
                  <th scope="col" className="w-[11%] px-1 py-1 font-medium">Code</th>
                  <th scope="col" className="px-1 py-1 font-medium">Description</th>
                  <th scope="col" className="w-[17%] px-1 py-1 font-medium">Spec</th>
                  <th scope="col" className="w-[10%] px-1 py-1 font-medium">Base unit</th>
                  <th scope="col" className="w-[8%] px-1 py-1 font-medium">Pack size</th>
                  <th scope="col" className="w-[12%] px-1 py-1 font-medium">Annual qty</th>
                  <th scope="col" className="w-7"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l) => {
                  const fs = flag(validation, (f) => f.line_code === l.code);
                  const bad = (field: string) => fs.some((f) => f.severity === 'error' && (f.field === field || (!f.field && field === 'description')));
                  return (
                    <tr key={l.code} className="border-t border-border align-top">
                      <td className="px-1 py-1 pt-1.5 text-xs font-semibold tabular text-ink-2">{l.code}</td>
                      <td className="px-0 py-0.5"><input aria-label={`${l.code} description`} className={cn(cell, bad('description') && 'border-red-300')} disabled={locked} maxLength={300} value={l.description} onChange={(e) => setLine(l.code, { description: e.target.value })} /></td>
                      <td className="px-0 py-0.5"><input aria-label={`${l.code} spec`} className={cell} disabled={locked} maxLength={300} value={l.spec ?? ''} onChange={(e) => setLine(l.code, { spec: e.target.value || null })} /></td>
                      <td className="px-0 py-0.5"><input aria-label={`${l.code} base unit`} className={cn(cell, bad('uom') && 'border-red-300 bg-red-50')} disabled={locked} maxLength={40} value={l.uom ?? ''} onChange={(e) => setLine(l.code, { uom: e.target.value || null })} placeholder="unit" /></td>
                      <td className="px-0 py-0.5"><input aria-label={`${l.code} pack size`} type="number" min={0} className={cell} disabled={locked} value={l.pack_size ?? ''} onChange={(e) => setLine(l.code, { pack_size: numOrNull(e.target.value) })} /></td>
                      <td className="px-0 py-0.5"><input aria-label={`${l.code} annual quantity`} type="number" min={0} className={cn(cell, 'tabular', bad('annual_qty') && 'border-red-300 bg-red-50')} disabled={locked} value={l.annual_qty ?? ''} onChange={(e) => setLine(l.code, { annual_qty: numOrNull(e.target.value) })} /></td>
                      <td className="px-0 py-0.5 text-center">
                        <button type="button" aria-label={`Remove ${l.code}`} disabled={locked} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-status-conflict disabled:opacity-40" onClick={() => onChange({ ...rfx, lines: rfx.lines.filter((x) => x.code !== l.code) })}>
                          <Trash2 size={13} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </Section>

      <Section title={`Questionnaire (${rfx.questions.length}, ${rfx.questions.filter((q) => q.is_knockout).length} knockouts)`} action={<Btn small disabled={locked} onClick={addQuestion}><Plus size={12} aria-hidden /> Add question</Btn>}>
        {rfx.questions.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No questions yet. Ask the co-pilot for a quality questionnaire, or add one here.</p> : null}
        <ul className="divide-y divide-border">
          {rfx.questions.map((q) => {
            const noRule = !q.pass_rule && q.is_knockout;
            return (
              <li key={q.code} className="grid grid-cols-[2.5rem_1fr] gap-x-2 py-1.5">
                <span className="pt-1.5 text-xs font-semibold tabular text-ink-2">{q.code}</span>
                <div className="min-w-0">
                  <input aria-label={`${q.code} question`} className={cell} disabled={locked} maxLength={300} value={q.text} onChange={(e) => setQuestion(q.code, { text: e.target.value })} />
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <select aria-label={`${q.code} answer type`} className="rounded border border-border bg-card px-1 py-0.5" disabled={locked} value={q.answer_type} onChange={(e) => setQuestion(q.code, { answer_type: e.target.value as AnswerType })}>
                      {['bool', 'number', 'date', 'text', 'choice'].map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                    <label className="inline-flex items-center gap-1">
                      <input type="checkbox" disabled={locked} checked={q.is_knockout} onChange={(e) => setQuestion(q.code, { is_knockout: e.target.checked })} /> Knockout
                    </label>
                    <RuleEditor q={q} locked={locked} bad={noRule} onChange={(r) => setQuestion(q.code, { pass_rule: r })} />
                    <button type="button" aria-label={`Remove ${q.code}`} disabled={locked} className="ml-auto rounded p-1 hover:bg-muted hover:text-status-conflict disabled:opacity-40" onClick={() => onChange({ ...rfx, questions: rfx.questions.filter((x) => x.code !== q.code) })}>
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

type RuleKind = 'none' | 'yes' | 'no' | 'lte' | 'gte' | 'valid';

function kindOf(r: PassRule | null): RuleKind {
  if (!r) return 'none';
  if (r.op === 'eq') return r.value === false ? 'no' : 'yes';
  if (r.op === 'lte') return 'lte';
  if (r.op === 'gte') return 'gte';
  return 'valid';
}

function RuleEditor({ q, locked, bad, onChange }: { q: DraftQuestion; locked: boolean; bad: boolean; onChange: (r: PassRule | null) => void }) {
  const kind = kindOf(q.pass_rule);
  const value = q.pass_rule && (q.pass_rule.op === 'lte' || q.pass_rule.op === 'gte') ? q.pass_rule.value : '';
  const set = (k: RuleKind, v: number | null) => {
    if (k === 'none') onChange(null);
    else if (k === 'yes') onChange({ op: 'eq', value: true });
    else if (k === 'no') onChange({ op: 'eq', value: false });
    else if (k === 'valid') onChange({ op: 'valid_on_date', field: 'expiry', date: 'submission' });
    else onChange({ op: k, value: v ?? 0 });
  };
  return (
    <span className="inline-flex items-center gap-1">
      <select aria-label={`${q.code} pass rule`} className={cn('rounded border bg-card px-1 py-0.5', bad ? 'border-red-300 bg-red-50 text-status-conflict' : 'border-border')} disabled={locked} value={kind} onChange={(e) => set(e.target.value as RuleKind, typeof value === 'number' ? value : null)}>
        <option value="none">No pass rule</option>
        <option value="yes">Must be yes</option>
        <option value="no">Must be no</option>
        <option value="lte">At most</option>
        <option value="gte">At least</option>
        <option value="valid">Certificate valid</option>
      </select>
      {kind === 'lte' || kind === 'gte' ? <input aria-label={`${q.code} rule value`} type="number" className="w-16 rounded border border-border bg-card px-1 py-0.5" disabled={locked} value={value} onChange={(e) => set(kind, numOrNull(e.target.value))} /> : null}
      {bad ? <span className="text-status-conflict">A knockout needs a rule</span> : q.pass_rule ? <span className="sr-only">{describeRule(q.pass_rule)}</span> : null}
    </span>
  );
}

function Findings({ v }: { v: Validation }) {
  if (v.findings.length === 0) {
    return (
      <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-status-confirmed">
        Validation: no errors and no warnings. This RFx can be issued.
      </div>
    );
  }
  return (
    <details open className={cn('rounded-md border px-3 py-2 text-sm', v.errors > 0 ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50')}>
      <summary className="cursor-pointer font-medium">
        <span role="status">
          Validation: {v.errors} {v.errors === 1 ? 'error' : 'errors'}, {v.warnings} {v.warnings === 1 ? 'warning' : 'warnings'}.{' '}
          {v.can_issue ? 'Warnings are allowed: you can issue.' : 'Issue is blocked until the errors are fixed.'}
        </span>
      </summary>
      <ul className="mt-2 space-y-1">
        {v.findings.map((f, i) => (
          <li key={i} className="flex items-start gap-2">
            <Chip tone={f.severity === 'error' ? 'bad' : 'warn'} className="mt-0.5 shrink-0">{f.severity === 'error' ? 'Error' : 'Warning'}</Chip>
            <span>{f.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Field({ label, bad, children }: { label: string; bad?: boolean; children: ReactNode }) {
  return (
    <label className={cn('block', bad && 'text-status-conflict')}>
      {label}
      <div className={cn('mt-0.5 rounded', bad && 'ring-1 ring-red-300')}>{children}</div>
    </label>
  );
}
