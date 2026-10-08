// Reading a vendor's own terms next to a price: a price that depends on a condition (F3), a minimum order
// against the annual quantity (F3) and a board grade that differs from the RFx line (F4). Pure, no I/O.
// Nothing here changes a price. Each finding only decides whether a cell may be called Confirmed.
import type { BaseUom } from './types';

const CURRENCY_AMOUNT = /(?:rs\.?|inr|₹|re\.?)\s*(\d[\d,]*(?:\.\d+)?)/gi;
const QUANTITY_UNIT = '(mt|tonnes?|tons?|kgs?|pcs|nos|units|pieces|rolls|sets|pallets|plates|sq\\.?\\s?m)';

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ''));
}

/** A discount is a separate mechanism (conditional_discounts) and never makes a line price conditional. */
function isDiscount(c: string): boolean {
  return /\b(discount|rebate)\b/i.test(c);
}

const SLAB_OR_ALTERNATE = [
  /\botherwise\b/i,
  /\bor else\b/i,
  /\bbelow (that|this|the slab)\b/i,
  /\bslab\b/i,
  new RegExp(`\\d[\\d,.]*\\s*${QUANTITY_UNIT}\\b[^,;.]{0,25}\\b(and above|or more|and over|or above|and more|plus)\\b`, 'i'),
  /\b(if|when|provided)\b[^.;]{0,60}\b(taken together|together|single dispatch|single order|single po|per dispatch|per order|in one dispatch|full truck|truck ?load)\b/i,
  /\b(for|on)\s+(orders?|quantit(y|ies)|dispatch(es)?)\s+(of\s+)?(above|over|more than|at least)\b/i,
];

/** The alternate price a condition states, when it states one. "add Re 1" is read as the quoted price plus 1. */
export function alternatePrice(text: string, price: number | null): { value: number; label: string } | null {
  if (price == null) return null;
  const amounts: { value: number; add: boolean }[] = [];
  for (const m of text.matchAll(CURRENCY_AMOUNT)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0).toLowerCase();
    amounts.push({ value: toNumber(m[1] as string), add: /\badd\s*$/.test(before) || /\bplus\s*$/.test(before) });
  }
  const added = amounts.find((a) => a.add);
  if (added) return { value: Math.round((price + added.value) * 1e6) / 1e6, label: `${Math.round((price + added.value) * 1e6) / 1e6}, which is ${price} plus ${added.value}` };
  const other = amounts.find((a) => Math.abs(a.value - price) > 1e-9);
  return other ? { value: other.value, label: String(other.value) } : null;
}

export type MinimumOrder = { text: string; met: boolean | null; detail: string };
export type ConditionalPrice = { text: string; alternate: number | null; alternate_label: string | null };
export type TermsFinding = { conditional: ConditionalPrice | null; minimum: MinimumOrder | null };

