// Renderers for a source: Excel cells with addresses, addressed text lines, a PDF
// frame, and an image with the read region highlighted.
import { useLayoutEffect, useRef, useState } from 'react';
import type { SourceContext, SourceRef } from '@/lib/api-types';
import { cn } from '@/lib/utils';

export type Region = { x: number; y: number; w: number; h: number };

export function colIndex(addr: string): number {
  const letters = addr.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function colName(i: number): string {
  let s = '';
  let n = i;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type GridRows = { row: number; cells: { addr: string; text: string; target?: boolean }[] }[];

/** An Excel sheet fragment. Rows that are not neighbours get a gap marker. */
export function ExcelGrid({ rows, target, sheet, hidden }: { rows: GridRows; target?: string | null; sheet: string; hidden?: boolean }) {
  const maxCol = Math.max(1, ...rows.flatMap((r) => r.cells.map((c) => colIndex(c.addr))));
  const cols = Array.from({ length: Math.min(maxCol, 12) }, (_, i) => i + 1);
  let prev = 0;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <div className="border-b border-border bg-slate-50 px-2 py-1 text-[11px] text-muted-foreground">
        Sheet "{sheet}"{hidden ? ', hidden sheet' : ''}
      </div>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-slate-100 text-muted-foreground">
            <th className="w-8 border-b border-r border-border px-1 py-0.5 font-normal" />
            {cols.map((c) => (
              <th key={c} className="border-b border-r border-border px-1 py-0.5 font-normal">
                {colName(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const gap = prev !== 0 && r.row - prev > 1;
            prev = r.row;
            return (
              <FragmentRow key={r.row} gap={gap} colSpan={cols.length + 1}>
                <tr>
                  <th className="border-b border-r border-border bg-slate-100 px-1 py-0.5 text-right font-normal text-muted-foreground tabular">{r.row}</th>
                  {cols.map((c) => {
                    const cell = r.cells.find((x) => colIndex(x.addr) === c);
                    const isTarget = cell && (cell.target || cell.addr === target);
                    return (
                      <td key={c} className={cn('max-w-[120px] truncate border-b border-r border-border px-1 py-0.5 align-top', isTarget && 'bg-yellow-200 font-semibold outline outline-2 -outline-offset-2 outline-yellow-600')} title={cell ? `${cell.addr}: ${cell.text}` : undefined}>
                        {cell?.text ?? ''}
                      </td>
                    );
                  })}
                </tr>
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({ gap, colSpan, children }: { gap: boolean; colSpan: number; children: React.ReactNode }) {
  return (
    <>
      {gap ? (
        <tr>
          <td colSpan={colSpan} className="border-b border-border bg-slate-50 px-2 py-0.5 text-center text-[10px] text-muted-foreground">
            rows skipped
          </td>
        </tr>
      ) : null}
      {children}
    </>
  );
}

export function TextLines({ lines, target }: { lines: { label: string; text: string; target?: boolean }[]; target?: string | null }) {
  return (
    <ol className="max-h-72 overflow-auto rounded-md border border-border text-xs">
      {lines.map((l, i) => {
        const hit = l.target || (target && l.label && l.label.toLowerCase() === target.toLowerCase());
        return (
          <li key={i} className={cn('flex gap-2 border-b border-border px-2 py-1 last:border-b-0', hit && 'bg-yellow-100 font-medium')} aria-current={hit ? 'location' : undefined}>
            <span className="w-24 shrink-0 text-muted-foreground tabular">{l.label}</span>
            <span className="break-words">{l.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The part of an image the reader said it read, with some surrounding context and
 * the region outlined. The region is the model's estimate on a tilted photo, so the
 * outline is a guide and the full image is always one click away.
 */
export function ImageCrop({ url, region, label, pad = 0.05, width = 420 }: { url: string; region: Region; label: string; pad?: number; width?: number }) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const probe = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const el = probe.current;
    if (el?.complete && el.naturalWidth > 0) setNat({ w: el.naturalWidth, h: el.naturalHeight });
  }, [url]);
  const x0 = Math.max(0, region.x - pad);
  const y0 = Math.max(0, region.y - pad * 0.8);
  const x1 = Math.min(1, region.x + region.w + pad);
  const y1 = Math.min(1, region.y + region.h + pad * 0.8);
  const ew = x1 - x0;
  const eh = y1 - y0;
  return (
    <figure className="m-0">
      <img ref={probe} src={url} alt="" className="hidden" onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
      {failed ? (
        <p className="rounded-md border border-border bg-slate-50 p-3 text-xs text-muted-foreground">The image could not be loaded. The link may have expired, reload the page.</p>
      ) : !nat ? (
        <div className="grid h-20 place-items-center rounded-md border border-border bg-slate-50 text-xs text-muted-foreground">Loading image</div>
      ) : (
        (() => {
          const scale = width / (ew * nat.w);
          const h = Math.max(48, Math.min(260, eh * nat.h * scale));
          const k = h / (eh * nat.h);
          const w = ew * nat.w * k;
          return (
            <div className="relative overflow-hidden rounded-md border border-border bg-slate-100" style={{ width: Math.min(width, w), height: h }} role="img" aria-label={label}>
              <img src={url} alt="" style={{ position: 'absolute', width: nat.w * k, height: nat.h * k, left: -x0 * nat.w * k, top: -y0 * nat.h * k, maxWidth: 'none' }} />
              <div
                className="absolute rounded-sm outline outline-2 outline-offset-1 outline-red-600"
                style={{ left: (region.x - x0) * nat.w * k, top: (region.y - y0) * nat.h * k, width: region.w * nat.w * k, height: region.h * nat.h * k, boxShadow: '0 0 0 9999px rgba(15,23,42,0.18)' }}
              />
            </div>
          );
        })()
      )}
      <figcaption className="mt-1 text-[11px] text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

/** The whole photo, small, with the regions outlined. */
export function ImageFull({ url, regions, height = 360 }: { url: string; regions: { region: Region; label?: string; active?: boolean }[]; height?: number }) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className="relative inline-block max-w-full overflow-auto rounded-md border border-border bg-slate-100" style={{ maxHeight: height }}>
      <div className="relative inline-block">
        <img src={url} alt="Photo of the vendor rate card as received" className="block max-w-none" style={{ height: nat ? undefined : 200 }} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {regions.map((r, i) => (
          <div
            key={i}
            className={cn('absolute rounded-sm outline outline-2', r.active ? 'bg-red-500/10 outline-red-600' : 'outline-sky-500')}
            style={{ left: `${r.region.x * 100}%`, top: `${r.region.y * 100}%`, width: `${r.region.w * 100}%`, height: `${r.region.h * 100}%` }}
            title={r.label}
          />
        ))}
      </div>
    </div>
  );
}

/** Evidence source block used in the drawer. */
export function SourceBlock({ source, context, footnote }: { source: SourceRef; context: SourceContext; footnote?: { region: Region | null; quote: string | null; document_id: string | null } | null }) {
  const url = source.signed_url;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{source.filename}</span>, {source.locator || 'location not given'}
        {source.page ? `, page ${source.page}` : ''}
      </p>
      {context.kind === 'grid' ? <ExcelGrid rows={context.rows} target={context.target} sheet={context.sheet} hidden={context.hidden} /> : null}
      {context.kind === 'lines' ? <TextLines lines={context.lines} /> : null}
      {context.kind === 'none' ? <p className="rounded-md border border-border bg-slate-50 p-2 text-xs text-muted-foreground">{context.note}</p> : null}
      {context.kind === 'pdf' && url ? (
        <a href={`${url}#page=${context.page ?? 1}`} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent underline">
          Open the PDF at page {context.page ?? 1} in a new tab
        </a>
      ) : null}
      {context.kind === 'image' && url && source.region ? (
        <div className="space-y-2">
          <ImageCrop url={url} region={source.region} label="Approximate crop around where the reader says it found this value, outlined in red. On a tilted photo the outline can be a row or so off, so read the row number and unit on the card, or open the whole photo." pad={0.08} />
          {footnote?.region ? <ImageCrop url={url} region={footnote.region} label={`Approximate crop for the footnote that defines the unit${footnote.quote ? `, read as: ${footnote.quote}` : ''}. The footnote sits in small print at the bottom of the card, below the table.`} pad={0.1} /> : null}
          <a href={url} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent underline">
            Open the whole photo in a new tab
          </a>
        </div>
      ) : null}
      {context.kind === 'image' && !source.region ? <p className="text-xs text-muted-foreground">The reader did not give a region for this value. Open the photo to find it.</p> : null}
      {source.quote ? (
        <blockquote className="rounded-md border-l-4 border-yellow-500 bg-yellow-50 px-2 py-1 text-xs">
          <span className="text-muted-foreground">As read: </span>
          {source.quote}
        </blockquote>
      ) : null}
    </div>
  );
}
