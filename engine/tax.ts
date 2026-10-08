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

/** Sentences and clauses of a text, split without breaking a decimal such as 12.5. */
function clauses(text: string): string[] {
  // "incl. GST" and "excl. GST" are not sentence ends.
  return text.replace(/\b(incl|excl|inc|exc|ex|approx|rs|re|no)\./gi, '$1').split(/(?<!\d)\.(?!\d)|[;\n]/).map((s) => s.trim()).filter(Boolean);
}

/** The tax statements in one piece of text. A clause that says both ways on its own is returned as two statements. */
export function taxStatements(text: string): TaxStatement[] {
  const out: TaxStatement[] = [];
  for (const c of clauses(text)) {
    if (DISCOUNT.test(c)) continue; // "4% discount if PO above Rs 25 lakh excl GST" describes the discount threshold, not the price
    const incl = INCL_RES.some((re) => re.test(c));
    const excl = EXCL_RES.some((re) => re.test(c));
    const rate = RATE.exec(c);
    const rate_pct = rate && Number(rate[1]) > 0 && Number(rate[1]) <= 40 ? Number(rate[1]) : null;
    const blanket = BLANKET.test(c);
    if (incl) out.push({ basis: 'incl', rate_pct, text: c, blanket });
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
  source: 'line' | 'document' | 'notes' | 'none';
  /** The vendor's own words that the basis rests on. */
  statement: string | null;
  /** Two statements in the document that disagree and affect this line. */
  conflict: TaxConflict | null;
  /** This line's own text says both included and extra. No basis can be used. */
  contradiction: TaxConflict | null;
};

/**
 * What a line's price is quoted on. Order of authority: the line's own conditions, then the document's tax basis,
 * then a blanket statement in the quote notes. A conflict is raised when a blanket statement (the document basis or
 * a note that speaks of all rates) is opposed by a line or note, and it affects every line that either opposes the
 * blanket statement or has no statement of its own.
 */
export function resolveTax(i: { doc_basis: 'excl_gst' | 'incl_gst' | 'unknown'; conditions: string[]; notes: string[] }): TaxResolution {
  const own = i.conditions.flatMap(taxStatements);
  const noteStmts = i.notes.flatMap(taxStatements);
  const none: TaxResolution = { basis: 'unknown', rate_pct: null, source: 'none', statement: null, conflict: null, contradiction: null };

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
      ? { basis: 'incl_gst', rate_pct: mine.rate_pct, source: 'line', statement: mine.text, conflict, contradiction: null }
      : { basis: 'excl_gst', rate_pct: null, source: 'line', statement: mine.text, conflict, contradiction: null };
  }
  if (conflict) return { ...none, conflict };
  if (i.doc_basis === 'incl_gst') return { basis: 'incl_gst', rate_pct: inclRate(undefined), source: 'document', statement: null, conflict: null, contradiction: null };
  if (i.doc_basis === 'excl_gst') return { basis: 'excl_gst', rate_pct: null, source: 'document', statement: null, conflict: null, contradiction: null };
  const only = blankets[0];
  if (only && blanketBases.size === 1) {
    return only.basis === 'incl'
      ? { basis: 'incl_gst', rate_pct: only.rate_pct ?? inclRate(undefined), source: 'notes', statement: only.text, conflict: null, contradiction: null }
      : { basis: 'excl_gst', rate_pct: null, source: 'notes', statement: only.text, conflict: null, contradiction: null };
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
  return `Conflicting tax statements: "${c.a}" and "${c.b}".`;
}
