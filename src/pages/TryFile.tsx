// Try your file: upload ONE vendor reply and watch the real extraction pipeline read it against the saved FY27
// RFx lines. The result is shown here only. It is never added to the comparison.
import { FileUp, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatIndian } from '../../engine/format';
import { Btn, Chip, ErrorBox, Loading, PageTitle } from '@/components/ui';
import { VendorNotes } from '@/components/VendorNotes';
import { api } from '@/lib/api';
import { browserId } from '@/lib/browser';
import { ACCEPT, MAX_MB, SandboxRefusal, uploadFile, type SandboxResponse, type SandboxResult } from '@/lib/sandbox';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';

const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  confirmed: { label: 'Confirmed', tone: 'good' }, assumed: { label: 'Assumed', tone: 'warn' }, needs_review: { label: 'Needs review', tone: 'warn' }, conflict: { label: 'Conflict', tone: 'bad' },
};

export function TryFile() {
  const { usage, refreshUsage } = useApp();
  const [data, setData] = useState<SandboxResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<SandboxResponse>(`sandbox?browser_id=${browserId()}`).then(setData).catch((e: Error) => setErr(e.message));
  }, []);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setRefusal(null);
    if (file.size > MAX_MB * 1048576) {
      setRefusal(`The file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_MB} MB.`);
      return;
    }
    setBusy(file.name);
    try {
      setData(await uploadFile(file));
    } catch (e) {
      const r = e as SandboxRefusal;
      setRefusal(r.message);
      if (r.uploadsLeft != null) setData((d) => (d ? { ...d, uploads_left: r.uploadsLeft as number } : d));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
      void refreshUsage();
    }
  };

  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading what="Try your file" />;
  const capped = !!usage?.capped;
  const disabled = !!busy || capped || data.uploads_left <= 0;
  return (
    <div className="space-y-4">
      <PageTitle title="Try your file" sub="Upload one vendor reply and see how the same pipeline reads it." />
      <p role="note" className="flex items-center gap-2 rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-accent">
        <ShieldCheck size={15} aria-hidden /> {data.label}
      </p>

      <section aria-label="Upload" className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="sr-only" htmlFor="sandbox-file">Vendor reply file</label>
          <input id="sandbox-file" ref={input} type="file" accept={ACCEPT} disabled={disabled} className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-card file:px-3 file:py-1.5 file:text-sm" onChange={(e) => void pick(e.target.files?.[0])} />
          {busy ? <span role="status" className="text-sm text-muted-foreground">Reading {busy}. This can take up to a minute.</span> : null}
        </div>
        <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
          <li>Accepted: xlsx, pdf, docx, png, jpg, eml or txt, up to {MAX_MB} MB.</li>
          <li>
            {capped ? 'The live demo has reached its spend cap for today, so uploads are paused.' : `${data.uploads_left} of ${data.uploads_per_hour} uploads left this hour from your address.`} Each read is a live model call and counts toward the daily spend cap shown in the footer.
          </li>
          <li>The file is read in memory and is not kept. The result is shown to you only, expires after two hours and is cleared by Reset demo.</li>
          <li>It is read against the saved FY27 RFx lines. It is never merged into the comparison, the analyst or the decision pack.</li>
        </ul>
        {refusal ? <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-status-conflict">{refusal}</p> : null}
      </section>

      {data.result ? <Result r={data.result} /> : !busy ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          <FileUp className="mx-auto mb-2" size={20} aria-hidden /> No file read yet. Choose a vendor reply above, such as a spreadsheet, a PDF quote or a photo of a rate card.
          <div className="mt-2"><Btn small disabled={disabled} onClick={() => input.current?.click()}>Choose a file</Btn></div>
        </div>
      ) : null}
    </div>
  );
}

