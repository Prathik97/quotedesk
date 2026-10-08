// Deterministic price normalization: INR per RFx base unit, excluding GST.
// Every factor applied is recorded as a step. Nothing is guessed: a unit we
// cannot map yields an error, never a number.
import type { Assumptions, BaseUom, ConversionStep, UnitDefinition } from './types';

export type ParsedUnit =
  | { kind: 'count'; n: number } // pieces, sets, plates, pallets, "each"
  | { kind: 'kg'; n: number }
  | { kind: 'tonne'; n: number }
  | { kind: 'sq m'; n: number }
  | { kind: 'roll'; n: number }
  | { kind: 'metre'; n: number } // a length: needs the RFx piece length to map to a piece
  | { kind: 'pack'; term: string; n: number } // box, bundle, carton, pack: needs a definition
  | { kind: 'unknown'; text: string; why?: string };

const COUNT_WORDS = ['piece', 'pieces', 'pc', 'pcs', 'nos', 'no', 'no.', 'each', 'unit', 'units', 'ea', 'nos.', 'pc.', 'pcs.', 'set', 'sets', 'plate', 'plates', 'pallet', 'pallets'];
const PACK_WORDS = ['box', 'boxes', 'bundle', 'bundles', 'pack', 'packs', 'packet', 'packets', 'bale', 'bales', 'case', 'cases', 'carton', 'cartons', 'ctn'];

