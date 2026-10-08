// Reading what a vendor says about tax next to a price. Pure, no I/O.
//
// The model returns one tax basis for the whole document and puts anything more specific into a line's free text
// conditions ("GST included (12%)") or the quote level notes. This module reads those texts deterministically:
//   - a line (or a later correction in the document) that says its price includes tax is incl, with the stated rate;
//   - a blanket statement that is contradicted by another statement is a conflict, never silently resolved;
//   - a line that contradicts itself has no usable basis.
// It never decides a price. normalizePrice divides by 1 plus the stated rate; this only says which rate and why.

export type TaxStatement = { basis: 'incl' | 'excl'; rate_pct: number | null; text: string; blanket: boolean };

const TAX = '(?:gst|taxes|tax|vat)';
const INCL = '(?:incl\\w*|inclusive|included|including)';
const EXCL = '(?:extra|excl\\w*|excluded|exclusive|additional|separately)';
const RATE_BIT = '(?:[@(]?\\s*\\d+(?:\\.\\d+)?\\s*(?:%|percent|per cent)\\)?\\W+)?';

const INCL_RES = [new RegExp(`\\b${INCL}\\W+(?:of\\W+)?(?:all\\W+)?${RATE_BIT}${TAX}\\b`, 'i'), new RegExp(`\\b${TAX}\\W+${RATE_BIT}${INCL}\\b`, 'i')];
const EXCL_RES = [
  new RegExp(`\\b${TAX}\\W+${RATE_BIT}(?:is\\W+|are\\W+)?${EXCL}\\b`, 'i'),
  new RegExp(`\\b${EXCL}\\W+(?:of\\W+)?${TAX}\\b`, 'i'),
  new RegExp(`\\+\\s*${TAX}\\b`, 'i'),
  new RegExp(`\\bplus\\W+(?:applicable\\W+)?${TAX}\\b`, 'i'),
  new RegExp(`\\bex[- ]${TAX}\\b`, 'i'),
];
const RATE = /(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/i;
const BLANKET = /\b(all|every|entire|overall|sab|sabhi|saare|sarey)\b/i;
const DISCOUNT = /\b(discount|rebate)\b/i;
// An inclusive figure the vendor gives for the reader's convenience is not the quoted price. "shown" or "given" alone is
// not enough ("Prices shown are GST inclusive" is a real statement); it counts only with words that say the basic
// figure is the quoted one, or when the sheet has an including tax column (see isDualRateGrid).
const INFO_RE = /\b(?:for\s+(?:your\s+|ur\s+|the\s+|our\s+)?(?:convenience|reference|information|info|illustration)|informational|fyi)\b/i;
const SHOWN_RE = /\b(?:shown|given|displayed|listed|mentioned|provided)\b/i;
const BASIC_QUOTED_RE = /\b(?:(?:basic|base|net|ex[- ]?(?:gst|tax))\s+(?:rate|price)s?\s+(?:is|are)\s+(?:the\s+)?(?:quoted|offered|actual|firm)|(?:quoted|offered|actual)\s+(?:price|rate)s?\s+(?:is|are)\s+(?:the\s+)?(?:basic|base|net))/i;

/** True when a clause only gives an inclusive figure for information. `dual` is true when the sheet has an incl tax column. */
export function isInformationalClause(c: string, dual = false): boolean {
  if (INFO_RE.test(c)) return true;
  if (SHOWN_RE.test(c) && (dual || BASIC_QUOTED_RE.test(c))) return true;
  return BASIC_QUOTED_RE.test(c) && INCL_RES.some((re) => re.test(c));
}

/** Sentences and clauses of a text, split without breaking a decimal such as 12.5. */
function clauses(text: string): string[] {
  // "incl. GST" and "excl. GST" are not sentence ends.
  return text.replace(/\b(incl|excl|inc|exc|ex|approx|rs|re|no)\./gi, '$1').split(/(?<!\d)\.(?!\d)|[;\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Where the earliest match of any of the patterns starts, or -1. */
function firstAt(res: RegExp[], text: string): number {
  const at = res.map((re) => re.exec(text)?.index ?? -1).filter((n) => n >= 0);
  return at.length ? Math.min(...at) : -1;
}

/**
 * The tax statements in one piece of text. A clause that says both ways on its own is returned as two statements,
 * each with its own fragment of the clause: cut at the last comma before the later statement, so that the product
 * words of one statement are not read as the scope of the other.
 */
export function taxStatements(text: string, dual = false): TaxStatement[] {
  const out: TaxStatement[] = [];
  for (const c of clauses(text)) {
    if (DISCOUNT.test(c)) continue; // "4% discount if PO above Rs 25 lakh excl GST" describes the discount threshold, not the price
    const info = isInformationalClause(c, dual);
    const incl = !info && INCL_RES.some((re) => re.test(c));
    const excl = EXCL_RES.some((re) => re.test(c));
    const blanket = BLANKET.test(c);
    const rateOf = (t: string) => {
      const rate = RATE.exec(t);
      return rate && Number(rate[1]) > 0 && Number(rate[1]) <= 40 ? Number(rate[1]) : null;
    };
    if (incl && excl) {
      const i = firstAt(INCL_RES, c);
      const e = firstAt(EXCL_RES, c);
      const second = Math.max(i, e);
      const comma = c.lastIndexOf(',', second);
      const cut = comma > Math.min(i, e) ? comma : -1;
      const first = cut > 0 ? c.slice(0, cut).trim() : c;
      const rest = cut > 0 ? c.slice(cut + 1).trim() : c;
      const inclText = i <= e ? first : rest;
      const exclText = i <= e ? rest : first;
      out.push({ basis: 'incl', rate_pct: rateOf(inclText), text: inclText, blanket: BLANKET.test(inclText) });
      out.push({ basis: 'excl', rate_pct: null, text: exclText, blanket: BLANKET.test(exclText) });
      continue;
    }
    if (incl) out.push({ basis: 'incl', rate_pct: rateOf(c), text: c, blanket });
    if (excl) out.push({ basis: 'excl', rate_pct: null, text: c, blanket });
  }
  return out;
}

export type TaxConflict = { a: string; b: string };

export type TaxResolution = {
  /** What the price is quoted on. unknown means the vendor did not say, or contradicted themselves. */
  basis: 'excl_gst' | 'incl_gst' | 'unknown';
  /** The rate the vendor stated for an inclusive price. null means none was stated and the assumed rate applies. */
  rate_pct: number | null;
  source: 'line' | 'document' | 'notes' | 'model' | 'none';
  /** The vendor's own words that the basis rests on. */
  statement: string | null;
  /** Two statements in the document that disagree and affect this line. */
  conflict: TaxConflict | null;
  /** This line's own text says both included and extra. No basis can be used. */
  contradiction: TaxConflict | null;
  /**
   * The document makes tax statements that may apply to this line, the line has none of its own, and nothing verified
   * settles which one governs. No excluding GST price may be derived. `rate_pct` is a rate the vendor stated for an
   * inclusive reading, used only to print the two readings as text.
   */
  guard: TaxGuard | null;
};

export type TaxGuard = { why: 'conflict' | 'scoped'; statements: string[]; rate_pct: number | null };

/** What the model resolved for one line after applying the vendor's corrections, with the checks code made on it. */
export type ModelTax = {
  basis: 'incl' | 'excl' | null;
  rate_pct: number | null;
  quote: string | null;
  /** Code found the quote verbatim in the document text. Decided once at extraction, where the text is at hand. */
  quote_found: boolean;
};

/** A document level statement the model reported, kept only when its quote was found verbatim in the document. */
export type DocTaxStatement = { quote: string; basis: 'incl' | 'excl' | null; rate_pct: number | null; scope: string; is_correction: boolean };

// Which products a statement speaks about. Nouns are the product families; a ply number only narrows them.
const NOUNS: [string, RegExp][] = [
  ['box', /\b(?:box|boxes|carton|cartons|crate|crates)\b/],
  ['sheet', /\bsheets?\b/],
  ['roll', /\brolls?\b/],
  ['tape', /\btapes?\b/],
  ['film', /\bfilms?\b/],
  ['strap', /\bstraps?\b|\bstrapping\b/],
  ['pallet', /\bpall?ets?\b/],
  ['tray', /\btrays?\b/],
  ['protector', /\bprotectors?\b/],
  ['pad', /\bpads?\b/],
  ['plate', /\bplates?\b/],
  ['partition', /\bpartitions?\b/],
  ['bag', /\bbags?\b/],
  ['paper', /\bpaper\b/],
];
const PLY = /(\d)\s*[- ]?ply\b/g;

export type TaxScope = { nouns: string[]; plies: string[]; all: boolean };

export function scopeOf(text: string): TaxScope {
  // A pack unit is not a product: "per carton", "1 carton = 100 rolls" and "rate/box" say how a price is quoted.
  const t = text.toLowerCase().replace(/(?:\bper|\/|\beach|\ba)\s*(?:box|boxes|carton|cartons|crate|crates)\b/g, ' ').replace(/\b\d+\s*(?:box|boxes|carton|cartons|crate|crates)\s*=/g, ' ');
  const nouns = NOUNS.filter(([, re]) => re.test(t)).map(([k]) => k);
  const plies = [...new Set([...t.matchAll(PLY)].map((m) => m[1] as string))];
  return { nouns, plies, all: nouns.length === 0 && plies.length === 0 };
}

/**
 * Could this scope cover the line? A scope with no product words ("all rates", "GST included") covers every line. A line
 * with no recognisable product word could be anything, so it is covered by any scope. Otherwise the scope's product
 * words must appear in the line's own text, and a ply number must agree when both state one.
 */
export function scopeCovers(scope: TaxScope, lineText: string): boolean {
  if (scope.all) return true;
  const line = scopeOf(lineText);
  if (scope.nouns.length > 0) {
    if (line.nouns.length === 0) return true;
    if (!scope.nouns.some((n) => line.nouns.includes(n))) return false;
    return scope.plies.length === 0 || line.plies.length === 0 || line.plies.some((p) => scope.plies.includes(p));
  }
  return line.plies.length === 0 || line.plies.some((p) => scope.plies.includes(p));
}

/** Lower case, bracketed addresses such as [L18] removed, quotes and dashes unified, white space collapsed. */
export function normText(s: string): string {
  return s.replace(/\[(?:L|P|T)\d+[^\]]*\]/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when the quote appears verbatim (after normText) in the document text. An empty quote is never found. */
export function quoteInText(quote: string | null | undefined, text: string | null | undefined): boolean {
  if (!quote || !text) return false;
  const q = normText(quote);
  return q.length >= 6 && normText(text).includes(q);
}

/**
 * Document level tax statements found by reading the document text itself, whatever the model reported. Each text line
 * that holds a tax statement is kept as one entry, unless it is a line the extraction already used as evidence or
 * condition for a price (that is the line's own statement). Duplicates are dropped and the list is capped.
 */
export function statementsInText(text: string | null | undefined, own: string[], cap = 24): DocTaxStatement[] {
  if (!text) return [];
  const ownNorm = own.map(normText).filter((o) => o.length >= 6);
  const seen = new Set<string>();
  const out: DocTaxStatement[] = [];
  const header = headerLines(text).lines;
  const dual = isDualRateGrid(text);
  text.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.length > 600 || out.length >= cap || header.has(idx)) return;
    const found = taxStatements(line, dual);
    if (found.length === 0) return;
    const n = normText(line);
    if (ownNorm.some((o) => n.includes(o))) return;
    if (seen.has(n)) return;
    seen.add(n);
    out.push({ quote: line.replace(/^\[(?:L|P|T)\d+[^\]]*\]\s*/, ''), basis: found[0]?.basis ?? null, rate_pct: found.find((f) => f.rate_pct != null)?.rate_pct ?? null, scope: '', is_correction: false });
  });
  return out;
}

// ---- Table headers are not tax statements ----

type TextRow = { lines: number[]; cells: string[] };
// A cell address ("F8:", "[T1 R2 C3]") or a line address ("[L18]") at the start of a cell.
const ADDR = /^(?:(?:\[(?:T\d+ R\d+ C\d+|[LP]\d+[^\]]*)\]|[A-Z]{1,3}\d+:)\s*)+/;
const NUMERIC_CELL = /^\D{0,4}\d[\d,]*(?:\.\d+)?\D{0,8}$/;
const LABEL_WORDS = /\b(?:sr|s\.?no|sl|no|item|description|particulars|goods|product|size|specification|spec|unit|uom|qty|quantity|rate|price|amount|remarks?|basic|total|hsn|code|moq)\b/gi;

