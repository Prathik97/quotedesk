// Builds what the source view shows for a document: an Excel grid, addressed
// text lines for Word and email, or a hint to embed the PDF or image.
import ExcelJS from 'exceljs';
import type { DocumentPreview, SourceContext } from '../../../src/lib/api-types.js';
import { prepareDocx, prepareEml, prepareMessageBody } from '../extract/prepare.js';
import { downloadBytes, isMessageBody } from './storage.js';

export type DocForSource = {
  id: string;
  filename: string;
  mime: string;
  storage_path: string;
  message?: { from: string | null; subject: string | null; received: string | null; body: string | null } | null;
};

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v && v.result != null) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('error' in v) return String(v.error);
  }
  return String(v);
}

const wbCache = new Map<string, ExcelJS.Workbook>();
async function workbook(doc: DocForSource): Promise<ExcelJS.Workbook> {
  const hit = wbCache.get(doc.storage_path);
  if (hit) return hit;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await downloadBytes(doc.storage_path)) as unknown as ArrayBuffer);
  if (wbCache.size >= 3) wbCache.delete(wbCache.keys().next().value as string);
  wbCache.set(doc.storage_path, wb);
  return wb;
}

type GridRow = { row: number; cells: { addr: string; text: string; target?: boolean }[] };

function sheetRows(ws: ExcelJS.Worksheet, keep: (row: number) => boolean, target?: string): GridRow[] {
  const rows: GridRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (!keep(n)) return;
    const cells: GridRow['cells'] = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.isMerged && cell.master.address !== cell.address) return;
      const t = cellText(cell.value).replace(/\s+/g, ' ').trim();
      if (t) cells.push({ addr: cell.address, text: t.slice(0, 140), ...(target && cell.address === target ? { target: true } : {}) });
    });
    if (cells.length) rows.push({ row: n, cells });
  });
  return rows;
}

/** Text lines for Word, email and message bodies, each with its address label such as P10 or L11. */
async function textLines(doc: DocForSource): Promise<{ label: string; text: string }[]> {
  let text: string;
  if (isMessageBody(doc.storage_path)) {
    text = prepareMessageBody({ from: doc.message?.from ?? '', subject: doc.message?.subject ?? '', received: doc.message?.received ?? '' }, doc.message?.body ?? '').text ?? '';
  } else if (doc.mime === DOCX) {
    text = (await prepareDocx(await downloadBytes(doc.storage_path))).text ?? '';
  } else if (doc.mime === 'message/rfc822') {
    text = (await prepareEml(await downloadBytes(doc.storage_path))).text ?? '';
  } else {
    text = Buffer.from(await downloadBytes(doc.storage_path)).toString('utf8');
  }
  return text.split('\n').map((l) => {
    const m = l.match(/^\[([^\]]+)\]\s?(.*)$/);
    return m ? { label: m[1] ?? '', text: m[2] ?? '' } : { label: '', text: l };
  });
}

/** The few rows around one cell, plus the sheet's first rows so the column headings are visible. */
export async function evidenceContext(doc: DocForSource, locator: string, sourceType: string, page: number | null): Promise<SourceContext> {
  try {
    if (sourceType === 'image') return { kind: 'image' };
    if (sourceType === 'pdf' || doc.mime === 'application/pdf') return { kind: 'pdf', page };
    if (sourceType === 'xlsx' || doc.mime === XLSX) {
      const m = locator.match(/^Sheet '(.+)'!([A-Z]+)(\d+)$/);
      if (!m) return { kind: 'none', note: 'The cell address could not be read, so no surrounding rows are shown.' };
      const wb = await workbook(doc);
      const ws = wb.getWorksheet(m[1] as string);
      if (!ws) return { kind: 'none', note: `The sheet ${m[1]} was not found in the stored file.` };
      const addr = `${m[2]}${m[3]}`;
      const r = Number(m[3]);
      const rows = sheetRows(ws, (n) => n <= 5 || Math.abs(n - r) <= 3, addr);
      return { kind: 'grid', sheet: ws.name, hidden: ws.state !== 'visible', target: addr, rows };
    }
    const lines = await textLines(doc);
    const i = lines.findIndex((l) => l.label !== '' && l.label.toLowerCase() === locator.toLowerCase());
    if (i < 0) return { kind: 'none', note: 'The line could not be located in the stored text.' };
    return { kind: 'lines', lines: lines.slice(Math.max(0, i - 3), i + 4).map((l, k) => ({ ...l, target: Math.max(0, i - 3) + k === i })) };
  } catch (e) {
    return { kind: 'none', note: `The source could not be loaded (${(e as Error).message}).` };
  }
}

/** Whole document for the source view. */
export async function documentPreview(doc: DocForSource): Promise<DocumentPreview['preview']> {
  if (doc.mime === 'application/pdf') return { kind: 'pdf' };
  if (doc.mime.startsWith('image/')) return { kind: 'image' };
  if (doc.mime === XLSX) {
    const wb = await workbook(doc);
    const sheets: Extract<DocumentPreview['preview'], { kind: 'xlsx' }>['sheets'] = [];
    wb.eachSheet((ws) => {
      sheets.push({ name: ws.name, hidden: ws.state !== 'visible', rows: sheetRows(ws, (n) => n <= 120), merges: (ws.model as { merges?: string[] }).merges ?? [] });
    });
    return { kind: 'xlsx', sheets };
  }
  return { kind: 'lines', lines: await textLines(doc) };
}
