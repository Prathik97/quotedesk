// Deterministic checks run after extraction, and the FR-4.5 status rules.
import type { Evidence, LineStatus, ReadConfidence, SourceType } from './types';

export const MATCH_CONFIRM_THRESHOLD = 0.85;
export const MATCH_REVIEW_FLOOR = 0.6;
export const UNUSUAL_VS_LY = 0.35;
export const UNIT_SUSPECT_RATIO = 4;
export const TOTAL_TOLERANCE = 0.005;

/** All numbers written in a piece of text, with Indian or western grouping. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Does the evidence quote contain the extracted number? Tolerates grouping and trailing zeros. */
export function quoteContainsNumber(quote: string | null | undefined, value: number): boolean {
  if (!quote) return false;
  return numbersIn(quote).some((n) => Math.abs(n - value) < 1e-9 * Math.max(1, Math.abs(value)));
}

export function relativeDelta(value: number, reference: number): number {
  return value / reference - 1;
}

export type LineCheckInput = {
  price_as_written: number | null;
  normalized_inr: number | null;
  last_year_rate_inr: number | null;
  evidence: Pick<Evidence, 'quote' | 'locator'> | null;
  inherits_last_year: boolean;
};

/** Flags only; status is decided separately. */
export function lineFlags(i: LineCheckInput): string[] {
  const flags: string[] = [];
  if (!i.inherits_last_year && i.price_as_written != null && !quoteContainsNumber(i.evidence?.quote, i.price_as_written)) {
    flags.push('evidence_mismatch');
  }
  if (i.normalized_inr != null && i.last_year_rate_inr && i.last_year_rate_inr > 0) {
    const ratio = i.normalized_inr / i.last_year_rate_inr;
    if (ratio > UNIT_SUSPECT_RATIO || ratio < 1 / UNIT_SUSPECT_RATIO) flags.push('unit_suspect');
    else if (Math.abs(ratio - 1) > UNUSUAL_VS_LY) flags.push('unusual_vs_last_year');
  }
  return flags;
}

export type StatusInput = {
  source_type: SourceType;
  read_confidence: ReadConfidence;
  match_confidence: number;
  flags: string[];
  unit_known: boolean;
  assumption_keys: string[];
  has_price: boolean;
  /** The buyer checked this value against the source (accept, edit, or unit meaning). */
  buyer_verified?: boolean;
};

export type StatusDecision = { status: LineStatus; reasons: string[] };

/**
 * FR-4.5. Confirmed only when everything is clean. Photo sourced values are
 * capped at Assumed (DECISIONS.md D2). Conflict is decided across documents later.
 */
export function assignStatus(s: StatusInput): StatusDecision {
  const review: string[] = [];
  if (!s.has_price) review.push('No readable price.');
  if (!s.unit_known) review.push('Unit could not be mapped to the RFx unit.');
  if (s.buyer_verified) {
    // A person looked at the source: read, match and evidence doubts are settled.
    if (review.length > 0) return { status: 'needs_review', reasons: review };
    if (s.assumption_keys.length > 0) return { status: 'assumed', reasons: [`Verified by the buyer. Still depends on: ${s.assumption_keys.join(', ')}.`] };
    return { status: 'confirmed', reasons: ['Verified by the buyer against the source. No assumptions apply.'] };
  }
  if (s.read_confidence === 'low') review.push('Low read confidence.');
  if (s.read_confidence === 'medium' && s.source_type !== 'image') review.push('Medium read confidence on a text source.');
  if (s.match_confidence < MATCH_CONFIRM_THRESHOLD) review.push(`Match confidence ${s.match_confidence.toFixed(2)} is below ${MATCH_CONFIRM_THRESHOLD}.`);
  if (s.flags.includes('evidence_mismatch')) review.push('The number does not appear in the quoted evidence.');
  if (s.flags.includes('unit_suspect')) review.push('Price is implausible for the unit, possibly a pack or tonne price not converted.');
  if (s.flags.includes('from_hidden_sheet')) review.push('Value comes from a hidden sheet.');
  if (review.length > 0) return { status: 'needs_review', reasons: review };

  const assumed: string[] = [];
  if (s.assumption_keys.length > 0) assumed.push(`Assumptions applied: ${s.assumption_keys.join(', ')}.`);
  if (s.source_type === 'image') assumed.push('Read from a photo. Photo values are never auto confirmed.');
  if (assumed.length > 0) return { status: 'assumed', reasons: assumed };

  return { status: 'confirmed', reasons: ['High read confidence, strong match, number found in evidence, unit explicit, no assumptions.'] };
}

/** Two sources disagree on the same line for the same vendor. */
export function detectConflicts(values: { id: string; normalized_inr: number | null }[]): string[] {
  const priced = values.filter((v) => v.normalized_inr != null);
  if (priced.length < 2) return [];
  const first = priced[0]?.normalized_inr ?? 0;
  const disagree = priced.some((v) => Math.abs((v.normalized_inr ?? 0) - first) > 0.005 * Math.max(1, Math.abs(first)));
  return disagree ? priced.map((v) => v.id) : [];
}

export type TotalCheck = { mismatch: boolean; computed_inr: number; stated_inr: number; delta_pct: number };

/** Compare the document's stated total with the sum of its lines times annual quantity. */
export function reconcileTotal(lines: { normalized_inr: number; annual_qty: number }[], statedInr: number): TotalCheck {
  const computed = lines.reduce((s, l) => s + l.normalized_inr * l.annual_qty, 0);
  const delta = computed === 0 ? Infinity : statedInr / computed - 1;
  return { mismatch: Math.abs(delta) > TOTAL_TOLERANCE, computed_inr: computed, stated_inr: statedInr, delta_pct: delta * 100 };
}

/** Normalize a legal name for comparison: case, punctuation and entity suffixes removed. */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(private|pvt|limited|ltd|llp|co|company|the|m s|ms)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function namesMatch(a: string, b: string): boolean {
  const x = normalizeEntityName(a);
  const y = normalizeEntityName(b);
  return x.length > 0 && x === y;
}

/**
 * A blanket statement such as "everything else as before" has a scope that code
 * can check: it should cover exactly the RFx lines the same document does not
 * price elsewhere. When it does, the scope is verified deterministically.
 */
export function coversExactlyRemainder(groupCodes: string[], explicitCodes: Set<string>, allCodes: string[]): boolean {
  const remainder = allCodes.filter((c) => !explicitCodes.has(c));
  const group = new Set(groupCodes);
  return remainder.length > 0 && group.size === remainder.length && remainder.every((c) => group.has(c));
}

export const VERIFIED_SCOPE_CONFIDENCE = 0.9;
