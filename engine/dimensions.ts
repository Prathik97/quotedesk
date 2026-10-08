// Size check for boxes and cartons: parse length x width x height from an RFx description and from the vendor's
// own size text, compare them, and look for a better fitting RFx line of the same ply. Pure, no I/O.
// The check only flags. It never re-maps a line and a match never promotes a line to Confirmed.

export type Dims = { mm: [number, number, number]; unit: 'mm' | 'cm' | 'in'; text: string };

/** How far each sorted dimension may differ, as a fraction of the RFx dimension. */
export const DIMENSION_TOLERANCE = 0.06;

const TO_MM = { mm: 1, cm: 10, in: 25.4 } as const;
const NUM = '(\\d+(?:\\.\\d+)?)';
const UNIT = '(mm|cm|inches|inch|in|"|”|″|\'\')';
const SEP = '\\s*[x×*]\\s*';
const TRIPLE = new RegExp(`${NUM}\\s*${UNIT}?${SEP}${NUM}\\s*${UNIT}?${SEP}${NUM}\\s*${UNIT}?(?![\\w.])`, 'i');

function unitOf(u: string | undefined): 'mm' | 'cm' | 'in' | null {
  if (!u) return null;
  const x = u.toLowerCase();
  if (x === 'mm') return 'mm';
  if (x === 'cm') return 'cm';
  return 'in';
}

/**
 * The first L x W x H in a text. The unit is the one written after any of the three numbers; when none is written,
 * an inch word or quote mark elsewhere in the text counts ("12x8x6 (inch assumed)"), and bare numbers that are all
 * 100 or more are read as millimetres. Anything else is not guessed: null.
 */
export function parseDims(text: string | null | undefined): Dims | null {
  if (!text) return null;
  const m = TRIPLE.exec(text);
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[3]), Number(m[5])] as [number, number, number];
  let unit = unitOf(m[6]) ?? unitOf(m[4]) ?? unitOf(m[2]);
  if (!unit) {
    if (/\binch(?:es)?\b|["”″]/i.test(text)) unit = 'in';
    else if (nums.every((n) => n >= 100)) unit = 'mm';
  }
  if (!unit || nums.some((n) => !(n > 0))) return null;
  const mm = nums.map((n) => n * TO_MM[unit as keyof typeof TO_MM]).sort((a, b) => a - b) as [number, number, number];
  return { mm, unit, text: m[0] };
}

export function plyOf(text: string | null | undefined): number | null {
  const m = /(\d)\s*[- ]?ply\b/i.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

/** Largest relative difference over the three sorted dimensions. */
export function dimensionGap(a: [number, number, number], rfx: [number, number, number]): number {
  return Math.max(...a.map((v, i) => Math.abs(v / (rfx[i] as number) - 1)));
}

export const fits = (a: Dims, rfx: Dims): boolean => dimensionGap(a.mm, rfx.mm) <= DIMENSION_TOLERANCE + 1e-9;

const fmt = (d: [number, number, number]) => d.map((v) => Math.round(v)).join(' x ');

export type SizeCheck =
  | { kind: 'match'; note: string }
  | { kind: 'mismatch'; message: string; candidate: string; candidate_unquoted: boolean };

export type RfxSize = { code: string; text: string };

/**
 * Compares the vendor's size text with the RFx line it was matched to. When the matched line does not fit and
 * another RFx line of the same ply does, the result names that line. `quoted` lists the RFx codes this document
 * prices, so the message can say whether the better line would otherwise go unquoted.
 */
export function sizeCheck(vendorText: string[], matched: RfxSize, peers: RfxSize[], quoted: Set<string>): SizeCheck | null {
  const vendor = vendorText.map(parseDims).find((d) => d != null) ?? null;
  const rfx = parseDims(matched.text);
  if (!vendor || !rfx) return null;
  const vendorLabel = `${vendor.text.trim()}${vendor.unit === 'mm' ? '' : ` (${fmt(vendor.mm)} mm)`}`;
  const sorted = ' (sides sorted smallest first)';
  if (fits(vendor, rfx)) {
    return { kind: 'match', note: `Size check: the vendor's ${vendorLabel} agrees with ${matched.code} at ${fmt(rfx.mm)} mm${sorted}, within ${Math.round(DIMENSION_TOLERANCE * 100)} percent on each side. Evidence only: it does not confirm the line.` };
  }
  const ply = plyOf(matched.text);
  if (ply == null) return null;
  const better = peers
    .filter((p) => p.code !== matched.code && plyOf(p.text) === ply)
    .flatMap((p) => { const d = parseDims(p.text); return d && fits(vendor, d) ? [{ p, d, gap: dimensionGap(vendor.mm, d.mm) }] : []; })
    .sort((a, b) => a.gap - b.gap)[0];
  if (!better) return null;
  const unquoted = !quoted.has(better.p.code);
  return {
    kind: 'mismatch',
    candidate: better.p.code,
    candidate_unquoted: unquoted,
    message: `Size does not fit the matched line: the vendor's ${vendorLabel} is not within ${Math.round(DIMENSION_TOLERANCE * 100)} percent of ${matched.code} at ${fmt(rfx.mm)} mm. ${better.p.code} at ${fmt(better.d.mm)} mm fits better${unquoted ? ' and has no price in this document' : ''}. Not re-mapped: check which line the vendor meant.`,
  };
}
