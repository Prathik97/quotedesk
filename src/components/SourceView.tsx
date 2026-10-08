// Source view (FR-6.10): each vendor's original reply beside what was extracted from it.
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { DocumentPreview } from '@/lib/api-types';
import { useApp } from '@/lib/store';
import { StatusMark } from '@/lib/status';
import { formatIndian } from '../../engine/format';
import { cn } from '@/lib/utils';
import { ExcelGrid, ImageFull, TextLines } from './sourceViews';
import { Btn, Chip, ErrorBox, Loading, StoredLabel } from './ui';
import { VendorNotes } from './VendorNotes';

type Resp = DocumentPreview & { stored: import('@/lib/api-types').StoredRun };

export function SourceView() {
  const { data, sourceTarget, version, openCell } = useApp();
  const [vendorId, setVendorId] = useState<string | null>(sourceTarget?.vendor_id ?? null);
  const [docId, setDocId] = useState<string | null>(sourceTarget?.document_id ?? null);
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(sourceTarget?.quote_line_id ?? null);
  const [sheet, setSheet] = useState<string | null>(null);

  useEffect(() => {
    if (sourceTarget) {
      setVendorId(sourceTarget.vendor_id);
      setDocId(sourceTarget.document_id ?? null);
      setActive(sourceTarget.quote_line_id ?? null);
    }
  }, [sourceTarget]);

  const vendor = data?.vendors.find((v) => v.id === (vendorId ?? data.vendors[0]?.id));
  const docs = useMemo(() => data?.attachments.filter((a) => a.vendor_id === vendor?.id) ?? [], [data, vendor?.id]);
  // Prefer a document that prices lines, then any file.
  const effectiveDoc = docId && docs.some((d) => d.id === docId) ? docId : (docs.find((d) => d.lines > 0) ?? docs[0])?.id ?? null;

  useEffect(() => {
    if (!effectiveDoc) return;
    let live = true;
    setResp(null);
    api<Resp>(`documents?id=${effectiveDoc}`)
      .then((r) => {
        if (live) {
          setResp(r);
          setErr(null);
        }
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [effectiveDoc, version]);

  const activeLine = resp?.extracted.find((x) => x.quote_line_id === active) ?? null;
  const activeLocator = activeLine?.locator ?? null;
  const xl = activeLocator?.match(/^Sheet '(.+)'!([A-Z]+\d+)$/);
  const xlsx = resp?.preview.kind === 'xlsx' ? resp.preview : null;
  const currentSheet = xlsx ? (xlsx.sheets.find((x) => x.name === (sheet ?? xl?.[1])) ?? xlsx.sheets[0]) : null;

  if (!data) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Vendors" className="flex gap-1">
          {data.vendors.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={v.id === vendor?.id} onClick={() => { setVendorId(v.id); setDocId(null); setActive(null); setSheet(null); }} className={cn('rounded-md border px-2.5 py-1 text-sm', v.id === vendor?.id ? 'border-accent bg-accent text-accent-foreground' : 'border-border bg-card hover:bg-muted')}>
              {v.key} {v.name}
            </button>
          ))}
        </div>
        <StoredLabel stored={data.stored} />
      </div>

      <div role="tablist" aria-label="Documents" className="flex flex-wrap gap-1">
        {docs.map((d) => (
          <button key={d.id} type="button" role="tab" aria-selected={d.id === effectiveDoc} onClick={() => { setDocId(d.id); setActive(null); setSheet(null); }} className={cn('rounded-md border px-2 py-1 text-xs', d.id === effectiveDoc ? 'border-ink-2 bg-slate-100 font-semibold' : 'border-border bg-card hover:bg-muted')}>
            {d.filename} {d.lines > 0 ? <span className="text-muted-foreground tabular">({d.lines} lines)</span> : null}
          </button>
        ))}
      </div>

      {err ? <ErrorBox message={err} /> : !resp ? <Loading what="the document" /> : (
        <div className="grid grid-cols-[minmax(0,11fr)_minmax(0,9fr)] gap-4">
          <section aria-label="Original reply" className="min-w-0 space-y-2">
            <h3 className="text-sm font-semibold">Original reply</h3>
            <p className="text-xs text-muted-foreground">
              {resp.document.filename}. Read as {resp.document.kind ?? 'not classified'}, status {resp.document.status}.
            </p>
            {xlsx ? (
              <>
                <div role="tablist" aria-label="Sheets" className="flex flex-wrap gap-1">
                  {xlsx.sheets.map((s) => (
                    <button key={s.name} type="button" role="tab" aria-selected={s.name === currentSheet?.name} onClick={() => setSheet(s.name)} className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted aria-selected:bg-slate-100 aria-selected:font-semibold">
                      {s.name}{s.hidden ? ' (hidden)' : ''}
                    </button>
                  ))}
                </div>
                {currentSheet ? <ExcelGrid rows={currentSheet.rows} target={xl && xl[1] === currentSheet.name ? xl[2] : null} sheet={currentSheet.name} hidden={currentSheet.hidden} /> : null}
              </>
            ) : null}
            {resp.preview.kind === 'lines' ? <TextLines lines={resp.preview.lines} target={activeLocator} /> : null}
            {resp.preview.kind === 'pdf' && resp.document.signed_url ? (
              <>
                <iframe title={`${resp.document.filename}, original PDF`} src={`${resp.document.signed_url}#page=${activeLine?.page ?? 1}`} className="h-[640px] w-full rounded-md border border-border" />
                <a href={`${resp.document.signed_url}#page=${activeLine?.page ?? 1}`} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent underline">Open the PDF in a new tab</a>
              </>
            ) : null}
            {resp.preview.kind === 'image' && resp.document.signed_url ? (
              <ImageFull url={resp.document.signed_url} height={680} regions={resp.extracted.filter((x) => x.region).map((x) => ({ region: x.region as NonNullable<typeof x.region>, label: x.code ?? '', active: x.quote_line_id === active }))} />
            ) : null}
            {!resp.document.signed_url && resp.preview.kind !== 'lines' && resp.preview.kind !== 'xlsx' ? <p className="text-xs text-muted-foreground">The file link is not available. Reload the page.</p> : null}
          </section>

          <section aria-label="Extracted result" className="min-w-0 space-y-2">
            <h3 className="text-sm font-semibold">Extracted from this file</h3>
            {resp.extracted.length === 0 ? (
              <p className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
                No prices were read from this file. {resp.document.kind === 'certificate' ? 'It is a certificate, read for facts. See the attachments tab.' : ''}
              </p>
            ) : (
              <div className="max-h-[700px] overflow-auto rounded-md border border-border bg-card">
                <table className="w-full table-fixed border-collapse text-xs">
                  <thead className="sticky top-0 bg-slate-100 text-left">
                    <tr>
                      <th scope="col" className="w-[26%] px-2 py-1.5 font-semibold">Line</th>
                      <th scope="col" className="w-[28%] px-2 py-1.5 font-semibold">As quoted</th>
                      <th scope="col" className="w-[20%] px-2 py-1.5 text-right font-semibold">Normalized</th>
                      <th scope="col" className="px-2 py-1.5 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resp.extracted.map((x) => (
                      <tr key={x.quote_line_id} className={cn('cursor-pointer border-t border-border hover:bg-slate-50', x.quote_line_id === active && 'bg-yellow-50')} onClick={() => setActive(x.quote_line_id)} aria-selected={x.quote_line_id === active}>
                        <td className="px-2 py-1.5 align-top">
                          <button type="button" onClick={(e) => { e.stopPropagation(); setActive(x.quote_line_id); }} className="text-left font-semibold tabular hover:underline" aria-label={`Highlight ${x.code ?? 'unmatched line'} in the original`}>{x.code ?? 'Unmatched'}</button>
                          <div className="text-muted-foreground tabular">{x.locator}</div>
                        </td>
                        <td className="px-2 py-1.5 align-top tabular break-words">{x.quoted}</td>
                        <td className="px-2 py-1.5 text-right align-top tabular">{x.price != null ? formatIndian(x.price, 2) : <span className="text-muted-foreground">Not available</span>}</td>
                        <td className="px-2 py-1.5 align-top"><StatusMark status={x.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {vendor && ((vendor.notes?.length ?? 0) > 0 || vendor.validity_warning) ? (
              <div className="rounded-md border border-border bg-card p-3">
                <h3 className="mb-1 text-sm font-semibold">Vendor notes</h3>
                <p className="mb-1 text-xs text-muted-foreground">
                  {vendor.validity_text ? `Validity: ${vendor.validity_text} ` : ''}{vendor.payment_terms_days != null ? `Payment: ${vendor.payment_terms_days} days.` : ''}
                </p>
                <VendorNotes notes={vendor.notes} warning={vendor.validity_warning} className="text-xs" />
              </div>
            ) : null}
            {activeLine ? (
              <Btn small onClick={() => { const c = data.cells.find((z) => z.quote_line_id === activeLine.quote_line_id); if (c) openCell(c.vendor_id, c.rfx_line_id, c.quote_line_id); }}>
                Open full evidence for {activeLine.code}
              </Btn>
            ) : <Chip>Select a line to highlight where it came from</Chip>}
          </section>
        </div>
      )}
    </div>
  );
}
