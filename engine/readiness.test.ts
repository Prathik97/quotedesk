import { describe, expect, it } from 'vitest';
import { judgeScenario, type ReadinessVendor } from './readiness';

const v = (key: string, over: Partial<ReadinessVendor> = {}): ReadinessVendor => ({
  key, questionnaire: 'Cleared', needs_review: 0, conflict: 0, in_award: false, freight: { terms: 'included', amount_inr: null }, open_items: [], ...over,
});

describe('judgeScenario', () => {
  it('is Ready when nothing is open', () => {
    const r = judgeScenario([v('V1'), v('V2')], { assumed_cells: 0, gaps: 0 });
    expect(r.level).toBe('ready');
    expect(r.label).toBe('Ready');
  });
  it('a Needs review cell, a Conflict or a Pending knockout among included vendors is Not ready', () => {
    expect(judgeScenario([v('V1', { needs_review: 2 })], { assumed_cells: 0, gaps: 0 }).blockers[0]?.kind).toBe('line_needs_review');
    expect(judgeScenario([v('V1', { conflict: 1 })], { assumed_cells: 0, gaps: 0 }).level).toBe('not_ready');
    expect(judgeScenario([v('V5', { questionnaire: 'Pending' })], { assumed_cells: 0, gaps: 0 }).blockers).toEqual([expect.objectContaining({ vendor_key: 'V5', kind: 'knockout_pending' })]);
  });
  it('the same problems in a vendor outside the scenario do not count', () => {
    const r = judgeScenario([v('V1'), v('V2')], { assumed_cells: 0, gaps: 0 });
    expect(r.blockers).toHaveLength(0);
    expect(r.included_vendors).toEqual(['V1', 'V2']);
  });
  it('freight extra with no amount is an open item, not a blocker (owner decision)', () => {
    const r = judgeScenario([v('V3', { freight: { terms: 'extra', amount_inr: null } })], { assumed_cells: 0, gaps: 0 });
    expect(r.level).toBe('ready_with_open_items');
    expect(r.open_items).toEqual([expect.objectContaining({ vendor_key: 'V3', kind: 'freight_amount_unknown' })]);
  });
  it('does not list freight twice when a review item already says so', () => {
    const r = judgeScenario([v('V3', { freight: { terms: 'extra', amount_inr: null }, open_items: [{ kind: 'freight_amount_unknown', severity: 'warn', message: 'Freight is extra and no amount is stated.' }] })], { assumed_cells: 0, gaps: 0 });
    expect(r.open_items).toHaveLength(1);
  });
  it('a stated total mismatch and a certificate flag are open items; info items are not listed', () => {
    const r = judgeScenario([v('V2', { open_items: [{ kind: 'total_mismatch', severity: 'warn', message: 'Stated total does not add up.' }, { kind: 'hidden_sheet', severity: 'info', message: 'Hidden sheet.' }] })], { assumed_cells: 0, gaps: 0 });
    expect(r.open_items.map((i) => i.kind)).toEqual(['total_mismatch']);
  });
  it('Assumed cells and coverage gaps are open items', () => {
    const r = judgeScenario([v('V1')], { assumed_cells: 3, gaps: 1 });
    expect(r.open_items.map((i) => i.kind)).toEqual(['assumed_cells', 'coverage_gaps']);
    expect(r.level).toBe('ready_with_open_items');
  });
  it('a failed knockout blocks only a vendor that is in the award', () => {
    expect(judgeScenario([v('V4', { questionnaire: 'Failed' })], { assumed_cells: 0, gaps: 0 }).blockers).toHaveLength(0);
    expect(judgeScenario([v('V4', { questionnaire: 'Failed', in_award: true })], { assumed_cells: 0, gaps: 0 }).blockers[0]?.kind).toBe('knockout_failed');
  });
});
