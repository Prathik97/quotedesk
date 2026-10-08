import { describe, expect, it } from 'vitest';
import { addLines, addQuestions, bySection, emptyRfx, removeLine, setKnockout, setTerms, unitLabel, updateLine, validateRfx, type DraftRfx } from './rfx';

const line = (o: Partial<Parameters<typeof addLines>[1][number]> = {}) => ({ section: 'Cartons', description: '5 ply carton 450x300x250', uom: 'piece', annual_qty: 1000, ...o });

function good(): DraftRfx {
  let r = emptyRfx();
  r = addLines(r, [line()]).rfx;
  r = setTerms(r, { payment_terms_days: 45, validity_days: 90, delivery_location: 'Bengaluru plant', gst_basis: 'excl_gst', title: 'T', scope_summary: 'S', quotes_due_day: 14 }).rfx;
  r = addQuestions(r, [{ text: 'ISO 9001 valid?', is_knockout: true, pass_rule: { op: 'eq', value: true } }]).rfx;
  return r;
}
const codes = (r: DraftRfx, sev?: 'error' | 'warning') =>
  validateRfx(r).findings.filter((f) => !sev || f.severity === sev).map((f) => f.code);

describe('validateRfx errors', () => {
  it('passes a complete RFx with no findings', () => {
    const v = validateRfx(good());
    expect(v.findings).toEqual([]);
    expect(v.can_issue).toBe(true);
  });

  it('blocks an empty RFx: no lines, no terms', () => {
    const v = validateRfx(emptyRfx());
    expect(v.can_issue).toBe(false);
    expect(codes(emptyRfx(), 'error')).toEqual(['no_lines', 'missing_payment_terms', 'missing_validity']);
  });

  it('flags a missing unit', () => {
    const r = addLines(good(), [line({ description: 'Tape', uom: null })]).rfx;
    expect(codes(r, 'error')).toEqual(['missing_unit']);
  });

  it('flags a missing or zero quantity', () => {
    const r = addLines(good(), [line({ description: 'Tape', annual_qty: null }), line({ description: 'Film', annual_qty: 0 })]).rfx;
    expect(codes(r, 'error')).toEqual(['missing_quantity', 'missing_quantity']);
  });

  it('flags boxes with no pack size as ambiguous, and accepts a pack size or a stated one', () => {
    const base = good();
    expect(codes(addLines(base, [line({ description: 'Mailers', uom: 'boxes' })]).rfx, 'error')).toEqual(['ambiguous_unit']);
    expect(codes(addLines(base, [line({ description: 'Mailers', uom: 'boxes', pack_size: 100 })]).rfx, 'error')).toEqual([]);
    expect(codes(addLines(base, [line({ description: 'Mailers', uom: 'box', spec: 'box of 50 pcs' })]).rfx, 'error')).toEqual([]);
    expect(codes(addLines(base, [line({ description: 'Mailers', uom: 'bundle', spec: '25 pcs per bundle' })]).rfx, 'error')).toEqual([]);
  });

  it('warns, not errors, on a unit it does not know', () => {
    const r = addLines(good(), [line({ description: 'Glue', uom: 'drumlet' })]).rfx;
    expect(codes(r, 'error')).toEqual([]);
    expect(codes(r, 'warning')).toEqual(['unusual_unit']);
  });

  it('flags duplicate lines on description and spec, ignoring case and punctuation', () => {
    const r = addLines(good(), [line({ description: '5 PLY carton, 450x300x250' })]).rfx;
    expect(codes(r, 'error')).toEqual(['duplicate_line']);
    // The same description with a different spec is a different item.
    const ok = addLines(good(), [line({ spec: 'BF 25' })]).rfx;
    expect(codes(ok, 'error')).toEqual([]);
  });

  it('flags a knockout with no pass rule as an error and other questions as a warning', () => {
    let r = good();
    r = addQuestions(r, [{ text: 'Lead time in days?', answer_type: 'number' }, { text: 'Rejection rate?', is_knockout: true }]).rfx;
    expect(codes(r, 'error')).toEqual(['knockout_no_pass_rule']);
    expect(codes(r, 'warning')).toEqual(['question_no_pass_rule']);
  });

  it('flags missing payment or validity terms', () => {
    expect(codes(setTerms(good(), { payment_terms_days: null }).rfx, 'error')).toEqual(['missing_payment_terms']);
    expect(codes(setTerms(good(), { validity_days: null }).rfx, 'error')).toEqual(['missing_validity']);
  });
});

