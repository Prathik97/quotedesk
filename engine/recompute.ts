// Recompute one stored quote line from its raw extracted fields, the current
// assumptions and the buyer's overrides. Pure: no I/O. This is the only place a
// line's normalized price, flags and status are derived, for the extraction
// pipeline and for every later change (FX, GST, corrections), so the two can
// never disagree.
import { normalizePrice, readPackDefinitions, specLengthMm } from './convert';
import type { SizeCheck } from './dimensions';
import { clipQuote, conflictText, readingsText, resolveTax, type DocTaxStatement, type ModelTax, type TaxResolution } from './tax';
import { gradeMismatch, readTerms } from './terms';
import type { Assumptions, BaseUom, ConversionStep, LineStatus, ReadConfidence, SourceType, UnitDefinition } from './types';
import { assignStatus, lineFlags } from './verify';

/** Changes the buyer made to one line. The extracted fields are never overwritten. */
export type LineOverrides = {
  /** The buyer checked the value against the source. */
  verified?: boolean;
  price?: number;
  currency?: string;
  uom_text?: string;
  per_n?: number;
  /** "1 quoted unit = quantity unit", where unit is the RFx base unit. */
  pack?: { quantity: number; unit: string };
  not_quoted?: boolean;
};

export type StoredLine = {
  price: number | null;
  currency: string | null;
  uom_text: string | null;
  per_n: number;
  tax_basis: 'excl_gst' | 'incl_gst' | 'unknown';
  inherits_last_year: boolean;
  base_uom: BaseUom;
  last_year_rate_inr: number | null;
  unit_definitions: UnitDefinition[];
  read_confidence: ReadConfidence;
  match_confidence: number;
  source_type: SourceType;
  evidence_quote: string | null;
  evidence_locator: string | null;
  /** Flags decided at extraction that code cannot re-derive. */
  sticky_flags: string[];
  overrides: LineOverrides;
  /** The vendor's own conditions on this line, as extracted. Read for conditional prices and minimum orders. */
  conditions?: string[];
  /** Annual quantity of the RFx line, in its base unit. Used to test a vendor minimum order. */
  annual_qty?: number | null;
  /** RFx description and spec text. Read for a stated piece length and a board grade. */
  rfx_text?: string;
  /** The vendor's quote level notes (global notes). Read for the base board grade the prices are for. */
  vendor_notes?: string[];
  /** Decided once at extraction, where every RFx line is at hand, and carried with the line. Absent on lines read before the check existed. */
  size_check?: SizeCheck | null;
  /** Set at extraction when another line of the same document is matched to the same RFx line. The text names that line. */
  duplicate_rfx_match?: string | null;
  /** The vendor's description, evidence quote, the RFx description and the section, joined. Which document tax statements could apply to the line is judged on it. */
  scope_text?: string;
  /** The model's tax resolution for this line and the document statements it reported, verified once at extraction. Absent on lines read before they existed. */
  model_tax?: ModelTax | null;
  doc_tax_statements?: DocTaxStatement[];
};

export type LineResult = {
  normalized_inr: number | null;
  steps: ConversionStep[];
  notes: string[];
  pack_size: number | null;
  pack_source: 'vendor' | 'buyer' | null;
  error: { reason: string; detail: string } | null;
  /** Every assumption the value depends on, whether or not the buyer accepted it. */
  assumption_keys: string[];
  /** Interpretation assumptions the buyer accepted by verifying the cell. */
  accepted_keys: string[];
  flags: string[];
  status: LineStatus;
  reasons: string[];
  confidence: number;
  buyer_verified: boolean;
  /** What the price is quoted on and why. null for a line that inherits last year's rate. */
  tax: TaxResolution | null;
};

/** Statements about how to read a document. A buyer who has seen the source can accept these. */
export const INTERPRETATION_KEYS = ['pack_size', 'tax_basis_assumed_excl', 'last_year_inheritance', 'unit_length', 'tax_basis_model'];
/** Numbers the vendor never gave. A buyer cannot verify these by looking at the source. */
export const EXTERNAL_KEYS = ['usd_inr', 'gst_pct'];

export const READ_SCORE: Record<ReadConfidence, number> = { high: 0.95, medium: 0.7, low: 0.4 };
export const STICKY_FLAGS = ['from_hidden_sheet', 'unmatched', 'unknown_rfx_code'];
const UNIT_PROBLEMS = ['unit_unknown', 'unit_incompatible', 'pack_size_unknown'];

function unitProblemText(price: number | null, uomText: string | null, base: BaseUom, detail: string): string {
  const unit = (uomText ?? '').trim();
  const per = !unit ? 'unit not stated' : /^(per|\/)/i.test(unit) || /^an?\s/i.test(unit) ? unit : `per ${unit}`;
  const head = price != null ? `Price read (${price.toFixed(2)} ${per}). ` : '';
  const extra = detail && !detail.startsWith('Cannot read the unit') ? ` ${detail}` : '';
  return `${head}The unit could not be mapped to ${base}.${extra}`;
}