function Result({ r }: { r: SandboxResult }) {
  return (
    <div className="space-y-4">
      <section aria-label="Result summary" className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold break-all">{r.filename}</h2>
            <p className="text-xs text-muted-foreground">
              Read as {r.kind}{r.kind_confidence ? ` (${Math.round(r.kind_confidence * 100)} percent sure)` : ''}, format {r.source_type}. {r.vendor_name_as_written ? `Vendor as written: ${r.vendor_name_as_written}.` : ''}
            </p>
          </div>
          <Chip tone="accent">Not added to the comparison</Chip>
        </div>
        {r.note ? <p className="mt-2 rounded-md bg-muted px-3 py-2 text-sm">{r.note}</p> : null}
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
          <Item k="Lines read" v={`${r.lines.length}`} />
          <Item k="RFx lines covered" v={`${r.rfx_lines_covered} of ${r.rfx_lines_total}`} />
          {Object.entries(r.status_counts).map(([k, n]) => <Item key={k} k={STATUS[k]?.label ?? k} v={`${n}`} />)}
          {r.terms ? <Item k="Freight" v={`${r.terms.freight_terms}${r.terms.freight_note ? `, ${r.terms.freight_note}` : ''}`} /> : null}
          {r.terms ? <Item k="Tax basis" v={r.terms.tax_basis === 'excl_gst' ? 'Excluding GST' : r.terms.tax_basis === 'incl_gst' ? 'Including GST' : 'Not stated'} /> : null}
          {r.terms?.payment_terms ? <Item k="Payment terms" v={r.terms.payment_terms} /> : null}
          {r.terms?.validity ? <Item k="Validity" v={r.terms.validity} /> : null}
          {r.terms?.stated_total_inr != null ? <Item k="Stated total" v={`Rs ${formatIndian(r.terms.stated_total_inr, 2)}`} /> : null}
          <Item k="This read cost" v={`Rs ${r.usage.cost_inr.toFixed(2)} (${r.usage.model_calls} model ${r.usage.model_calls === 1 ? 'call' : 'calls'}${r.usage.repaired ? ', one repair' : ''})`} />
        </dl>
      </section>

      {(r.vendor_notes?.length ?? 0) + (r.vendor_statements?.length ?? 0) > 0 ? (
        <section aria-label="Vendor notes" className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">Vendor notes</h2>
          <VendorNotes notes={r.vendor_notes} statements={r.vendor_statements} />
        </section>
      ) : null}

      {r.lines.length > 0 ? (
        <section aria-label="Lines read" className="rounded-lg border border-border bg-card">
          <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">Lines, units, statuses and evidence</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-1.5 font-medium">RFx line</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">As the vendor wrote it</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">INR per base unit</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Status</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l, i) => (
                  <tr key={i} className="border-t border-border align-top">
                    <td className="px-4 py-2 text-xs">
                      <div className="font-semibold tabular text-ink-2">{l.code ?? 'Unmatched'}</div>
                      <div className="text-muted-foreground">{l.rfx_description ?? 'No RFx line matched'}</div>
                    </td>
                    <td className="px-2 py-2 text-xs">
                      <div>{l.vendor_description || 'No description'}</div>
                      <div className="text-muted-foreground">{l.quoted}</div>
                      {l.conditions.length ? <div className="text-status-assumed">Conditions: {l.conditions.join('; ')}</div> : null}
                    </td>
                    <td className="px-2 py-2 text-right text-xs tabular">
                      {l.normalized_inr != null ? <div className="font-medium">{formatIndian(l.normalized_inr, 2)} per {l.base_unit}</div> : <div className="text-muted-foreground">Not derived</div>}
                      {l.ly_rate != null ? <div className="text-muted-foreground">Last year {formatIndian(l.ly_rate, 2)}</div> : null}
                    </td>
                    <td className="px-2 py-2 text-xs">
                      <Chip tone={STATUS[l.status]?.tone ?? 'neutral'}>{STATUS[l.status]?.label ?? l.status}</Chip>
                      {l.reasons.slice(0, 3).map((x, k) => <div key={k} className="mt-1 text-muted-foreground">{x}</div>)}
                      {(l.notes ?? []).map((x, k) => <div key={`n${k}`} className="mt-1 text-muted-foreground">{x}</div>)}
                      {l.flags.length ? <div className="mt-1 flex flex-wrap gap-1">{l.flags.map((f) => <Chip key={f} tone="warn">{f.replace(/_/g, ' ')}</Chip>)}</div> : null}
                    </td>
                    <td className="px-2 py-2 text-xs">
                      <div className="text-muted-foreground">{l.evidence.locator}{l.evidence.page ? `, page ${l.evidence.page}` : ''}. Read confidence {l.read_confidence}.</div>
                      {l.evidence.quote ? <blockquote className="mt-0.5 border-l-2 border-border pl-2">{l.evidence.quote}</blockquote> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {r.not_quoted.length > 0 && r.lines.length > 0 ? (
        <section aria-label="Not quoted" className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
          <h2 className="text-sm font-semibold">Not quoted ({r.not_quoted.length})</h2>
          <p className="mt-1 text-xs text-muted-foreground">No price for these RFx lines in this file. They stay missing, never zero: {r.not_quoted.join(', ')}.</p>
          {Object.keys(r.indicative ?? {}).length > 0 ? (
            <div className="mt-2">
              <p className="text-xs font-medium">What the vendor said about some of them (indicative, not a price, never used)</p>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {Object.entries(r.indicative ?? {}).map(([code, texts]) => (
                  <li key={code}><span className="font-semibold tabular text-ink-2">{code}</span> {texts.join(' ')}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {r.review.length > 0 ? (
        <section aria-label="Review items" className="rounded-lg border border-border bg-card">
          <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">Review items and flags ({r.review.length})</h2>
          <ul className="divide-y divide-border">
            {r.review.map((x, i) => (
              <li key={i} className="flex items-start gap-2 px-4 py-2 text-sm">
                <Chip tone={x.severity === 'block' ? 'bad' : x.severity === 'warn' ? 'warn' : 'neutral'} className="mt-0.5 shrink-0">{x.severity === 'info' ? 'Note' : x.severity === 'warn' ? 'Warning' : 'Blocker'}</Chip>
                <span className="break-words">{x.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {r.answers.length > 0 ? (
        <section aria-label="Questionnaire answers" className="rounded-lg border border-border bg-card">
          <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">Questionnaire answers read ({r.answers.length})</h2>
          <ul className="divide-y divide-border">
            {r.answers.map((a) => (
              <li key={a.code} className="grid grid-cols-[2.5rem_1fr_auto] gap-2 px-4 py-2 text-sm">
                <span className="font-semibold tabular text-ink-2">{a.code}</span>
                <span><span className="text-muted-foreground">{a.question}</span><br />{a.answer || 'No answer'}{a.basis === 'inferred' ? ' (inferred)' : ''}</span>
                <span className="flex flex-col items-end gap-1">{a.knockout ? <Chip tone="warn">Knockout</Chip> : null}<Chip>{a.status}</Chip></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {r.certificate ? (
        <section aria-label="Certificate facts" className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Facts read from the certificate</h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
            <Item k="Type" v={r.certificate.doc_type.replace(/_/g, ' ')} />
            <Item k="Legal name" v={r.certificate.legal_name ?? 'Not found'} />
            <Item k="Trade name" v={r.certificate.trade_name ?? 'Not found'} />
            <Item k="Number" v={r.certificate.certificate_number ?? 'Not found'} />
            <Item k="Issued" v={r.certificate.issue_date ?? 'Not found'} />
            <Item k="Expires" v={r.certificate.expiry_date ?? 'Not found'} />
          </dl>
        </section>
      ) : null}
      <p className={cn('text-xs text-muted-foreground')}>Assumptions used: USD 1 = INR {r.assumptions_used.usd_inr}, GST {r.assumptions_used.gst_pct} percent. These are the comparison's current assumptions, read only here.</p>
    </div>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="font-medium break-words">{v}</dd>
    </div>
  );
}