/** Compares a stated minimum with the annual quantity. null when the unit cannot be compared, which is treated as unverified. */
function checkMinimum(c: string, price: number | null, annualQty: number | null, base: BaseUom): MinimumOrder | null {
  const m = /\b(?:minimum|min\.?|moq)\b(?:\s+order)?(?:\s+(?:quantity|qty|value))?(?:\s+of)?\s*:?\s*(.*)$/i.exec(c);
  if (!m) return null;
  const rest = m[1] ?? '';
  const money = /^(?:rs\.?|inr|₹)\s*(\d[\d,]*(?:\.\d+)?)/i.exec(rest);
  if (money) {
    const need = toNumber(money[1] as string);
    if (annualQty == null || price == null) return { text: c, met: null, detail: `Minimum order value Rs ${need}; the annual value cannot be worked out.` };
    const value = annualQty * price;
    return { text: c, met: value >= need, detail: `Minimum order value Rs ${need} against an annual value of about Rs ${Math.round(value)}.` };
  }
  const q = new RegExp(`^(\\d[\\d,]*(?:\\.\\d+)?)\\s*${QUANTITY_UNIT}?`, 'i').exec(rest);
  if (!q) return null;
  let need = toNumber(q[1] as string);
  const unit = (q[2] ?? '').toLowerCase();
  const heavy = /^(mt|tonnes?|tons?)$/.test(unit);
  const kg = /^kgs?$/.test(unit);
  if (heavy || kg) {
    if (base !== 'kg') return { text: c, met: null, detail: `Minimum ${q[1]} ${unit} cannot be compared with a quantity counted per ${base}.` };
    if (heavy) need *= 1000;
  } else if (unit === 'rolls' && base !== 'roll') {
    return { text: c, met: null, detail: `Minimum ${q[1]} rolls cannot be compared with a quantity counted per ${base}.` };
  } else if (base === 'kg' && unit !== '') {
    return { text: c, met: null, detail: `Minimum ${q[1]} ${unit} cannot be compared with a quantity counted per kg.` };
  }
  if (annualQty == null) return { text: c, met: null, detail: `Minimum order ${q[1]} ${unit}; the annual quantity is not known.`.replace(/ +/g, ' ') };
  const label = `${q[1]}${unit ? ` ${unit}` : ''}`;
  const plural = base === 'piece' ? 'pieces' : base;
  return {
    text: c,
    met: annualQty >= need,
    detail: annualQty >= need ? `Minimum order ${label} is met by the annual quantity of ${annualQty} ${plural}.` : `Minimum order ${label} is above the annual quantity of ${annualQty} ${plural}.`,
  };
}

/**
 * Reads a line's conditions. A discount is ignored here. A statement of an alternate price, a quantity slab or a
 * dispatch condition makes the price conditional. A bare minimum order is compared with the annual quantity.
 * "flat" and notes such as "subject to availability" are not conditions on the price.
 */
export function readTerms(conditions: string[], o: { price: number | null; annual_qty: number | null; base_uom: BaseUom }): TermsFinding {
  let conditional: ConditionalPrice | null = null;
  let minimum: MinimumOrder | null = null;
  for (const raw of conditions) {
    const c = raw.trim();
    if (!c || isDiscount(c)) continue;
    if (SLAB_OR_ALTERNATE.some((re) => re.test(c))) {
      const alt = alternatePrice(c, o.price);
      conditional ??= { text: c, alternate: alt?.value ?? null, alternate_label: alt?.label ?? null };
      continue;
    }
    const min = checkMinimum(c, o.price, o.annual_qty, o.base_uom);
    if (min) minimum ??= min;
  }
  return { conditional, minimum };
}

// ---- Board grade (F4) ----

const BF = /\bBF\s*[-:]?\s*(\d{2})\b/gi;
const SURCHARGE_WORDS = /\b(extra|surcharge|additional|add|premium|upgrade|charge|charged|higher)\b/i;
const BASE_WORDS = /\b(base|basis|standard|quoted|prices? (?:are |is )?(?:for|on|based)|all prices|rates? (?:are |is )?(?:for|on))\b/i;
const BOARD_ITEMS = /\b(cartons?|boxes|box|mailers?|rsc)\b/i;

export function boardGrades(text: string): number[] {
  return [...text.matchAll(BF)].map((m) => Number(m[1]));
}