function cellsOf(line: string): string[] {
  const parts = line.includes(' | ') ? line.split(' | ') : line.split(/\t|\s{2,}/);
  return parts.map((c) => c.replace(ADDR, '').trim()).filter(Boolean);
}

/** The text as rows: one row per line, except that the cells of a Word table row (one line each) are joined. */
function rowsOf(lines: string[]): TextRow[] {
  const rows: TextRow[] = [];
  let lastKey = '';
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || /^=== /.test(line) || /^Merged regions:/.test(line)) return;
    const t = /^\[(T\d+ R\d+) C\d+\]/.exec(line);
    if (t) {
      const last = rows[rows.length - 1];
      if (last && lastKey === t[1]) { last.lines.push(idx); last.cells.push(...cellsOf(line)); return; }
      lastKey = t[1] as string;
      rows.push({ lines: [idx], cells: cellsOf(line) });
      return;
    }
    lastKey = '';
    rows.push({ lines: [idx], cells: cellsOf(line) });
  });
  return rows;
}

const isLabelCell = (c: string) => c.length <= 60 && c.split(/\s+/).length <= 8 && !/^[\s\d.,%()-]+$/.test(c);
const isLabelRow = (r: TextRow) => r.cells.length >= 3 && r.cells.every(isLabelCell);
const isDataRow = (r: TextRow) => r.cells.length >= 2 && r.cells.some((c) => NUMERIC_CELL.test(c));
const numericTokens = (line: string) => (line.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? []).length;

