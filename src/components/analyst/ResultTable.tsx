// A sortable table rendered from a stored tool result. Rows that carry a quote_line_id open the evidence drawer.
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { STATUS_LABEL, type CellStatus } from '../../../engine/certainty';
import { formatCell, type StoredResult } from '@/lib/analyst';
import { useApp } from '@/lib/store';
import { STATUS_ICON, STATUS_TEXT_CLASS } from '@/lib/status';
import { cn } from '@/lib/utils';

type T = StoredResult['tables'][number];

const LABEL_TO_STATUS = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [v, k])) as Record<string, CellStatus>;

export function ResultTable({ table, resultId, defaultOpen = true }: { table: T; resultId: string; defaultOpen?: boolean }) {
  const { data, openCell } = useApp();
  const [open, setOpen] = useState(defaultOpen);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const cols = table.columns.filter((c) => c.key !== 'quote_line_id' && table.rows.some((r) => r[c.key] !== '' && r[c.key] != null));
  const rows = useMemo(() => {
    if (!sort) return table.rows;
    return [...table.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
      if (x == null || x === '') return 1;
      if (y == null || y === '') return -1;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * sort.dir;
    });
  }, [table.rows, sort]);

  const openRow = (id: unknown) => {
    if (typeof id !== 'string' || !data) return;
    const c = data.cells.find((x) => x.quote_line_id === id);
    if (c) openCell(c.vendor_id, c.rfx_line_id, id);
  };

  return (
    <div id={`result-${resultId}-${table.name}`} className="rounded-md border border-border bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium">
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {table.title}
        <span className="text-xs font-normal text-muted-foreground">
          {table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'}, from result {resultId}
        </span>
      </button>
      {open ? (
        <div className="max-h-96 overflow-auto border-t border-border">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {cols.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th key={c.key} scope="col" aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={cn('whitespace-nowrap px-2 py-1.5 font-semibold', c.type === 'text' || c.type === 'status' ? 'text-left' : 'text-right')}>
                      <button type="button" onClick={() => setSort(active && sort.dir === 1 ? { key: c.key, dir: -1 } : { key: c.key, dir: 1 })} className="inline-flex items-center gap-1 hover:underline" title={`Sort by ${c.label}`}>
                        {c.label}
                        {active ? sort.dir === 1 ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden /> : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const id = r.quote_line_id;
                const clickable = typeof id === 'string' && !!data?.cells.some((x) => x.quote_line_id === id);
                return (
                  <tr key={i} className={cn('border-t border-border', clickable && 'cursor-pointer hover:bg-teal-50')} onClick={clickable ? () => openRow(id) : undefined}>
                    {cols.map((c, ci) => {
                      const v = r[c.key];
                      if (c.type === 'status' && typeof v === 'string') {
                        const st = LABEL_TO_STATUS[v];
                        const I = st ? STATUS_ICON[st] : null;
                        return (
                          <td key={c.key} className={cn('whitespace-nowrap px-2 py-1', st && STATUS_TEXT_CLASS[st])}>
                            <span className="inline-flex items-center gap-1">
                              {I ? <I size={12} aria-hidden /> : null}
                              {v}
                            </span>
                          </td>
                        );
                      }
                      const right = c.type !== 'text';
                      return (
                        <td key={c.key} className={cn('px-2 py-1', right ? 'tabular whitespace-nowrap text-right' : 'max-w-md')}>
                          {ci === 0 && clickable ? (
                            <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); openRow(id); }} title="Open the evidence for this cell">
                              {formatCell(c.type, v)}
                            </button>
                          ) : (
                            formatCell(c.type, v)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