const MARKER = /[*†‡#]+/;

/** Footnote marker attached to a unit, such as "*" or "**". Distinguishes "box*" from "box**". */
export function unitMarker(text: string | null | undefined): string {
  return text?.match(MARKER)?.[0] ?? '';
}

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // qualifiers such as "pcs (cartons, trays)"
    .replace(/[*†‡#]/g, '')
    .replace(/\brs\.?\b|\binr\b|\busd\b|₹|\$/g, ' ')
    .replace(/\bper\b|\/|\beach\s+of\b/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COUNT_PHRASES: Record<string, number> = { hundred: 100, thousand: 1000, dozen: 12 };

/**
 * Reads unit text such as "per MT", "Sq.Mtr", "per 100", "per box*", "/kg", "each", "a roll", "per mtr".
 *
 * The count a price is quoted for ("per 100") can be written in the unit text, in per_n, or in both. It is
 * derived exactly once: text and per_n that agree are one statement, a count in only one place is used as
 * given, and two different counts are not guessed between.
 */
export function parseUnit(raw: string | null | undefined, perN = 1): ParsedUnit {
  if (!raw || !raw.trim()) return { kind: 'unknown', text: raw ?? '' };
  let t = clean(raw).replace(/^(a|an|one|1)\s+(?=[a-z])/, '');
  const stated = perN > 0 ? perN : 1;
  let textN: number | null = null;
  // "per 100", "per 1000 pcs", "100 nos", "per hundred", "per thousand pcs"
  const lead = t.match(/^(\d[\d,]*(?:\.\d+)?)\s*(.*)$/);
  if (lead && lead[1]) {
    const k = Number(lead[1].replace(/,/g, ''));
    if (k > 0) {
      textN = k;
      t = (lead[2] ?? '').trim();
    }
  } else {
    const word = t.match(/^(hundred|thousand|dozen)\b\s*(.*)$/);
    if (word && word[1]) {
      textN = COUNT_PHRASES[word[1]] ?? null;
      t = (word[2] ?? '').trim();
    }
  }
  if (textN != null && stated !== 1 && textN !== stated) {
    return { kind: 'unknown', text: raw, why: `The unit text says per ${textN} but the quoted count is ${stated}, so the pack divisor is ambiguous.` };
  }
  const n = textN ?? stated;
  if (t === '') return { kind: 'count', n };
  if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(t)) return { kind: 'kg', n };
  if (/^(mt|t|ton|tons|tonne|tonnes|metric ton|metric tonne)$/.test(t)) return { kind: 'tonne', n };
  if (/^(sq\.?\s?m|sqm|sq\.?\s?mtr|sq\.?\s?mt|sq\.?\s?meter|sq\.?\s?metre|square met(er|re)|m2)$/.test(t)) return { kind: 'sq m', n };
  if (/^(roll|rolls|rl)$/.test(t)) return { kind: 'roll', n };
  if (/^(m|mtr|mtrs|meter|meters|metre|metres|running m|running mtr|running meter|running metre|rm|rmt)$/.test(t)) return { kind: 'metre', n };
  if (COUNT_WORDS.includes(t)) return { kind: 'count', n };
  if (PACK_WORDS.includes(t)) return { kind: 'pack', term: t, n };
  return { kind: 'unknown', text: raw };
}

const COUNT_BASES: BaseUom[] = ['piece', 'set', 'plate', 'pallet'];

function packFits(defUnit: ParsedUnit, base: BaseUom): boolean {
  return (
    (defUnit.kind === 'count' && COUNT_BASES.includes(base)) ||
    (defUnit.kind === 'roll' && base === 'roll') ||
    (defUnit.kind === 'kg' && base === 'kg') ||
    (defUnit.kind === 'sq m' && base === 'sq m')
  );
}

/**
 * Picks the vendor's definition for a pack unit. A footnote marker on the price
 * ("per box**") must match the marker on the definition. Without a marker, an
 * unmarked definition wins; otherwise exactly one definition must fit the base
 * unit. Anything else is ambiguous and is not guessed.
 */
export function choosePackDefinition(term: string, marker: string, defs: UnitDefinition[], base: BaseUom): UnitDefinition | { error: string } {
  const named = defs.filter((d) => packMatches(term, d) && d.means_quantity != null && d.means_quantity > 0);
  if (named.length === 0) return { error: `Quoted per ${term} and the vendor does not say how many units a ${term} holds.` };
  let pool = named;
  if (marker) {
    const marked = named.filter((d) => unitMarker(d.term) === marker || unitMarker(d.quote) === marker);
    if (marked.length) pool = marked;
  } else {
    const unmarked = named.filter((d) => !unitMarker(d.term));
    if (unmarked.length) pool = unmarked;
  }
  if (pool.length === 1) return pool[0] as UnitDefinition;
  const fitting = pool.filter((d) => packFits(parseUnit(d.means_unit ?? 'piece'), base));
  const sizes = new Set(fitting.map((d) => d.means_quantity));
  if (fitting.length >= 1 && sizes.size === 1) return fitting[0] as UnitDefinition;
  return { error: `The vendor defines a ${term} more than one way (${pool.map((d) => `${d.term} = ${d.means_quantity} ${d.means_unit}`).join('; ')}) and the price does not say which applies.` };
}

function packMatches(term: string, def: UnitDefinition): boolean {
  const d = clean(def.term);
  const singular = (s: string) => s.replace(/(es|s)$/, '');
  return d === term || singular(d) === singular(term) || d.includes(singular(term));
}

export type NormalizeInput = {
  price: number | null;
  currency: string | null; // INR, USD, other
  uom_text: string | null;
  per_n?: number | null;
  tax_basis: 'excl_gst' | 'incl_gst' | 'unknown';
  inherits_last_year?: boolean;
  base_uom: BaseUom;
  last_year_rate_inr: number | null;
  unit_definitions?: UnitDefinition[];
  /**
   * The buyer's own statement of what one quoted unit holds ("1 bundle = 50 pieces").
   * It wins over any vendor definition and over an unreadable unit, and it is the
   * buyer's decision, not a system assumption.
   */
  pack_override?: { quantity: number; unit: string } | null;
  /** Length of one RFx piece in mm when the RFx spec states it (see specLengthMm). Lets "per mtr" map to a piece. */
  spec_length_mm?: number | null;
};

const LEN_TO_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, mtr: 1000, mtrs: 1000, metre: 1000, meter: 1000, metres: 1000, meters: 1000 };
const LEN_UNIT = '(mm|cm|mtrs?|metres?|meters?|m)';

/**
 * The length of one piece when the RFx text states it outright ("1000 mm length", "length 1.2 m", "2 m long").
 * Dimensions such as "50x50x4 mm" are not a length statement and give null: which side runs along the piece is not guessed.
 */
export function specLengthMm(...texts: (string | null | undefined)[]): number | null {
  const t = texts.filter(Boolean).join(' ; ').toLowerCase();
  const num = '(\\d+(?:\\.\\d+)?)';
  const a = new RegExp(`${num}\\s*${LEN_UNIT}\\s*(?:length|long)\\b`).exec(t);
  const b = new RegExp(`\\blength\\s*(?:of\\s*|:\\s*)?${num}\\s*${LEN_UNIT}\\b`).exec(t);
  const m = a ?? b;
  if (!m) return null;
  const v = Number(m[1]) * (LEN_TO_MM[m[2] as string] ?? 0);
  return v > 0 ? v : null;
}

export type NormalizeResult =
  | {
      ok: true;
      value_inr: number;
      steps: ConversionStep[];
      assumption_keys: string[];
      pack_size?: number;
      pack_source?: 'vendor' | 'buyer';
      notes: string[];
    }
  | { ok: false; reason: 'no_price' | 'unit_unknown' | 'unit_incompatible' | 'pack_size_unknown' | 'currency_unknown' | 'no_last_year_rate'; detail: string };

/** Pure: same input, same output. Full precision; rounding is for display only. */
export function normalizePrice(input: NormalizeInput, a: Assumptions): NormalizeResult {
  const steps: ConversionStep[] = [];
  const keys: string[] = [];
  const notes: string[] = [];

  if (input.inherits_last_year) {
    if (input.last_year_rate_inr == null) {
      return { ok: false, reason: 'no_last_year_rate', detail: 'Vendor said "same as last year" but no last year rate exists for this line.' };
    }
    return {
      ok: true,
      value_inr: input.last_year_rate_inr,
      steps: [],
      assumption_keys: ['last_year_inheritance'],
      notes: ['Resolved from the last year contract rate file.'],
    };
  }

  if (input.price == null || !Number.isFinite(input.price)) {
    return { ok: false, reason: 'no_price', detail: 'No readable price.' };
  }
  let v = input.price;

  // Currency
  const cur = (input.currency ?? 'INR').toUpperCase();
  if (cur === 'USD') {
    v = v * a.usd_inr;
    steps.push({ op: 'multiply', factor: a.usd_inr, reason: `USD to INR at the assumed rate ${a.usd_inr}`, assumption_key: 'usd_inr' });
    keys.push('usd_inr');
  } else if (cur !== 'INR') {
    return { ok: false, reason: 'currency_unknown', detail: `Currency ${cur} has no conversion rule.` };
  }

  // Tax basis
  if (input.tax_basis === 'incl_gst') {
    const f = 1 + a.gst_pct / 100;
    v = v / f;
    steps.push({ op: 'divide', factor: f, reason: `Remove GST at the assumed ${a.gst_pct} percent`, assumption_key: 'gst_pct' });
    keys.push('gst_pct');
  }

  // Unit
  const unit = parseUnit(input.uom_text, input.per_n ?? 1);
  const base = input.base_uom;
  const po = input.pack_override;
  const divide = (n: number, reason: string, key?: string) => {
    if (n !== 1) {
      v = v / n;
      steps.push({ op: 'divide', factor: n, reason, ...(key ? { assumption_key: key } : {}) });
    }
  };

  if (po && (unit.kind === 'pack' || unit.kind === 'unknown')) {
    const defUnit = parseUnit(po.unit);
    if (!(po.quantity > 0) || !packFits(defUnit, base)) {
      return { ok: false, reason: 'unit_incompatible', detail: `The unit meaning set by the buyer (${po.quantity} ${po.unit}) does not match per ${base}.` };
    }
    const label = (input.uom_text ?? 'unit').replace(/^\s*per\s+/i, '').trim() || 'unit';
    divide(po.quantity, `Buyer's unit meaning: 1 ${label} = ${po.quantity} ${po.unit}`, undefined);
    notes.push(`Unit meaning set by the buyer: 1 ${label} = ${po.quantity} ${po.unit}.`);
    return { ok: true, value_inr: v, steps, assumption_keys: keys, pack_size: po.quantity, pack_source: 'buyer', notes };
  }

  switch (unit.kind) {
    case 'unknown':
      return { ok: false, reason: 'unit_unknown', detail: unit.why ?? `Cannot read the unit "${unit.text}".` };
    case 'metre': {
      if (base !== 'piece') return { ok: false, reason: 'unit_incompatible', detail: `Quoted per metre but the RFx line is per ${base}.` };
      const len = input.spec_length_mm;
      if (!len || len <= 0) return { ok: false, reason: 'unit_unknown', detail: `Quoted per metre and the RFx spec does not state the length of one ${base}.` };
      const per = unit.n === 1 ? '1 m' : `${unit.n} m`;
      const factor = len / 1000 / unit.n;
      v = v * factor;
      steps.push({ op: 'multiply', factor, reason: `${per} equals 1 piece of ${len} mm (from the RFx spec)`, assumption_key: 'unit_length' });
      keys.push('unit_length');
      notes.push(`1 m equals 1 piece of ${len} mm (from the RFx spec).`);
      break;
    }
    case 'count':
      if (!COUNT_BASES.includes(base)) {
        return { ok: false, reason: 'unit_incompatible', detail: `Quoted per piece but the RFx line is per ${base}.` };
      }
      divide(unit.n, `Quoted per ${unit.n}, converted to per ${base}`);
      break;
    case 'kg':
      if (base !== 'kg') return { ok: false, reason: 'unit_incompatible', detail: `Quoted per kg but the RFx line is per ${base}.` };
      divide(unit.n, `Quoted per ${unit.n} kg, converted to per kg`);
      break;
    case 'tonne':
      if (base !== 'kg') return { ok: false, reason: 'unit_incompatible', detail: `Quoted per tonne but the RFx line is per ${base}.` };
      divide(1000 * unit.n, `1 tonne = 1000 kg${unit.n !== 1 ? `, quoted per ${unit.n} tonnes` : ''}`);
      break;
    case 'sq m':
      if (base !== 'sq m') return { ok: false, reason: 'unit_incompatible', detail: `Quoted per sq m but the RFx line is per ${base}.` };
      divide(unit.n, `Quoted per ${unit.n} sq m, converted to per sq m`);
      break;
    case 'roll':
      if (base !== 'roll') return { ok: false, reason: 'unit_incompatible', detail: `Quoted per roll but the RFx line is per ${base}.` };
      divide(unit.n, `Quoted per ${unit.n} rolls, converted to per roll`);
      break;
    case 'pack': {
      const def = choosePackDefinition(unit.term, unitMarker(input.uom_text), input.unit_definitions ?? [], base);
      if ('error' in def) return { ok: false, reason: 'pack_size_unknown', detail: def.error };
      const defUnit = parseUnit(def.means_unit ?? 'piece');
      const compatible = packFits(defUnit, base);
      if (!compatible || !def.means_quantity) {
        return { ok: false, reason: 'unit_incompatible', detail: `A ${unit.term} holds ${def.means_quantity} ${def.means_unit}, which does not match per ${base}.` };
      }
      divide(def.means_quantity * unit.n, `Vendor's own definition: 1 ${unit.term} = ${def.means_quantity} ${def.means_unit ?? 'units'}${unit.n !== 1 ? `, quoted per ${unit.n} ${unit.term}` : ''}`, 'pack_size');
      keys.push('pack_size');
      notes.push(`Pack size taken from the vendor's note${def.quote ? `: "${def.quote}"` : ''}.`);
      return { ok: true, value_inr: v, steps, assumption_keys: keys, pack_size: def.means_quantity, pack_source: 'vendor', notes };
    }
  }
  return { ok: true, value_inr: v, steps, assumption_keys: keys, notes };
}

/** Landed cost for a vendor total. Unknown freight makes the total incomplete, never zero. */
export function landedTotal(
  goodsTotalInr: number,
  freight: { terms: 'included' | 'extra' | 'unknown'; amount_inr: number | null },
): { total_inr: number; complete: boolean; reason: string } {
  if (freight.terms === 'included') return { total_inr: goodsTotalInr, complete: true, reason: 'Freight included in rates.' };
  if (freight.terms === 'extra' && freight.amount_inr != null) {
    return { total_inr: goodsTotalInr + freight.amount_inr, complete: true, reason: 'Freight added at the stated amount.' };
  }
  return {
    total_inr: goodsTotalInr,
    complete: false,
    reason: freight.terms === 'extra' ? 'Freight extra with no amount stated. Landed total is incomplete.' : 'Freight terms not stated. Landed total is incomplete.',
  };
}