/**
 * The header rows of the tables in a text: a row of short labels (three or more cells, none a number) directly above a
 * row of data, and a line of plain text made only of column words ("Sr Description Unit Basic rate Rate incl GST")
 * directly above a line of numbers. A prose note, even inside a table, is never a header.
 */
export function headerLines(text: string | null | undefined): { lines: Set<number>; rows: TextRow[] } {
  const lines = text ? text.split('\n') : [];
  const rows = rowsOf(lines);
  const hdr = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as TextRow;
    let isHeader = false;
    if (isLabelRow(r)) {
      let j = i + 1;
      while (j < rows.length && isLabelRow(rows[j] as TextRow)) j++;
      isHeader = j < rows.length && isDataRow(rows[j] as TextRow);
    } else if (r.cells.length < 3) {
      const one = lines[(r.lines[0] as number)] ?? '';
      const words = one.replace(ADDR, '').trim().split(/\s+/);
      const next = rows[i + 1];
      const label = new Set((one.match(LABEL_WORDS) ?? []).map((w) => w.toLowerCase()));
      isHeader = r.cells.length === 1 && words.length <= 20 && !/\d/.test(one.replace(ADDR, '')) && label.size >= 4 && next != null && numericTokens(lines[(next.lines[0] as number)] ?? '') >= 2;
    }
    if (isHeader) r.lines.forEach((n) => hdr.add(n));
  }
  return { lines: hdr, rows };
}

