// The stored raw model replies of the two files that were NOT held out any more (eval/fixtures), replayed through the
// current derivation. No model call and no database: the raw reply is parsed with the production schema and handed to
// deriveLines, the one derivation behind the stored comparison and Try your file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shortValidityWarning } from '../../../engine/terms.js';
import { ExtractionSchema, parseJsonLoose, type Extraction } from '../../../src/lib/schemas/extraction.js';
import { deriveLines, type RfxLineRow } from '../extract/persist.js';
import type { Prepared } from '../extract/prepare.js';
import { indicativeFor } from './run.js';

const seed = JSON.parse(readFileSync(new URL('../../../seed/rfx.json', import.meta.url), 'utf8')) as {
  rfx: { validity_days: number };
  lines: { code: string; section: string; description: string; uom: RfxLineRow['uom']; annual_qty: number; ly_rate: number | null }[];
};
const rfx: RfxLineRow[] = seed.lines.map((l, i) => ({ id: `seed-${i}`, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate }));

function replay(name: string, source_type: 'xlsx' | 'email', edit?: (x: Extraction) => void) {
  const fx = JSON.parse(readFileSync(new URL(`../../../eval/fixtures/${name}.raw.json`, import.meta.url), 'utf8')) as { global_notes: string[]; replies: { text: string }[] };
  const reply = fx.replies.find((r) => /"document"\s*:/.test(r.text));
  const x: Extraction = ExtractionSchema.parse(parseJsonLoose(reply?.text ?? ''));
  edit?.(x);
  const derived = deriveLines({ source_type, observations: [] } as unknown as Prepared, x, rfx, { usd_inr: 96, gst_pct: 18 });
  const by = (code: string) => derived.find((d) => d.rfx?.code === code);
  return { fx, x, derived, by };
}

// The carton rule below is about units and board grades, not tax. Metro Kraft's note "Rates incl. GST shown for cartons
// only" is a tax statement with a scope (DECISIONS D116), which makes every carton line Not derived (tested after
// these). To keep the unit and grade rules pinned, they are tested on the same reply without that one note.
const withoutCartonTaxNote = (x: Extraction) => { x.document.global_notes = x.document.global_notes.filter((n) => !/incl\.? GST/i.test(n)); };

describe('Metro Kraft raw reply (xlsx), tax note removed so the unit and grade rules are tested alone', () => {
  const r = replay('sandbox-metro-kraft', 'xlsx', withoutCartonTaxNote);
  it('the model did capture the quote level notes, validity and payment', () => {
    expect(r.x.document.global_notes.join(' ')).toMatch(/BF 18 \(3 ply\) and BF 20 \(5 ply\)/);
    expect(r.x.document.global_notes.join(' ')).toMatch(/BF 22 on 5 ply: add Rs 0\.80/);
    expect(r.x.document.validity_text).toMatch(/15 days/);
    expect(r.x.document.payment_terms_text).toMatch(/100% advance/);
  });
  it('615 per 100 on a 3 ply carton is 6.15, Confirmed (F1)', () => {
    expect(r.by('CRT-3P-01')?.normalized).toBeCloseTo(6.15, 10);
    expect(r.by('CRT-3P-01')?.status).toBe('confirmed');
  });
  it('no carton line is flagged implausible any more (F1)', () => {
    for (const d of r.derived.filter((x) => x.rfx?.code.startsWith('CRT-'))) expect(d.flags).not.toContain('unit_suspect');
  });
  it('5 ply lines priced on BF 20 against an RFx BF 22 or 25 are Needs review with the vendor text, unadjusted (F4)', () => {
    for (const code of ['CRT-5P-01', 'CRT-5P-02', 'CRT-5P-03', 'CRT-5P-04', 'CRT-5P-05']) {
      const d = r.by(code);
      expect(d?.status, code).toBe('needs_review');
      expect(d?.flags).toContain('board_grade_mismatch');
      expect(d?.reasons.join(' ')).toMatch(/No adjusted price is computed/);
    }
    expect(r.by('CRT-5P-01')?.reasons.join(' ')).toContain('add Rs 0.80 per carton for BF 22');
    expect(r.by('CRT-5P-01')?.normalized).toBeCloseTo(27.4, 10);
  });
  it('3 ply lines on BF 18 match the RFx and are not flagged (F4)', () => {
    expect(r.by('CRT-3P-02')?.flags).not.toContain('board_grade_mismatch');
  });
  it('per mtr maps to a piece as Assumed with the RFx length note (F2)', () => {
    const d = r.by('INS-EDG-01');
    expect(d?.normalized).toBeCloseTo(13.8, 10);
    expect(d?.assumption_keys).toContain('unit_length');
    expect(d?.result?.notes).toContain('1 m equals 1 piece of 1000 mm (from the RFx spec).');
  });
  it('15 day validity warns against the 90 days the RFx asks for (F4)', () => {
    expect(shortValidityWarning(r.x.document.validity_text, seed.rfx.validity_days)).toBe('Offer valid for 15 days, shorter than the 90 days the RFx asks for.');
  });
});

