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
  /** A price was read from the document, even if it could not be converted. Defaults to has_price. */
  price_read?: boolean;
  /** Said when the unit could not be mapped, for example "Price read (13.80 per mtr). The unit could not be mapped to piece." */
  unit_detail?: string | null;
  /** The converted and last year prices, used to say which way an implausible price is off. */
  price_vs_last_year?: { normalized: number; last_year: number } | null;
  /** Text for flags that carry their own explanation (conditional_price, minimum_above_annual, board_grade_mismatch). */
  flag_text?: Record<string, string>;
};

/** How far a price may sit from last year's after a scale correction and still be called a likely scale slip. */
const SCALE_HINT_TOLERANCE = 0.35;

/**
 * The message for an implausible converted price. It says which way the price is off and, when multiplying or
 * dividing by 100 or 1000 would land within 35 percent of last year's rate, says so. It never applies the correction.
 */
export function unitSuspectMessage(normalized: number, lastYear: number): string {
  const high = normalized > lastYear;
  const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2));
  const base = high
    ? `Price is far above last year's rate (${fmt(normalized)} against ${fmt(lastYear)}). A pack or tonne price may not be converted.`
    : `Price is far below last year's rate (${fmt(normalized)} against ${fmt(lastYear)}). It may have been converted twice, or the unit is wrong.`;
  for (const k of [100, 1000]) {
    const candidate = high ? normalized / k : normalized * k;
    if (Math.abs(candidate / lastYear - 1) <= SCALE_HINT_TOLERANCE) {
      return `${base} ${high ? 'Dividing' : 'Multiplying'} by ${k} would give ${fmt(candidate)}, within 35 percent of last year's rate. Not applied: check the source.`;
    }
  }
  return base;
}

export type StatusDecision = { status: LineStatus; reasons: string[] };

/**
 * FR-4.5. Confirmed only when everything is clean. Photo sourced values are
 * capped at Assumed (DECISIONS.md D2). Conflict is decided across documents later.
 */
export function assignStatus(s: StatusInput): StatusDecision {
  const review: string[] = [];
  const priceRead = s.price_read ?? s.has_price;
  if (!s.has_price && !(priceRead && !s.unit_known)) review.push('No readable price.');
  if (!s.unit_known) review.push(s.unit_detail ?? 'Unit could not be mapped to the RFx unit.');
  const ft = (k: string, fallback: string) => s.flag_text?.[k] ?? fallback;
  // Judgements about the vendor's terms that a person must settle: they hold even after a buyer check of the number.
  const terms: string[] = [];
  if (s.flags.includes('board_grade_mismatch')) terms.push(ft('board_grade_mismatch', 'The vendor prices a different board grade than this RFx line. No adjusted price is computed.'));
  if (s.flags.includes('minimum_above_annual')) terms.push(ft('minimum_above_annual', 'The vendor minimum order is above the annual quantity.'));
  if (s.buyer_verified) {
    // A person looked at the source: read, match and evidence doubts are settled.
    if (review.length > 0) return { status: 'needs_review', reasons: review };
    if (terms.length > 0) return { status: 'assumed', reasons: [`Verified by the buyer, at the vendor's own unadjusted price. ${terms.join(' ')}`] };
    if (s.assumption_keys.length > 0) return { status: 'assumed', reasons: [`Verified by the buyer. Still depends on: ${s.assumption_keys.join(', ')}.`] };
    return { status: 'confirmed', reasons: ['Verified by the buyer against the source. No assumptions apply.'] };
  }
  if (s.read_confidence === 'low') review.push('Low read confidence.');
  if (s.read_confidence === 'medium' && s.source_type !== 'image') review.push('Medium read confidence on a text source.');
  if (s.match_confidence < MATCH_CONFIRM_THRESHOLD) review.push(`Match confidence ${s.match_confidence.toFixed(2)} is below ${MATCH_CONFIRM_THRESHOLD}.`);
  if (s.flags.includes('evidence_mismatch')) review.push('The number does not appear in the quoted evidence.');
  if (s.flags.includes('unit_suspect')) {
    review.push(s.price_vs_last_year ? unitSuspectMessage(s.price_vs_last_year.normalized, s.price_vs_last_year.last_year) : 'Price is implausible for the unit, possibly a pack or tonne price not converted.');
  }
  if (s.flags.includes('from_hidden_sheet')) review.push('Value comes from a hidden sheet.');
  review.push(...terms);
  if (review.length > 0) return { status: 'needs_review', reasons: review };

  const assumed: string[] = [];
  if (s.assumption_keys.length > 0) assumed.push(`Assumptions applied: ${s.assumption_keys.join(', ')}.`);
  if (s.flags.includes('conditional_price')) assumed.push(ft('conditional_price', 'The price depends on a condition that has not been verified.'));
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