/** The labels of the table headers in a text, normalised, and the whole header lines. */
function headerLabels(text: string | null | undefined): { labels: Set<string>; whole: string[] } {
  const { lines, rows } = headerLines(text);
  const all = text ? text.split('\n') : [];
  const labels = new Set<string>();
  const whole: string[] = [];
  for (const r of rows) {
    if (!lines.has(r.lines[0] as number)) continue;
    r.cells.forEach((c) => labels.add(normText(c)));
    if (r.cells.length === 1) labels.add(normText(r.cells[0] as string));
    whole.push(normText(r.lines.map((n) => all[n] ?? '').join(' ')));
  }
  return { labels, whole };
}

/** True when the quote is a column header or one of its labels, not a statement. */
export function isHeaderQuote(quote: string | null | undefined, text: string | null | undefined): boolean {
  if (!quote || !text) return false;
  const { labels, whole } = headerLabels(text);
  const q = normText(quote.replace(ADDR, ''));
  if (!q) return false;
  const nq = normText(quote);
  return labels.has(q) || whole.some((w) => w.includes(nq) || nq.includes(w)) || [...labels].some((l) => l.length >= 6 && q === l);
}

/**
 * Quote level notes and verified model statements, minus the ones that are not statements about the quoted price: a
 * quote that is a column header, and, on a sheet with an including tax column, a note that only says the inclusive
 * figures are shown or given.
 */