describe('Metro Kraft raw reply (xlsx), as captured: a scoped tax statement makes the lines it could cover Not derived (H1)', () => {
  const r = replay('sandbox-metro-kraft', 'xlsx');
  it('cartons and the partition set that names a carton are Not derived, the price shown as written, Needs review', () => {
    for (const code of ['CRT-3P-01', 'CRT-3P-02', 'CRT-5P-07', 'INS-PRT-01']) {
      const d = r.by(code);
      expect(d?.normalized, code).toBeNull();
      expect(d?.status, code).toBe('needs_review');
      expect(d?.flags, code).toContain('tax_unresolved');
      expect(d?.reasons.join(' '), code).toMatch(/^Not derived: /);
    }
  });
  it('lines that name no carton keep their value and status (a sheet, tape, film are outside the statement)', () => {
    expect(r.by('SHT-3P-01')?.normalized).toBeCloseTo(39.6, 10);
    expect(r.by('SHT-3P-01')?.status).toBe('confirmed');
    expect(r.by('TPE-BOPP-01')?.status).toBe('confirmed');
    expect(r.by('FLM-STR-01')?.status).toBe('confirmed');
  });
});

describe('Trident raw reply (email)', () => {
  const r = replay('sandbox-trident', 'email');
  it('the model did capture the carton indication and the conditions', () => {
    expect(r.x.document.global_notes.join(' ')).toMatch(/Cartons not priced/);
    expect(r.x.document.global_notes.join(' ')).toMatch(/minimum order of 1000 pcs/);
    expect(r.x.document.conditional_discounts.map((c) => c.text).join(' ')).toMatch(/roughly 5 percent below last year/);
  });
  it('slab priced sheets are Assumed with conditional_price and the alternate price (F3)', () => {
    for (const code of ['SHT-5P-01', 'SHT-5P-02']) {
      expect(r.by(code)?.status).toBe('assumed');
      expect(r.by(code)?.flags).toContain('conditional_price');
      expect(r.by(code)?.reasons.join(' ')).toMatch(/Alternate price stated: Rs 4\d\.\d/);
    }
  });
  it('the flat sheet price stays Confirmed (F3)', () => {
    expect(r.by('SHT-3P-01')?.status).toBe('confirmed');
  });
  it('a pallet minimum of 1000 against 4000 a year stays Confirmed with a note (F3)', () => {
    expect(r.by('PLT-WD-01')?.status).toBe('confirmed');
    expect(r.by('PLT-WD-01')?.result?.notes.join(' ')).toMatch(/Minimum order 1000 pcs is met/);
  });
  it('"a roll" maps to roll (F2)', () => {
    expect(r.by('TPE-BOPP-01')?.normalized).toBeCloseTo(44.5, 10);
    expect(r.by('TPE-BOPP-01')?.status).toBe('confirmed');
  });
  it('the together-or-else tape price is conditional (F3)', () => {
    expect(r.by('TPE-BOPP-02')?.flags).toContain('conditional_price');
  });
  it('unquoted carton lines carry the vendor indicative statement beside them and stay unpriced (F4)', () => {
    const covered = new Set(r.derived.map((d) => d.rfx?.code));
    const missing = rfx.filter((l) => !covered.has(l.code)).map((l) => l.code);
    const ind = indicativeFor(missing, rfx, r.x.document.conditional_discounts.map((c) => ({ text: c.text, applies_to: c.applies_to, percent: c.percent, locator: null })), r.x.document.global_notes);
    expect(ind['CRT-5P-01']?.join(' ')).toMatch(/roughly 5 percent below last year/);
    expect(ind['CRT-3P-04']?.join(' ')).toMatch(/roughly 5 percent below last year/);
    expect(ind['ROL-3P-01']).toBeUndefined();
    expect(r.derived.find((d) => d.rfx?.code === 'CRT-5P-01')).toBeUndefined();
  });
  it('30 day validity warns (F4)', () => {
    expect(shortValidityWarning(r.x.document.validity_text, seed.rfx.validity_days)).toMatch(/30 days, shorter than the 90 days/);
  });
});
