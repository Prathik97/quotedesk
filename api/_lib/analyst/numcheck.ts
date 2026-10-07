// Server side number check. After the analyst writes an answer, every figure in the text must
// appear in something the model was given: a tool result, the question, or the static context.
// It is a smoke alarm, not a proof: a small whole number can match by accident, and a wrong
// figure that happens to equal some other number in the data would pass. What it does catch
// is the model doing its own arithmetic or inventing a figure, which is the failure that matters.

export type Figure = { text: string; value: number; decimals: number; scale: number; percent: boolean };

const NUM = /(?<![\w.])(?<!\w-)(\d[\d,]*(?:\.\d+)?)(?:\s*(lakhs?|lacs?|crores?|cr\b|%|percent|per\s*cent))?(?![\w])/gi;

function scaleOf(unit: string | undefined): { scale: number; percent: boolean } {
  const u = (unit ?? '').toLowerCase().replace(/\s+/g, '');
  if (u.startsWith('cr')) return { scale: 1e7, percent: false };
  if (u.startsWith('l')) return { scale: 1e5, percent: false };
  if (u === '%' || u.startsWith('per')) return { scale: 1, percent: true };
  return { scale: 1, percent: false };
}

function decimalsOf(raw: string): number {
  const i = raw.indexOf('.');
  return i < 0 ? 0 : raw.length - i - 1;
}

/** Figures worth checking in an answer. Years, list markers and codes (V2, Q1, CRT-5P-01) are skipped. */
export function extractFigures(text: string): Figure[] {
  const out: Figure[] = [];
  const body = text.replace(/^\s*\d+[.)]\s/gm, ' ');
  for (const m of body.matchAll(NUM)) {
    const raw = m[1] ?? '';
    const digits = raw.replace(/,/g, '');
    const value = Number(digits);
    if (!Number.isFinite(value) || value === 0) continue; // a count of zero needs no source
    if (/^(19|20)\d{2}$/.test(digits) && !raw.includes(',')) continue;
    const { scale, percent } = scaleOf(m[2]);
    out.push({ text: m[0].trim(), value, decimals: decimalsOf(digits), scale, percent });
  }
  return out;
}

/** Every number in a body of text or JSON, including figures written with lakh, crore or a percent sign. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUM)) {
    const v = Number((m[1] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    const { scale } = scaleOf(m[2]);
    out.push(v * scale);
    if (scale !== 1) out.push(v);
  }
  // Numbers inside JSON text such as "price":9.792 or -450.5 are matched above; negatives are compared by magnitude.
  return out;
}

function sameAtPrecision(n: number, f: Figure): boolean {
  const a = Math.abs(n) / f.scale;
  const step = 10 ** -f.decimals;
  const tol = step * 0.5 + 1e-9;
  if (Math.abs(a - f.value) <= tol) return true;
  // Truncation instead of rounding: 3.985 shown as 3.98.
  return Math.abs(Math.floor(a / step + 1e-9) * step - f.value) < 1e-9;
}

export type NumberCheck = { ok: boolean; checked: number; unmatched: { text: string; value: number }[] };

export function checkNumbers(answer: string, sources: string[]): NumberCheck {
  const figures = extractFigures(answer);
  const pool = sources.flatMap(numbersIn);
  const uniq = [...new Set(pool.map((n) => Math.abs(n)))];
  const unmatched: NumberCheck['unmatched'] = [];
  for (const f of figures) {
    let hit = uniq.some((n) => sameAtPrecision(n, f));
    // A share stored as a fraction (0.507) can be written as 50.7 percent.
    if (!hit && f.percent) hit = uniq.some((n) => n <= 1.5 && sameAtPrecision(n * 100, f));
    if (!hit) unmatched.push({ text: f.text, value: f.value * f.scale });
  }
  return { ok: unmatched.length === 0, checked: figures.length, unmatched };
}