export function cleanTaxQuotes(quotes: string[], text: string | null | undefined): string[] {
  const dual = isDualRateGrid(text);
  return quotes.filter((q) => {
    if (isHeaderQuote(q, text)) return false;
    if (dual && taxStatements(q, false).length > 0 && taxStatements(q, true).length === 0) return false;
    return true;
  });
}

const EXCL_COL = /\b(?:basic|base|net|excl\w*|ex[- ]?(?:gst|tax)|before\s+(?:gst|tax)|pre[- ]?tax|without\s+(?:gst|tax))\b/i;
const INCL_COL = /\b(?:incl\w*|inc\.?|with\s+(?:gst|tax)|after\s+(?:gst|tax)|gross)\b/i;
const MONEY_COL = /\b(?:rate|price|amount|cost)\b/i;

/** The sheet has a basic (excluding tax) rate column and an including tax rate column. The basic one is the quote. */
export function isDualRateGrid(text: string | null | undefined): boolean {
  const { lines, rows } = headerLines(text);
  return rows.some((r) => {
    if (!lines.has(r.lines[0] as number)) return false;
    const money = r.cells.filter((c) => MONEY_COL.test(c));
    return money.some((c) => INCL_COL.test(c) && /\b(?:gst|tax|vat)\b/i.test(c)) && money.some((c) => EXCL_COL.test(c) && !INCL_COL.test(c));
  });
}

