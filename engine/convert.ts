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
  | { kind: 'pack'; term: string } // box, bundle, carton, pack: needs a definition
  | { kind: 'unknown'; text: string };

const COUNT_WORDS = ['piece', 'pieces', 'pc', 'pcs', 'nos', 'no', 'no.', 'each', 'unit', 'units', 'ea', 'set', 'sets', 'plate', 'plates', 'pallet', 'pallets'];
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

/** Reads unit text such as "per MT", "Sq.Mtr", "per 100", "per box*", "/kg", "each". */
export function parseUnit(raw: string | null | undefined, perN = 1): ParsedUnit {
  if (!raw || !raw.trim()) return { kind: 'unknown', text: raw ?? '' };
  let t = clean(raw);
  let n = perN > 0 ? perN : 1;
  // "per 100", "per 1000 pcs", "100 nos"
  const lead = t.match(/^(\d[\d,]*)\s*(.*)$/);
  if (lead && lead[1]) {
    const k = Number(lead[1].replace(/,/g, ''));
    if (k > 0) {
      n = n * k;
      t = (lead[2] ?? '').trim();
    }
  }
  if (t === '') return { kind: 'count', n };
  if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(t)) return { kind: 'kg', n };
  if (/^(mt|t|ton|tons|tonne|tonnes|metric ton|metric tonne)$/.test(t)) return { kind: 'tonne', n };
  if (/^(sq\.?\s?m|sqm|sq\.?\s?mtr|sq\.?\s?mt|sq\.?\s?meter|sq\.?\s?metre|square met(er|re)|m2)$/.test(t)) return { kind: 'sq m', n };
  if (/^(roll|rolls|rl)$/.test(t)) return { kind: 'roll', n };
  if (COUNT_WORDS.includes(t)) return { kind: 'count', n };
  if (PACK_WORDS.includes(t)) return { kind: 'pack', term: t };
  return { kind: 'unknown', text: raw };
}

const COUNT_BASES: BaseUom[] = ['piece', 'set', 'plate', 'pallet'];

function packFits(defUnit: ParsedUnit, base: BaseUom): boolean {
  return (defUnit.kind === 'count' && COUNT_BASES.includes(base)) || (defUnit.kind === 'roll' && base === 'roll') || (defUnit.kind === 'kg' && base === 'kg');
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
};

export type NormalizeResult =
  | {
      ok: true;
      value_inr: number;
      steps: ConversionStep[];
      assumption_keys: string[];
      pack_size?: number;
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
  const divide = (n: number, reason: string, key?: string) => {
    if (n !== 1) {
      v = v / n;
      steps.push({ op: 'divide', factor: n, reason, ...(key ? { assumption_key: key } : {}) });
    }
  };

  switch (unit.kind) {
    case 'unknown':
      return { ok: false, reason: 'unit_unknown', detail: `Cannot read the unit "${unit.text}".` };
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
      divide(def.means_quantity, `Vendor's own definition: 1 ${unit.term} = ${def.means_quantity} ${def.means_unit ?? 'units'}`, 'pack_size');
      keys.push('pack_size');
      notes.push(`Pack size taken from the vendor's note${def.quote ? `: "${def.quote}"` : ''}.`);
      return { ok: true, value_inr: v, steps, assumption_keys: keys, pack_size: def.means_quantity, notes };
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
