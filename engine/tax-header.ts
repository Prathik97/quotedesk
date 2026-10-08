// The tax basis a sheet states in its own column headers (K5). Pure, no I/O.
//
// A price cell sits under a header such as "Basic rate (excl GST)" or "Rate incl. GST". That header is the vendor's own
// statement about the figures in the column, read from the sheet itself and not from anything the model wrote. This
// module maps a price cell to its header (a header row that is not row 1, a merged header, a two level header),
// classifies the header deterministically, and, when the row holds both an excluding and an including cell, checks
// which of them the model's price was read from. It never decides a price.
import { clipQuote, statementsInText, type DocTaxStatement } from './tax';

export type HeaderBasis = 'excl' | 'incl';

export type HeaderTax = {
  /** What the price cell's own column header says. */
  basis: HeaderBasis;
  /** The rate named in the header, or null (the document's stated rate or the assumed rate applies). */
  rate_pct: number | null;
  /** The header text the basis rests on, with its price cell, for example "Basic rate (excl GST) (E15)". */
  header: string;
  cell: string;
  /** Statements found by reading the sheet's own text (never the model's notes) that may speak about this line. */
  prose: DocTaxStatement[];
  /** The row holds both an excluding and an including cell and the model's price was not read from the excluding one. */
  problem: { kind: 'incl_column_read' | 'evidence_mismatch'; text: string } | null;
};

// ---- Classifying a header ----

const TAX = '(?:gst|igst|cgst|sgst|taxes|tax|vat)';
const EXCL_Q = [
  new RegExp(`\\bex[-\\s]?${TAX}\\b`, 'i'),
  new RegExp(`\\bexcl\\w*\\.?\\s*(?:of\\s+)?${TAX}\\b`, 'i'),
  new RegExp(`\\b${TAX}\\s*(?:extra|excl\\w*|excluded|exclusive)\\b`, 'i'),
  new RegExp(`\\bbefore\\s+${TAX}\\b`, 'i'),
  new RegExp(`\\bpre[-\\s]?tax\\b`, 'i'),
  new RegExp(`\\bwithout\\s+${TAX}\\b`, 'i'),
  new RegExp(`\\bnet\\s+of\\s+${TAX}\\b`, 'i'),
  new RegExp(`\\+\\s*${TAX}\\b`, 'i'),
];
const INCL_Q = [
  new RegExp(`\\binc(?:l\\w*)?\\.?\\s*(?:of\\s+)?${TAX}\\b`, 'i'),
  new RegExp(`\\b${TAX}\\s*(?:@?\\s*\\d+(?:\\.\\d+)?\\s*%\\s*)?inc(?:l\\w*)?\\b`, 'i'),
  new RegExp(`\\bwith\\s+${TAX}\\b`, 'i'),
  new RegExp(`\\bafter\\s+${TAX}\\b`, 'i'),
  new RegExp(`\\b${TAX}\\s+paid\\b`, 'i'),
];
// Bare words count only when the header is about a price. "Gross weight" and "Freight (excl.)" are not tax statements.
const PRICE_WORD = /\b(?:rate|rates|price|prices|amount|cost|value|quote|rs|inr)\b|[₹/]/i;
const EXCL_BARE = /\b(?:basic|base|net|excl\w*|exclusive)\b/i;
const INCL_BARE = /\b(?:incl\w*|inc\.|inclusive|gross)\b/i;
// "excl. freight" and "incl. packing" say nothing about tax.
const NOT_TAX = /\b(?:excl\w*|incl\w*|inc\.?|exclusive|inclusive)\.?\s*(?:of\s+)?(?:freight|transport\w*|packing|packaging|loading|unloading|insurance|delivery|discounts?|cess|octroi|cartage|forwarding|handling|pallets?|boxes|cartons|carton|dies?|printing)\b/gi;
const HEADER_RATE = /(\d+(?:\.\d+)?)\s*%/;

export function classifyHeader(raw: string): { basis: HeaderBasis | null; rate_pct: number | null } {
  const t = raw.replace(NOT_TAX, ' ').replace(/\s+/g, ' ').trim();
  const q = { excl: EXCL_Q.some((re) => re.test(t)), incl: INCL_Q.some((re) => re.test(t)) };
  let basis: HeaderBasis | null = null;
  if (q.excl !== q.incl) basis = q.excl ? 'excl' : 'incl';
  else if (!q.excl && !q.incl && PRICE_WORD.test(t)) {
    const b = { excl: EXCL_BARE.test(t), incl: INCL_BARE.test(t) };
    if (b.excl !== b.incl) basis = b.excl ? 'excl' : 'incl';
  }
  const rate = basis === 'incl' ? HEADER_RATE.exec(t) : null;
  const rate_pct = rate && Number(rate[1]) > 0 && Number(rate[1]) <= 40 ? Number(rate[1]) : null;
  return { basis, rate_pct };
}