/** A quoted statement shortened for display. Never used for matching. */
export function clipQuote(s: string, max = 160): string {
  return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`;
}

const fmt2 = (n: number) => n.toFixed(2);

/** The two readings of one price, as text only. Never a derived value. */
export function readingsText(price: number, rate_pct: number): string {
  return `if excluding GST: ${fmt2(price)}; if including ${rate_pct} percent: ${fmt2(price / (1 + rate_pct / 100))}`;
}

export type TaxInput = {
  doc_basis: 'excl_gst' | 'incl_gst' | 'unknown';
  conditions: string[];
  notes: string[];
  /** The line's own words and its RFx line and section. Which document statements could apply to it is judged on this. */
  scope_text?: string;
  /** The model's resolution for this line, and the document statements it reported (verified ones only). */
  model_tax?: ModelTax | null;
  doc_statements?: DocTaxStatement[];
};

/**
 * What a line's price is quoted on, with the safety rule on top (resolveBase decides, this guards).
 * A line with no tax statement of its own, in a document whose statements conflict or whose scoped statement says
 * otherwise than the basis the line would get, has no derived price unless the model's resolution is verified.
 */
export function resolveTax(input: TaxInput): TaxResolution {
  // Statements in the document text and the verified ones the model reported are read as document level notes, so the
  // guard does not depend on whether the model put them in the notes.
  const i: TaxInput = { ...input, notes: [...input.notes, ...(input.doc_statements ?? []).map((d) => d.quote)] };
  const base = resolveBase(i);
  if (base.source === 'line' || base.contradiction) return base;
  const lineText = i.scope_text ?? '';
  // The basis the line would get without the guard. An unstated basis is read as excluding GST, as the RFx asks.
  const baseline: 'incl' | 'excl' = base.basis === 'incl_gst' ? 'incl' : 'excl';
  const noteStmts = i.notes.flatMap((t) => taxStatements(t));
  // A verified model statement the regular expressions cannot read (another language, odd wording) still counts, on
  // the model's basis and its own scope words.
  const modelOnly = (i.doc_statements ?? []).filter((d) => d.basis && taxStatements(d.quote).length === 0 && !isInformationalClause(d.quote)).map((d) => ({ basis: d.basis as 'incl' | 'excl', text: d.scope || d.quote, rate_pct: d.rate_pct }));
  const docLevel = [...noteStmts.map((s) => ({ basis: s.basis, text: s.text, rate_pct: s.rate_pct })), ...modelOnly];
  const opposing = docLevel.filter((s) => s.basis !== baseline && scopeCovers(scopeOf(s.text), lineText));
  const why: TaxGuard['why'] | null = base.conflict ? 'conflict' : opposing.length > 0 ? 'scoped' : null;
  if (!why) return base;

  const m = i.model_tax;
  if (m?.basis && m.quote && m.quote_found && !isInformationalClause(m.quote)) {
    const qScope = scopeOf(m.quote);
    // A quote with no product words must be the line's own text. One with product words must cover this line.
    const covers = qScope.all ? normText(lineText).includes(normText(m.quote)) : scopeCovers(qScope, lineText);
    // A specific statement that covers the line and says the other way refuses the model's resolution. A blanket one
    // ("all rates GST extra") is what a correction overrides, so it does not.
    const contradicted = docLevel.some((s) => { const sc = scopeOf(s.text); return !sc.all && s.basis !== m.basis && scopeCovers(sc, lineText); });
    if (covers && !contradicted) {
      // The rate counts as stated only when it is in the vendor's quote. A rate only the model gave is not evidence.
      const stated = m.basis === 'incl' ? taxStatements(m.quote).find((s) => s.basis === 'incl')?.rate_pct ?? null : null;
      return m.basis === 'incl'
        ? { basis: 'incl_gst', rate_pct: stated, source: 'model', statement: m.quote, conflict: base.conflict, contradiction: null, guard: null }
        : { basis: 'excl_gst', rate_pct: null, source: 'model', statement: m.quote, conflict: base.conflict, contradiction: null, guard: null };
    }
  }
  const inclRates = [...new Set(docLevel.filter((s) => s.basis === 'incl' && s.rate_pct != null && scopeCovers(scopeOf(s.text), lineText)).map((s) => s.rate_pct as number))];
  const texts = base.conflict ? [base.conflict.a, base.conflict.b] : opposing.map((s) => s.text);
  return { basis: 'unknown', rate_pct: null, source: 'none', statement: null, conflict: base.conflict, contradiction: null, guard: { why, statements: texts, rate_pct: inclRates.length === 1 ? (inclRates[0] as number) : null } };
}

/**
 * What a line's price is quoted on. Order of authority: the line's own conditions, then the document's tax basis,
 * then a blanket statement in the quote notes. A conflict is raised when a blanket statement (the document basis or
 * a note that speaks of all rates) is opposed by a line or note, and it affects every line that either opposes the
 * blanket statement or has no statement of its own.
 */
function resolveBase(i: TaxInput): TaxResolution {
  const own = i.conditions.flatMap((t) => taxStatements(t));
  const noteStmts = i.notes.flatMap((t) => taxStatements(t));
  const none: TaxResolution = { basis: 'unknown', rate_pct: null, source: 'none', statement: null, conflict: null, contradiction: null, guard: null };

  const ownIncl = own.find((s) => s.basis === 'incl');
  const ownExcl = own.find((s) => s.basis === 'excl');
  if (ownIncl && ownExcl) return { ...none, contradiction: { a: ownIncl.text, b: ownExcl.text } };

  // Blanket statements: the document basis, and notes about all rates.
  // The document basis is the model's reading of the whole document, notes included, so only a line's own statement
  // can contradict it. A blanket statement found in the notes can be contradicted by the line or by another note.
  const blankets: { basis: 'incl' | 'excl'; text: string; rate_pct: number | null; fromDoc: boolean }[] = [
    ...(i.doc_basis === 'unknown' ? [] : [{ basis: i.doc_basis === 'incl_gst' ? ('incl' as const) : ('excl' as const), text: `The document states prices ${i.doc_basis === 'incl_gst' ? 'include' : 'exclude'} GST.`, rate_pct: null, fromDoc: true }]),
    ...noteStmts.filter((s) => s.blanket).map((s) => ({ ...s, fromDoc: false })),
  ];
  const mine = own[0];
  const blanketBases = new Set(blankets.map((b) => b.basis));
  // Counter statements: anything that says the other way from a blanket statement.
  let conflict: TaxConflict | null = null;
  for (const b of blankets) {
    const counter = (b.fromDoc ? own : [...own, ...noteStmts]).find((c) => c.basis !== b.basis);
    if (counter) {
      const affected = mine ? mine.basis !== b.basis : true;
      if (affected) { conflict = { a: b.text, b: counter.text }; break; }
    }
  }
  // A blanket pair that disagrees with itself is a conflict even for a line with no statement of its own.
  if (!conflict && blanketBases.size > 1) {
    const x = blankets.find((b) => b.basis === 'incl');
    const y = blankets.find((b) => b.basis === 'excl');
    if (x && y) conflict = { a: x.text, b: y.text };
  }

  const inclNoteRates = [...new Set(noteStmts.filter((s) => s.basis === 'incl' && s.rate_pct != null).map((s) => s.rate_pct as number))];
  const inclRate = (own: TaxStatement | undefined): number | null => own?.rate_pct ?? (inclNoteRates.length === 1 ? (inclNoteRates[0] as number) : null);

  if (mine) {
    return mine.basis === 'incl'
      ? { basis: 'incl_gst', rate_pct: mine.rate_pct, source: 'line', statement: mine.text, conflict, contradiction: null, guard: null }
      : { basis: 'excl_gst', rate_pct: null, source: 'line', statement: mine.text, conflict, contradiction: null, guard: null };
  }
  if (conflict) return { ...none, conflict };
  if (i.doc_basis === 'incl_gst') return { basis: 'incl_gst', rate_pct: inclRate(undefined), source: 'document', statement: null, conflict: null, contradiction: null, guard: null };
  if (i.doc_basis === 'excl_gst') return { basis: 'excl_gst', rate_pct: null, source: 'document', statement: null, conflict: null, contradiction: null, guard: null };
  const only = blankets[0];
  if (only && blanketBases.size === 1) {
    return only.basis === 'incl'
      ? { basis: 'incl_gst', rate_pct: only.rate_pct ?? inclRate(undefined), source: 'notes', statement: only.text, conflict: null, contradiction: null, guard: null }
      : { basis: 'excl_gst', rate_pct: null, source: 'notes', statement: only.text, conflict: null, contradiction: null, guard: null };
  }
  return none;
}

/** Two different conflicts are the same finding when both texts match. */
export function uniqueConflicts(list: (TaxConflict | null)[]): TaxConflict[] {
  const seen = new Map<string, TaxConflict>();
  for (const c of list) if (c) seen.set(`${c.a}\u0000${c.b}`, c);
  return [...seen.values()];
}

export function conflictText(c: TaxConflict): string {
  return `Conflicting tax statements: "${clipQuote(c.a)}" and "${clipQuote(c.b)}".`;
}
