import { describe, expect, it } from 'vitest';
import { certaintyCounts, certaintySentence, readiness, STATUS_LABEL, toCellStatus } from './certainty';
import { explainConfidence } from './explain';
import { formatPct, formatQty, formatRupee } from './format';

describe('certainty counts', () => {
  const c = certaintyCounts(['confirmed', 'confirmed', 'assumed', 'needs_review', 'conflict', null, 'rejected']);
  it('counts every status, treating absent and rejected as not quoted', () => {
    expect(c).toEqual({ confirmed: 2, assumed: 1, needs_review: 1, conflict: 1, missing: 2, total: 7 });
  });
  it('writes the strip sentence', () => {
    expect(certaintySentence(certaintyCounts(['confirmed', 'assumed', 'needs_review']))).toBe('1 confirmed, 1 assumed, 1 need review');
    expect(certaintySentence(c)).toBe('2 confirmed, 1 assumed, 1 need review, 1 in conflict, 2 not quoted');
  });
  it('uses one vocabulary', () => {
    expect(Object.values(STATUS_LABEL)).toEqual(['Confirmed', 'Assumed', 'Needs review', 'Conflict', 'Not quoted']);
    expect(toCellStatus('rejected')).toBe('missing');
  });
});

describe('readiness', () => {
  const clean = certaintyCounts(['confirmed', 'confirmed']);
  it('is Ready only when everything is confirmed and nothing is open', () => {
    expect(readiness(clean, []).level).toBe('ready');
  });
  it('is Ready with assumptions when assumed cells or warnings remain', () => {
    expect(readiness(certaintyCounts(['confirmed', 'assumed']), []).level).toBe('ready_with_assumptions');
    expect(readiness(clean, [{ kind: 'certificate_expired', severity: 'warn', message: 'x' }]).level).toBe('ready_with_assumptions');
  });
  it('is Not ready when a blocker kind is open, and lists it', () => {
    const r = readiness(clean, [
      { kind: 'freight_amount_unknown', severity: 'warn', message: 'Freight', vendor: 'V3' },
      { kind: 'suspicious_content', severity: 'warn', message: 'Text' },
    ]);
    expect(r.level).toBe('not_ready');
    expect(r.label).toBe('Not ready with blockers');
    expect(r.blockers).toHaveLength(1);
    expect(r.warnings).toBe(1);
  });
  it('treats a block severity item as a blocker whatever its kind', () => {
    expect(readiness(clean, [{ kind: 'other', severity: 'block', message: 'x' }]).level).toBe('not_ready');
  });
  it('ignores info items', () => {
    expect(readiness(clean, [{ kind: 'hidden_sheet', severity: 'info', message: 'x' }]).level).toBe('ready');
  });
});

describe('explainConfidence', () => {
  const A = { usd_inr: 96, gst_pct: 18 };
  const base = { source_type: 'xlsx' as const, read_confidence: 'high' as const, match_confidence: 0.95, assumption_keys: [], accepted_keys: [], flags: [], buyer_verified: false, pack_source: null, rule_reasons: [] };
  it('explains Confirmed', () => {
    const t = explainConfidence({ ...base, status: 'confirmed' }, A).join(' ');
    expect(t).toContain('Confirmed');
    expect(t).toContain('high confidence');
  });
  it('names the FX rate in use for an Assumed USD cell', () => {
    const t = explainConfidence({ ...base, status: 'assumed', assumption_keys: ['usd_inr'] }, A).join(' ');
    expect(t).toContain('INR 96');
  });
  it('explains why a photo is never confirmed automatically', () => {
    const t = explainConfidence({ ...base, status: 'assumed', source_type: 'image', read_confidence: 'medium' }, A).join(' ');
    expect(t).toContain('never confirmed automatically');
  });
  it('lists the rule reasons for Needs review', () => {
    const t = explainConfidence({ ...base, status: 'needs_review', rule_reasons: ['Low read confidence.'] }, A).join(' ');
    expect(t).toContain('Low read confidence.');
  });
  it('explains Not quoted without any number', () => {
    expect(explainConfidence({ ...base, status: 'missing' }, A)[0]).toContain('never counted as zero');
  });
  it('says a person verified the cell', () => {
    expect(explainConfidence({ ...base, status: 'confirmed', buyer_verified: true }, A)[0]).toContain('A person has checked');
  });
});

describe('format helpers', () => {
  it('formats rupees, percentages and quantities', () => {
    expect(formatRupee(1180)).toBe('₹1,180.00');
    expect(formatRupee(-5.5)).toBe('-₹5.50');
    expect(formatPct(3.24)).toBe('+3.2%');
    expect(formatPct(-1)).toBe('-1.0%');
    expect(formatPct(0.02)).toBe('0.0%');
    expect(formatQty(120000)).toBe('1,20,000');
  });
  it('never prints an en dash or an em dash', () => {
    for (const s of [formatRupee(-5), formatPct(-2), formatPct(Number.NaN)]) expect(s).not.toMatch(/[\u2013\u2014]/);
  });
});
