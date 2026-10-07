// Builds xlsx and csv downloads from a stored analyst result. The file carries the same notes
// the chat showed (the SQL or scenario, assumptions, caveats), so an export cannot hide them.
import ExcelJS from 'exceljs';
import type { StoredResult, Table } from './types.js';

const NUMFMT: Record<string, string | undefined> = { inr: '#,##0.00', inr_unit: '#,##0.00', pct: '0.0', int: '#,##0', num: '#,##0.00' };

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  // Guard against spreadsheet formula injection from text that came from a vendor document.
  const safe = /^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(t: Table): string {
  const head = t.columns.map((c) => csvCell(c.label)).join(',');
  const rows = t.rows.map((r) => t.columns.map((c) => csvCell(r[c.key])).join(','));
  return [head, ...rows].join('\n') + '\n';
}

export async function toXlsx(res: StoredResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QuoteDesk';
  wb.created = new Date();
  const about = wb.addWorksheet('About');
  about.columns = [{ width: 110 }];
  about.addRow([res.title]).font = { bold: true, size: 13 };
  about.addRow([`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from QuoteDesk analyst result ${res.id}.`]);
  about.addRow(['All prices are INR excluding GST at the assumptions listed below. Not quoted is blank, never zero.']);
  about.addRow([]);
  for (const n of res.notes) about.addRow([n]).alignment = { wrapText: true, vertical: 'top' };
  for (const t of res.tables) {
    const ws = wb.addWorksheet(t.title.slice(0, 30).replace(/[\\/?*[\]:]/g, ' '));
    ws.columns = t.columns.map((c) => ({ header: c.label, key: c.key, width: c.type === 'text' ? 44 : 18, style: { numFmt: NUMFMT[c.type] } }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of t.rows) {
      const row = ws.addRow(Object.fromEntries(t.columns.map((c) => [c.key, r[c.key] ?? null])));
      row.eachCell((cell) => {
        if (typeof cell.value === 'string' && /^[=+@]/.test(cell.value)) cell.value = `'${cell.value}`;
      });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