/** "BF 18 (3 ply) and BF 20 (5 ply)" or "3 ply BF 18, 5 ply BF 20" gives {3: 18, 5: 20}. */
function gradesByPly(text: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const m of text.matchAll(/\bBF\s*[-:]?\s*(\d{2})\s*\(\s*(\d)\s*[- ]?ply\s*\)/gi)) out[Number(m[2])] = Number(m[1]);
  for (const m of text.matchAll(/\b(\d)\s*[- ]?ply\s*[:(\-]?\s*\(?\s*BF\s*[-:]?\s*(\d{2})\b/gi)) out[Number(m[1])] ??= Number(m[2]);
  return out;
}

export type VendorGrade = { grade: number; by_ply: Record<number, number>; boards_only: boolean; note: string; surcharge: string | null };

/** The base board grade a vendor says its prices are for, with the vendor's own surcharge text when it gives one. */
export function vendorBaseGrade(notes: string[]): VendorGrade | null {
  const withGrade = notes.filter((n) => boardGrades(n).length > 0);
  for (const n of withGrade) {
    const grades = boardGrades(n);
    const isBase = BASE_WORDS.test(n) || (grades.length === 1 && !SURCHARGE_WORDS.test(n));
    if (!isBase) continue;
    const surcharge = SURCHARGE_WORDS.test(n) && grades.length > 1 && Object.keys(gradesByPly(n)).length === 0 ? n : withGrade.find((o) => o !== n && SURCHARGE_WORDS.test(o)) ?? null;
    return { grade: grades[0] as number, by_ply: gradesByPly(n), boards_only: BOARD_ITEMS.test(n) && !/\b(sheets?|rolls?)\b/i.test(n), note: n, surcharge };
  }
  return null;
}

export type GradeMismatch = { vendor_grade: number; rfx_grade: number; text: string };

/**
 * A vendor whose prices are for another board grade than the RFx line. The grade comes from the vendor's quote
 * level notes (per ply when the note says so, and only for cartons when the note speaks of cartons), or from this
 * line's own conditions ("Price is for BF 20"). The vendor's surcharge text is carried as written; no adjusted
 * price is ever computed.
 */
export function gradeMismatch(rfxDescription: string, vendorNotes: string[], lineConditions: string[]): GradeMismatch | null {
  const rfx = boardGrades(rfxDescription)[0];
  if (rfx == null) return null;
  const own = vendorBaseGrade(lineConditions.filter((c) => /\b(quoted|base|basis)\b|\bprices? (?:is |are )?for\b|\brates? (?:is |are )?for\b/i.test(c)));
  const quote = vendorBaseGrade(vendorNotes);
  let grade: number | null = own?.grade ?? null;
  if (grade == null && quote) {
    const ply = Number(/\b(\d)\s*[- ]?ply\b/i.exec(rfxDescription)?.[1] ?? NaN);
    const inScope = !quote.boards_only || BOARD_ITEMS.test(rfxDescription);
    if (inScope) grade = quote.by_ply[ply] ?? (Object.keys(quote.by_ply).length === 0 ? quote.grade : null);
  }
  if (grade == null || grade === rfx) return null;
  const base = own ?? quote;
  const text = lineConditions.find((c) => SURCHARGE_WORDS.test(c) && boardGrades(c).length > 0) ?? base?.surcharge ?? quote?.surcharge ?? base?.note ?? '';
  return { vendor_grade: grade, rfx_grade: rfx, text };
}

// ---- Validity (F4) ----

const VALIDITY_UNITS: Record<string, number> = {
  day: 1, days: 1, din: 1, dino: 1, divas: 1, dias: 1, jour: 1, jours: 1, tage: 1, tagen: 1,
  week: 7, weeks: 7, hafte: 7, haftey: 7, hafta: 7, semana: 7, semanas: 7, semaine: 7, semaines: 7, woche: 7, wochen: 7,
  month: 30, months: 30, mahine: 30, mahina: 30, mahinay: 30, meses: 30, mois: 30, monat: 30, monate: 30,
  year: 365, years: 365, saal: 365, varsh: 365, anos: 365, jahr: 365, jahre: 365,
};

/**
 * Days in a validity statement: "30 days", "valid for 2 weeks", "3 months", and the same in a few other languages
 * the vendor may write in ("10 din", "2 hafte", "15 dias"). A number followed by a word that is not a time unit gives
 * null; nothing is guessed. Lenient on purpose about the wording around the number, strict about the unit.
 */
export function validityDays(text: string | null | undefined): number | null {
  if (!text) return null;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-zA-Z\u00c0-\u00ff]+)/g)) {
    const mult = VALIDITY_UNITS[(m[2] as string).toLowerCase()];
    if (mult) return Math.round(Number(m[1]) * mult);
  }
  return null;
}

/** The warning when a vendor's validity is shorter than the RFx asks for. null when it is long enough or unreadable. */
export function shortValidityWarning(validityText: string | null | undefined, rfxDays: number | null | undefined): string | null {
  const days = validityDays(validityText);
  if (days == null || !rfxDays || days >= rfxDays) return null;
  return `Offer valid for ${days} days, shorter than the ${rfxDays} days the RFx asks for.`;
}
