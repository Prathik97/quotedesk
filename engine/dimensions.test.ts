import { describe, expect, it } from 'vitest';
import { parseDims, sizeCheck } from './dimensions';
import { recomputeLine, type StoredLine } from './recompute';

const peers = [
  { code: 'B-3P-01', text: '3 ply RSC carton 300x200x150 mm, BF 18' },
  { code: 'B-3P-02', text: '3 ply RSC carton 350x250x200 mm, BF 18' },
  { code: 'B-3P-03', text: '3 ply RSC carton 400x300x250 mm, BF 18' },
  { code: 'B-5P-01', text: '5 ply RSC carton 350x250x200 mm, BF 22' },
  { code: 'S-5P-01', text: '5 ply corrugated sheet 1100x1500 mm' },
];

describe('parsing sizes', () => {
  it.each([
    ['14x10x8 inch', [203.2, 254, 355.6]],
    ['14 x 10 x 8 in', [203.2, 254, 355.6]],
    ['14"x10"x8"', [203.2, 254, 355.6]],
    ['box 35 x 25 x 20 cm', [200, 250, 350]],
    ['carton 350x250x200 mm', [200, 250, 350]],
    ['3ply box 12x8x6 (inch assumed)', [152.4, 203.2, 304.8]],
    ['box 350x250x200', [200, 250, 350]],
  ])('%s', (text, mm) => {
    const d = parseDims(text);
    expect(d?.mm.map((v) => Math.round(v * 10) / 10)).toEqual(mm);
  });
  it('does not guess a bare small size or a two side size', () => {
    expect(parseDims('box 14x10x8')).toBeNull();
    expect(parseDims('sheet 1100x1500 mm')).toBeNull();
    expect(parseDims(null)).toBeNull();
  });
});

describe('size check (G2)', () => {
  const matched = (code: string) => peers.find((p) => p.code === code)!;
  it('flags a wrong match and names the better candidate of the same ply, not a 5 ply line', () => {
    const c = sizeCheck(['3ply box 9x6x5 inch'], matched('B-3P-03'), peers, new Set(['B-3P-03']));
    expect(c).toBeNull(); // 229x152x127 fits no line: nothing to name
    const d = sizeCheck(['3ply box 14x10x8 inch'], matched('B-3P-03'), peers, new Set(['B-3P-03']));
    expect(d).toMatchObject({ kind: 'mismatch', candidate: 'B-3P-02', candidate_unquoted: true });
    expect(d?.kind === 'mismatch' && d.message).toMatch(/B-3P-02 at 200 x 250 x 350 mm fits better and has no price in this document/);
  });
  it('a match is positive evidence in a note', () => {
    const c = sizeCheck(['3ply box 14x10x8 inch'], matched('B-3P-02'), peers, new Set());
    expect(c?.kind).toBe('match');
  });
  it('the tolerance is about 6 percent a side', () => {
    expect(sizeCheck(['box 350x250x200 mm'], matched('B-3P-02'), peers, new Set())?.kind).toBe('match');
    expect(sizeCheck(['box 369x264x211 mm'], matched('B-3P-02'), peers, new Set())?.kind).toBe('match'); // +5.6 %
    expect(sizeCheck(['box 376x250x200 mm'], matched('B-3P-02'), peers, new Set())).toBeNull(); // +7.4 %, nothing else fits
  });
  it('orientation does not matter: dimensions are compared sorted', () => {
    expect(sizeCheck(['box 200x350x250 mm'], matched('B-3P-02'), peers, new Set())?.kind).toBe('match');
  });
});

describe('what a size finding does to a line', () => {
  const line: StoredLine = {
    price: 9.5, currency: 'INR', uom_text: 'each', per_n: 1, tax_basis: 'excl_gst', inherits_last_year: false, base_uom: 'piece', last_year_rate_inr: 9.8,
    unit_definitions: [], read_confidence: 'high', match_confidence: 0.95, source_type: 'email', evidence_quote: '14x10x8 - 9.5 each', evidence_locator: 'L9', sticky_flags: [], overrides: {},
    conditions: [], annual_qty: 1000, rfx_text: '3 ply RSC carton 400x300x250 mm, BF 18', vendor_notes: [],
  };
  const a = { usd_inr: 96, gst_pct: 18 };
  const mismatch = sizeCheck(['3ply box 14x10x8 inch'], { code: 'B-3P-03', text: line.rfx_text! }, peers, new Set(['B-3P-03']));

  it('a mismatch makes a clean, high confidence line Needs review and says which line fits', () => {
    expect(recomputeLine(line, a).status).toBe('confirmed');
    const r = recomputeLine({ ...line, size_check: mismatch }, a);
    expect(r.status).toBe('needs_review');
    expect(r.flags).toContain('dimension_mismatch');
    expect(r.reasons.join(' ')).toMatch(/B-3P-02/);
    expect(r.normalized_inr).toBe(9.5); // never re-mapped, never repriced
  });
  it('a buyer check keeps it at Assumed at most, not Confirmed', () => {
    expect(recomputeLine({ ...line, size_check: mismatch, overrides: { verified: true } }, a).status).toBe('assumed');
  });
  it('a match never promotes: a line that needs review for another reason stays there, and the note is only evidence', () => {
    const ok = sizeCheck(['3ply box 14x10x8 inch'], peers[1]!, peers, new Set());
    const weak = recomputeLine({ ...line, rfx_text: peers[1]!.text, match_confidence: 0.6, size_check: ok }, a);
    expect(weak.status).toBe('needs_review');
    expect(weak.notes.join(' ')).toMatch(/Size check/);
    expect(weak.notes.join(' ')).toMatch(/does not confirm the line/);
  });
  it('two vendor lines on one RFx line are flagged', () => {
    const r = recomputeLine({ ...line, duplicate_rfx_match: '2 vendor lines in this document are matched to B-3P-03.' }, a);
    expect(r.flags).toContain('duplicate_rfx_match');
    expect(r.status).toBe('needs_review');
  });
});
