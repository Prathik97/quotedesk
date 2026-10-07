import { describe, expect, it } from 'vitest';
import { describeRule, evaluateKnockouts, type KnockoutQuestion } from './questionnaire';

const Q: KnockoutQuestion[] = [
  { code: 'Q1', is_knockout: true, pass_rule: { op: 'valid_on_date', field: 'expiry', date: 'submission' } },
  { code: 'Q2', is_knockout: true, pass_rule: { op: 'eq', value: true } },
  { code: 'Q3', is_knockout: true, pass_rule: { op: 'lte', value: 2.0 } },
  { code: 'Q4', is_knockout: false, pass_rule: null },
];
const ans = (value: unknown) => ({ status: 'answered' as const, value });

describe('evaluateKnockouts', () => {
  it('clears a vendor that passes all three', () => {
    const r = evaluateKnockouts(Q, { Q1: ans({ has: true, expiry: '2027-11-30' }), Q2: ans(true), Q3: ans(0.8) }, '2026-04-08');
    expect(r.result).toBe('Cleared');
  });
  it('fails on an expired certificate taken from the attachment', () => {
    const r = evaluateKnockouts(Q, { Q1: ans({ has: true }), Q2: ans(true), Q3: ans(1) }, '2026-04-13', '2026-03-31');
    expect(r.result).toBe('Failed');
    expect(r.knockouts.Q1?.outcome).toBe('fail');
  });
  it('fails on a rejection rate above 2.0', () => {
    expect(evaluateKnockouts(Q, { Q1: ans({ has: true, expiry: '2028-01-01' }), Q2: ans(true), Q3: ans(3.4) }, '2026-04-13').result).toBe('Failed');
  });
  it('is pending when a knockout is unanswered or unclear', () => {
    const r = evaluateKnockouts(Q, { Q1: ans({ has: true }), Q2: { status: 'partial', value: null }, Q3: { status: 'unanswered', value: null } }, '2026-04-15', '2027-06-30');
    expect(r.result).toBe('Pending');
    expect(r.knockouts.Q2?.outcome).toBe('pending');
    expect(r.knockouts.Q3?.outcome).toBe('pending');
  });
  it('reads numbers written as text', () => {
    expect(evaluateKnockouts(Q, { Q1: ans({ has: true, expiry: '2028-01-01' }), Q2: ans(true), Q3: ans('1.5 percent') }, '2026-04-11').result).toBe('Cleared');
  });

  it('never decides a knockout on an inferred answer, but keeps the tentative reading', () => {
    const r = evaluateKnockouts(Q, { Q1: ans({ has: true, expiry: '2028-01-01' }), Q2: { status: 'answered', value: false, basis: 'inferred' }, Q3: ans(1) }, '2026-04-15');
    expect(r.result).toBe('Pending');
    expect(r.knockouts.Q2).toMatchObject({ outcome: 'pending', tentative: 'fail' });
    expect(r.knockouts.Q2?.reason).toMatch(/Confirm with the vendor/);
  });
  it('an explicit failure still fails even when another knockout is inferred', () => {
    const r = evaluateKnockouts(Q, { Q1: ans({ has: true, expiry: '2028-01-01' }), Q2: { status: 'answered', value: true, basis: 'inferred' }, Q3: ans(3.4) }, '2026-04-15');
    expect(r.result).toBe('Failed');
  });
});

describe('describeRule', () => {
  it('words each rule', () => {
    expect(describeRule({ op: 'eq', value: true })).toBe('Must be yes');
    expect(describeRule({ op: 'eq', value: false })).toBe('Must be no');
    expect(describeRule({ op: 'lte', value: 2 })).toBe('At most 2');
    expect(describeRule({ op: 'gte', value: 5 })).toBe('At least 5');
    expect(describeRule({ op: 'valid_on_date', field: 'expiry', date: 'submission' })).toBe('Certificate valid on the reply date');
    expect(describeRule(null)).toBeNull();
  });
});