/** The plain message for a line whose tax basis cannot be settled. The two readings are text only, never a value. */
function notDerivedText(tax: TaxResolution, price: number | null, currency: string | null): string {
  const g = tax.guard;
  if (!g) return '';
  const said = g.statements.map((t) => `"${clipQuote(t)}"`).join(' and ');
  const why = g.why === 'conflict' ? `The vendor's tax statements conflict: ${said}.` : `The vendor made a tax statement that may apply to this line: ${said}.`;
  const shown = price != null ? ` The price is shown as the vendor wrote it (${price} ${currency ?? 'INR'}).` : '';
  const both = price != null && g.rate_pct != null && (currency ?? 'INR').toUpperCase() === 'INR' ? ` As text only, not a value: ${readingsText(price, g.rate_pct)}.` : '';
  return `Not derived: whether GST is included in this price cannot be settled from the document, so no price excluding GST is shown. ${why}${shown}${both} Check the source.`;
}

export function recomputeLine(l: StoredLine, a: Assumptions): LineResult {
  const o = l.overrides;
  const verified = o.verified === true;
  const edited = o.price != null || o.currency != null || o.uom_text != null || o.per_n != null;
  const price = o.price ?? l.price;
  const inherits = l.inherits_last_year && !edited;

  const tax = inherits
    ? null
    : resolveTax({ doc_basis: l.tax_basis, conditions: l.conditions ?? [], notes: l.vendor_notes ?? [], scope_text: l.scope_text, model_tax: l.model_tax, doc_statements: l.doc_tax_statements });
  const notDerived = tax?.guard ? notDerivedText(tax, price, l.currency) : null;
  const n = tax?.contradiction
    ? ({ ok: false, reason: 'tax_unresolved', detail: `This line says both included and extra: "${tax.contradiction.a}" and "${tax.contradiction.b}".` } as const)
    : notDerived
    ? ({ ok: false, reason: 'tax_unresolved', detail: notDerived } as const)
    : normalizePrice(
    {
      price,
      currency: o.currency ?? l.currency,
      uom_text: o.uom_text ?? l.uom_text,
      per_n: o.per_n ?? l.per_n,
      tax_basis: tax?.basis ?? l.tax_basis,
      gst_rate_pct: tax?.rate_pct ?? null,
      inherits_last_year: inherits,
      base_uom: l.base_uom,
      last_year_rate_inr: l.last_year_rate_inr,
      // A pack definition in the same line as the price, or in the vendor's notes, holds even when the model did not return it.
      unit_definitions: [...l.unit_definitions, ...readPackDefinitions([l.evidence_quote ?? '', ...(l.conditions ?? []), ...(l.vendor_notes ?? [])])],
      pack_override: o.pack ?? null,
      spec_length_mm: specLengthMm(l.rfx_text),
    },
    a,
  );

  const flags: string[] = l.sticky_flags.filter((f) => STICKY_FLAGS.includes(f));
  let normalized: number | null = null;
  const keys: string[] = [];
  let steps: ConversionStep[] = [];
  let notes: string[] = [];
  let packSize: number | null = null;
  let packSource: 'vendor' | 'buyer' | null = null;
  let error: LineResult['error'] = null;
  let unitKnown = true;

  if (n.ok) {
    normalized = n.value_inr;
    keys.push(...n.assumption_keys);
    steps = n.steps;
    notes = n.notes;
    packSize = n.pack_size ?? null;
    packSource = n.pack_source ?? null;
    // Unchanged on purpose: a line that only says "GST extra" while the document basis is unknown stays Assumed, as before.
    // Reading a stated "extra" as settled would lift lines to Confirmed that carry other unverified conditions.
    if (tax?.source === 'model') keys.push('tax_basis_model');
    if (tax && (tax.basis === 'unknown' || (tax.basis === 'excl_gst' && l.tax_basis === 'unknown'))) keys.push('tax_basis_assumed_excl');
  } else {
    unitKnown = !UNIT_PROBLEMS.includes(n.reason);
    flags.push(n.reason);
    error = { reason: n.reason, detail: n.detail };
  }
  if (edited) flags.push('buyer_edited');
  const flagText: Record<string, string> = {};
  if (tax?.contradiction) flagText.tax_unresolved = `${error?.detail ?? ''} The price is not converted, because an inclusive price must never be shown as an excluding GST price. Check the source.`.trim();
  else if (notDerived) flagText.tax_unresolved = notDerived;
  if (tax?.conflict) {
    // The price is still read on this line's own statement and shown without GST; it just cannot be Confirmed.
    const by = tax.source === 'model' ? ` (the model resolved it from the vendor's words: "${tax.statement}")` : '';
    const how = tax.basis === 'incl_gst' ? ` This line says GST is included${tax.rate_pct != null ? ` at ${tax.rate_pct} percent` : ''}${by}, so the price is shown without GST.` : tax.basis === 'excl_gst' ? (by ? ` This line says GST is extra${by}.` : '') : notDerived ? ' This line has no tax statement of its own, so no excluding GST price is derived.' : '';
    flags.push('tax_conflict');
    keys.push('tax_basis_conflict');
    flagText.tax_conflict = `${conflictText(tax.conflict)}${how}`;
  }
  if (!inherits && l.size_check?.kind === 'mismatch') {
    flags.push('dimension_mismatch');
    flagText.dimension_mismatch = l.size_check.message;
  }
  if (!inherits && l.duplicate_rfx_match) {
    flags.push('duplicate_rfx_match');
    flagText.duplicate_rfx_match = l.duplicate_rfx_match;
  }
  if (l.size_check?.kind === 'match') notes = [...notes, l.size_check.note];

  // The vendor's own terms next to the price. These decide whether the cell may be Confirmed; none changes a price.
  if (!inherits && price != null) {
    const found = readTerms(l.conditions ?? [], { price, annual_qty: l.annual_qty ?? null, base_uom: l.base_uom });
    if (found.conditional) {
      const alt = found.conditional.alternate != null ? ` Alternate price stated: Rs ${found.conditional.alternate_label ?? found.conditional.alternate}.` : '';
      flags.push('conditional_price');
      flagText.conditional_price = `The price depends on a condition that has not been verified: "${found.conditional.text}".${alt}`;
    }
    if (found.minimum) {
      if (found.minimum.met === true) notes = [...notes, found.minimum.detail];
      else if (found.minimum.met === false) {
        flags.push('minimum_above_annual');
        flagText.minimum_above_annual = `${found.minimum.detail} The vendor's price may not apply.`;
      } else {
        flags.push('conditional_price');
        flagText.conditional_price = `The price depends on a minimum order that could not be checked: "${found.minimum.text}". ${found.minimum.detail}`;
        notes = [...notes, flagText.conditional_price];
      }
    }
    const grade = gradeMismatch(l.rfx_text ?? '', l.vendor_notes ?? [], l.conditions ?? []);
    if (grade) {
      flags.push('board_grade_mismatch');
      flagText.board_grade_mismatch = `The vendor's prices are for BF ${grade.vendor_grade}; this RFx line needs BF ${grade.rfx_grade}. Vendor's own text: "${grade.text}". No adjusted price is computed.`;
    }
  }
  const unitDetail = unitKnown ? null : unitProblemText(price, o.uom_text ?? l.uom_text, l.base_uom, error?.detail ?? '');

  flags.push(
    ...lineFlags({
      // An edited value has no quote to be found in, and the buyer has seen it.
      price_as_written: edited ? null : l.price,
      normalized_inr: normalized,
      last_year_rate_inr: l.last_year_rate_inr,
      evidence: { quote: l.evidence_quote, locator: l.evidence_locator ?? '' },
      inherits_last_year: inherits,
    }),
  );

  const applied = [...new Set(keys)];
  // A unit meaning the buyer set is a decision, not an assumption.
  const buyerPack = packSource === 'buyer';
  const countable = applied.filter((k) => !(k === 'pack_size' && buyerPack));
  const statusKeys = verified ? countable.filter((k) => !INTERPRETATION_KEYS.includes(k)) : countable;
  const accepted = verified ? countable.filter((k) => INTERPRETATION_KEYS.includes(k)) : [];

  const decision = assignStatus({
    source_type: l.source_type,
    read_confidence: l.read_confidence,
    match_confidence: l.match_confidence,
    flags,
    unit_known: unitKnown,
    assumption_keys: statusKeys,
    has_price: normalized != null,
    price_read: price != null || inherits,
    unit_detail: unitDetail,
    price_vs_last_year: normalized != null && l.last_year_rate_inr ? { normalized, last_year: l.last_year_rate_inr } : null,
    flag_text: flagText,
    buyer_verified: verified,
  });

  return {
    normalized_inr: normalized,
    steps,
    notes,
    pack_size: packSize,
    pack_source: packSource,
    error,
    assumption_keys: applied,
    accepted_keys: accepted,
    flags: [...new Set(flags)],
    status: decision.status,
    reasons: decision.reasons,
    confidence: verified ? 1 : Math.min(l.match_confidence, READ_SCORE[l.read_confidence]),
    buyer_verified: verified,
    tax,
  };
}

/**
 * Running values through each conversion step, from the number as quoted to the
 * INR per base unit. Used to show "42,000 per tonne / 1000 = 42.00 per kg".
 */
export type ConversionTrace = {
  start: number;
  rows: { op: 'multiply' | 'divide'; factor: number; reason: string; assumption_key?: string; before: number; after: number }[];
  end: number;
  /** True when the trace ends at the stored result, a guard against drift. */
  consistent: boolean;
};

export function traceConversion(start: number, steps: ConversionStep[], result: number | null): ConversionTrace {
  let v = start;
  const rows = steps.map((s) => {
    const before = v;
    v = s.op === 'multiply' ? v * s.factor : v / s.factor;
    return { ...s, before, after: v };
  });
  const consistent = result == null ? false : Math.abs(v - result) <= 1e-9 * Math.max(1, Math.abs(result));
  return { start, rows, end: v, consistent };
}