// ---- Reading the sheets out of the prepared text ----

type Cell = { row: number; col: number; text: string };
type Sheet = { name: string; cells: Map<string, Cell>; merges: { r1: number; c1: number; r2: number; c2: number }[] };
export type Grid = { sheets: Sheet[] };

const colNum = (letters: string) => letters.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number) => { let s = ''; for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s; return s; };
const key = (row: number, col: number) => `${row}:${col}`;
export const addr = (row: number, col: number) => `${colName(col)}${row}`;

/** Parses the text prepareXlsx writes: "=== Sheet 'X' ===", "Merged regions: A1:G1, ...", and rows of "A8: text | B8: text". */
export function parseGrid(text: string | null | undefined): Grid {
  const sheets: Sheet[] = [];
  if (!text) return { sheets };
  let cur: Sheet | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const head = /^=== Sheet '(.*)'(?: \[HIDDEN SHEET[^\]]*\])? ===$/.exec(line);
    if (head) { cur = { name: head[1] as string, cells: new Map(), merges: [] }; sheets.push(cur); continue; }
    if (!cur) continue;
    const m = /^Merged regions:\s*(.*)$/.exec(line);
    if (m) {
      for (const r of (m[1] as string).split(',')) {
        const a = /^\s*([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)\s*$/.exec(r);
        if (a) cur.merges.push({ r1: Number(a[2]), c1: colNum(a[1] as string), r2: Number(a[4]), c2: colNum(a[3] as string) });
      }
      continue;
    }
    // A cell's own text may contain " | ", so a part that does not start with an address continues the previous cell.
    let last: Cell | null = null;
    for (const part of line.split(' | ')) {
      const c = /^([A-Z]{1,3})(\d+): ?(.*)$/.exec(part);
      if (c) {
        last = { row: Number(c[2]), col: colNum(c[1] as string), text: (c[3] as string).trim() };
        cur.cells.set(key(last.row, last.col), last);
      } else if (last) last.text = `${last.text} | ${part}`.trim();
    }
  }
  return { sheets };
}

/** A cell address in a locator: "Sheet 'Quote'!E15", "'Quote'!E15", "Quote!E15", "E15", "E15:F15". */
export function parseLocator(locator: string | null | undefined, quote?: string | null): { sheet: string | null; row: number; col: number } | null {
  const tryOne = (s: string | null | undefined) => {
    if (!s) return null;
    const cellAt = /(?:^|!)\s*\$?([A-Z]{1,3})\$?(\d+)(?::\$?[A-Z]{1,3}\$?\d+)?\s*$/i.exec(s);
    if (!cellAt) return null;
    const bang = s.lastIndexOf('!');
    const sheetPart = bang > 0 ? s.slice(0, bang).replace(/^\s*Sheet\s+/i, '').trim() : '';
    const sheet = sheetPart.replace(/^'(.*)'$/, '$1').replace(/''/g, "'").trim();
    return { sheet: sheet || null, row: Number(cellAt[2]), col: colNum(cellAt[1] as string) };
  };
  return tryOne(locator) ?? tryOne(quote?.match(/^\s*([A-Z]{1,3}\d+):/)?.[1] ?? null);
}

const NUMERIC = /^\s*(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:\/-)?\s*$/i;
export function cellNumber(t: string | undefined): number | null {
  const m = t ? NUMERIC.exec(t) : null;
  return m ? Number((m[1] as string).replace(/,/g, '')) : null;
}

function at(sheet: Sheet, row: number, col: number): string | undefined {
  const own = sheet.cells.get(key(row, col));
  if (own) return own.text;
  const m = sheet.merges.find((g) => row >= g.r1 && row <= g.r2 && col >= g.c1 && col <= g.c2);
  return m ? sheet.cells.get(key(m.r1, m.c1))?.text : undefined;
}

/**
 * The header block above a price cell, outermost level first. Data rows above the cell (numbers and blanks) are skipped
 * to reach the nearest text cell of the column; that cell and the text cells directly above it (up to three levels in
 * all, merged cells included) are the header. A text cell in a data row ("On request") would be read as the header and
 * state no basis, which leaves the line to the existing logic.
 */
function headerLevels(sheet: Sheet, row: number, col: number): { text: string; row: number }[] {
  let r = row - 1;
  while (r >= 1 && row - r <= 400) {
    const t = at(sheet, r, col);
    if (t && cellNumber(t) == null) break;
    r--;
  }
  const levels: { text: string; row: number }[] = [];
  for (; r >= 1 && levels.length < 3; r--) {
    const t = at(sheet, r, col);
    if (!t || cellNumber(t) != null) break;
    if (t.length > 120) break;
    if (!levels.some((l) => l.text === t)) levels.push({ text: t, row: r });
  }
  return levels.reverse();
}

