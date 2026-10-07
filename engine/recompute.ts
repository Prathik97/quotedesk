// Recompute one stored quote line from its raw extracted fields, the current
// assumptions and the buyer's overrides. Pure: no I/O. This is the only place a
// line's normalized price, flags and status are derived, for the extraction
// pipeline and for every later change (FX, GST, corrections), so the two can
// never disagree.
import { normalizePrice } from './convert';
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
};

/** Statements about how to read a document. A buyer who has seen the source can accept these. */
export const INTERPRETATION_KEYS = ['pack_size', 'tax_basis_assumed_excl', 'last_year_inheritance'];
/** Numbers the vendor never gave. A buyer cannot verify these by looking at the source. */
export const EXTERNAL_KEYS = ['usd_inr', 'gst_pct'];

export const READ_SCORE: Record<ReadConfidence, number> = { high: 0.95, medium: 0.7, low: 0.4 };
export const STICKY_FLAGS = ['from_hidden_sheet', 'unmatched', 'unknown_rfx_code'];
const UNIT_PROBLEMS = ['unit_unknown', 'unit_incompatible', 'pack_size_unknown'];

export function recomputeLine(l: StoredLine, a: Assumptions): LineResult {
  const o = l.overrides;
  const verified = o.verified === true;
  const edited = o.price != null || o.currency != null || o.uom_text != null || o.per_n != null;
  const price = o.price ?? l.price;
  const inherits = l.inherits_last_year && !edited;

  const n = normalizePrice(
    {
      price,
      currency: o.currency ?? l.currency,
      uom_text: o.uom_text ?? l.uom_text,
      per_n: o.per_n ?? l.per_n,
      tax_basis: l.tax_basis,
      inherits_last_year: inherits,
      base_uom: l.base_uom,
      last_year_rate_inr: l.last_year_rate_inr,
      unit_definitions: l.unit_definitions,
      pack_override: o.pack ?? null,
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
    if (l.tax_basis === 'unknown' && !inherits) keys.push('tax_basis_assumed_excl');
  } else {
    unitKnown = !UNIT_PROBLEMS.includes(n.reason);
    flags.push(n.reason);
    error = { reason: n.reason, detail: n.detail };
  }
  if (edited) flags.push('buyer_edited');

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