describe('validateRfx warnings', () => {
  it('lists warnings but still allows issue', () => {
    const r = setTerms(good(), { delivery_location: null, gst_basis: null, quotes_due_day: null }).rfx;
    const v = validateRfx(r);
    expect(v.can_issue).toBe(true);
    expect(v.errors).toBe(0);
    expect(v.findings.map((f) => f.code)).toEqual(['missing_delivery', 'missing_gst_basis', 'missing_timeline']);
  });

  it('warns when there is no questionnaire, or no knockout', () => {
    const noQ = { ...good(), questions: [] };
    expect(codes(noQ, 'warning')).toEqual(['no_questions']);
    const noKo = addQuestions({ ...good(), questions: [] }, [{ text: 'Lead time?', answer_type: 'number', pass_rule: { op: 'lte', value: 10 } }]).rfx;
    expect(codes(noKo, 'warning')).toEqual(['no_knockout']);
  });

  it('warns on a timeline out of order', () => {
    const r = setTerms(good(), { clarifications_by_day: 20, quotes_due_day: 10 }).rfx;
    expect(codes(r, 'warning')).toEqual(['timeline_order']);
  });

  it('warns on a repeated question', () => {
    const r = addQuestions(good(), [{ text: 'iso 9001 valid', is_knockout: true, pass_rule: { op: 'eq', value: true } }]).rfx;
    expect(codes(r, 'warning')).toEqual(['duplicate_question']);
  });
});

describe('operations', () => {
  it('assigns unique codes per section prefix and groups by section', () => {
    let r = emptyRfx();
    r = addLines(r, [line(), line({ description: 'b' }), line({ section: 'Tapes and films', description: 'c' })]).rfx;
    expect(r.lines.map((l) => l.code)).toEqual(['CAR-01', 'CAR-02', 'TAP-01']);
    expect(bySection(r.lines).map((g) => [g.section, g.lines.length])).toEqual([['Cartons', 2], ['Tapes and films', 1]]);
  });

  it('does not reuse a code after a removal', () => {
    let r = addLines(emptyRfx(), [line(), line({ description: 'b' })]).rfx;
    r = removeLine(r, 'CAR-01').rfx;
    r = addLines(r, [line({ description: 'c' })]).rfx;
    expect(r.lines.map((l) => l.code)).toEqual(['CAR-02', 'CAR-03']);
  });

  it('updates and clears fields, and reports an unknown code instead of changing anything', () => {
    const r = addLines(emptyRfx(), [line({ spec: 'BF 22' })]).rfx;
    const u = updateLine(r, 'CAR-01', { annual_qty: 5000, spec: null, uom: 'boxes', pack_size: 50 });
    expect(u.rfx.lines[0]).toMatchObject({ annual_qty: 5000, spec: null, uom: 'boxes', pack_size: 50 });
    const bad = updateLine(r, 'NOPE', { annual_qty: 1 });
    expect(bad.error).toMatch(/No line with code NOPE/);
    expect(bad.rfx).toBe(r);
    expect(removeLine(r, 'NOPE').error).toBeTruthy();
  });

  it('does not mutate the RFx it was given', () => {
    const r = good();
    const snap = JSON.stringify(r);
    addLines(r, [line({ description: 'x' })]);
    updateLine(r, 'CAR-01', { annual_qty: 7 });
    removeLine(r, 'CAR-01');
    setTerms(r, { payment_terms_days: 10 });
    addQuestions(r, [{ text: 'x' }]);
    setKnockout(r, 'Q1', false);
    expect(JSON.stringify(r)).toBe(snap);
  });

  it('caps lines and questions and says what was skipped', () => {
    const many = Array.from({ length: 65 }, (_, i) => line({ description: `item ${i}` }));
    const a = addLines(emptyRfx(), many);
    expect(a.rfx.lines).toHaveLength(60);
    expect(a.result.skipped).toHaveLength(5);
    const qs = addQuestions(emptyRfx(), Array.from({ length: 32 }, (_, i) => ({ text: `q${i}` })));
    expect(qs.rfx.questions).toHaveLength(30);
    expect(qs.result.skipped).toHaveLength(2);
  });

  it('sets terms, trimming blanks to null, and only touches the fields given', () => {
    const r = setTerms(emptyRfx(), { payment_terms_days: 30, delivery_location: '  ' });
    expect(r.rfx.terms.payment_terms_days).toBe(30);
    expect(r.rfx.terms.delivery_location).toBeNull();
    expect(r.rfx.terms.currency).toBe('INR');
    expect(r.result.changed).toEqual(['payment_terms_days', 'delivery_location']);
  });

  it('sets and clears a knockout with its rule', () => {
    const r = addQuestions(emptyRfx(), [{ text: 'Rejection rate', answer_type: 'number' }]).rfx;
    const on = setKnockout(r, 'Q1', true, { op: 'lte', value: 2 });
    expect(on.rfx.questions[0]).toMatchObject({ is_knockout: true, pass_rule: { op: 'lte', value: 2 } });
    expect(on.result).toMatchObject({ pass_rule: 'At most 2' });
    const off = setKnockout(on.rfx, 'Q1', false);
    expect(off.rfx.questions[0]?.is_knockout).toBe(false);
    expect(off.rfx.questions[0]?.pass_rule).toEqual({ op: 'lte', value: 2 });
    expect(setKnockout(r, 'Q9', true).error).toMatch(/No question/);
  });

  it('labels a unit with its pack size', () => {
    expect(unitLabel({ uom: 'boxes', pack_size: 100 })).toBe('boxes (100 per box)');
    expect(unitLabel({ uom: 'piece', pack_size: null })).toBe('piece');
    expect(unitLabel({ uom: null, pack_size: null })).toBe('Not set');
  });
});