/** The header of a column at a data row: the nearest level that states a basis, with the whole header for display. */
export function columnHeader(sheet: Sheet, row: number, col: number): { basis: HeaderBasis | null; rate_pct: number | null; text: string } {
  const levels = headerLevels(sheet, row, col);
  const text = levels.map((l) => l.text).join(' / ');
  for (const l of [...levels].reverse()) {
    const c = classifyHeader(l.text);
    if (c.basis) return { basis: c.basis, rate_pct: c.rate_pct, text };
  }
  return { basis: null, rate_pct: null, text };
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 0.005 + 1e-9 * Math.abs(b);

export type HeaderTaxInput = {
  text: string | null | undefined;
  locator: string | null | undefined;
  quote?: string | null;
  price: number | null;
  per_n?: number | null;
  /** Statements in the sheet's own text that could apply to this line. Computed by the caller from the text alone. */
  prose: DocTaxStatement[];
};

/**
 * The tax basis the line's price column states, or null when the line has no usable header (not a sheet, a cell that
 * cannot be found, a neutral header). Only the sheet's text and the model's price and cell address are read; the model's
 * notes, conditions and document basis play no part, so the result does not depend on the model's wording.
 */
export function headerTaxFor(i: HeaderTaxInput, grid: Grid = parseGrid(i.text)): HeaderTax | null {
  const loc = parseLocator(i.locator, i.quote);
  if (!loc || grid.sheets.length === 0) return null;
  const sheet = grid.sheets.find((s) => loc.sheet != null && s.name.toLowerCase() === loc.sheet.toLowerCase()) ?? (loc.sheet == null && grid.sheets.length === 1 ? grid.sheets[0] : grid.sheets.find((s) => s.cells.has(key(loc.row, loc.col))));
  if (!sheet || (sheet.cells.get(key(loc.row, loc.col)) == null && !sheet.merges.length)) return null;
  const own = columnHeader(sheet, loc.row, loc.col);
  const cell = addr(loc.row, loc.col);

  // Every figure in the row that sits under an excluding or an including header.
  const row: { basis: HeaderBasis; value: number; cell: string; header: string }[] = [];
  for (const c of sheet.cells.values()) {
    if (c.row !== loc.row) continue;
    const v = cellNumber(c.text);
    if (v == null) continue;
    const h = columnHeader(sheet, c.row, c.col);
    if (h.basis) row.push({ basis: h.basis, value: v, cell: addr(c.row, c.col), header: h.text });
  }
  const excl = row.find((r) => r.basis === 'excl');
  const incl = row.find((r) => r.basis === 'incl');
  const shown = (h: string) => clipQuote(h, 80);
  if (excl && incl && i.price != null) {
    const candidates = [i.price, i.price * (i.per_n && i.per_n > 0 ? i.per_n : 1), i.price / (i.per_n && i.per_n > 0 ? i.per_n : 1)];
    const hit = (v: number) => candidates.some((p) => sameNumber(p, v));
    const base = { rate_pct: incl.header ? classifyHeader(incl.header).rate_pct : null, prose: i.prose };
    if (hit(excl.value)) return { basis: 'excl', rate_pct: null, header: shown(excl.header), cell: excl.cell, prose: i.prose, problem: null };
    if (hit(incl.value)) {
      return { basis: 'incl', rate_pct: base.rate_pct, header: shown(incl.header), cell: incl.cell, prose: i.prose, problem: { kind: 'incl_column_read', text: `Read from the including-tax column ("${shown(incl.header)}", ${incl.cell}); the basic column ("${shown(excl.header)}", ${excl.cell}) shows ${excl.value}. No price excluding GST is derived from the including-tax figure.` } };
    }
    return { basis: 'excl', rate_pct: null, header: shown(excl.header), cell: excl.cell, prose: i.prose, problem: { kind: 'evidence_mismatch', text: `The price read (${i.price}) matches neither the basic column ("${shown(excl.header)}", ${excl.cell}: ${excl.value}) nor the including-tax column ("${shown(incl.header)}", ${incl.cell}: ${incl.value}) of its row.` } };
  }
  if (!own.basis) return null;
  return { basis: own.basis, rate_pct: own.rate_pct, header: shown(own.text), cell, prose: i.prose, problem: null };
}

/**
 * Statements in the sheet's own text only, never the model's, for a header derived line. Header rows are already
 * excluded by statementsInText. The result is the same for every line, so the caller computes it once.
 */
export function sheetProse(text: string | null | undefined, own: string[]): DocTaxStatement[] {
  return statementsInText(text, own);
}
