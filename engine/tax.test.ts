import { describe, expect, it } from 'vitest';
import { normalizePrice } from './convert';
import { recomputeLine, type StoredLine } from './recompute';
import { resolveTax, taxStatements } from './tax';

const base: StoredLine = {
  price: 100, currency: 'INR', uom_text: 'per piece', per_n: 1, tax_basis: 'unknown', inherits_last_year: false, base_uom: 'piece', last_year_rate_inr: 95,
  unit_definitions: [], read_confidence: 'high', match_confidence: 0.95, source_type: 'email', evidence_quote: 'Item - 100 per piece', evidence_locator: 'L2', sticky_flags: [], overrides: {},
  conditions: [], annual_qty: 1000, rfx_text: 'Test item', vendor_notes: [],
};
const a = { usd_inr: 96, gst_pct: 18 };

describe('reading tax statements', () => {
  it.each([
    ['GST included (5%)', 'incl', 5],
    ['inclusive of GST @ 18%', 'incl', 18],
    ['incl. GST', 'incl', null],
    ['price includes 12.5 percent GST, delivered', 'incl', 12.5],
    ['GST extra', 'excl', null],
    ['+ GST as applicable', 'excl', null],
    ['excl. GST', 'excl', null],
    ['GST 18% extra', 'excl', null],
  ])('%s', (text, basis, rate) => {
    const s = taxStatements(text);
    expect(s[0]?.basis).toBe(basis);
    expect(s[0]?.rate_pct).toBe(rate);
  });
  it('does not read freight or packing words as a tax statement', () => {
    expect(taxStatements('Freight extra, packing included')).toEqual([]);
    expect(taxStatements('GST included, freight extra').map((s) => s.basis)).toEqual(['incl']);
  });
  it('a discount threshold stated excl GST is not a statement about the price', () => {
    expect(taxStatements('3% discount if single PO above Rs 10,00,000 excl. GST')).toEqual([]);
  });
});

describe('inclusive prices are divided by the STATED rate (G1)', () => {
  it('100 including 5 percent becomes 95.24, not 100 / 1.18', () => {
    const r = recomputeLine({ ...base, conditions: ['GST included (5%)'] }, a);
    expect(r.normalized_inr).toBeCloseTo(100 / 1.05, 10);
    expect(r.normalized_inr?.toFixed(2)).toBe('95.24');
    expect(r.steps.map((s) => s.factor)).toEqual([1.05]);
    expect(r.steps[0]?.reason).toMatch(/vendor's stated 5 percent/);
    expect(r.assumption_keys).not.toContain('gst_pct');
    expect(r.status).toBe('confirmed');
    expect(r.tax).toMatchObject({ basis: 'incl_gst', rate_pct: 5, source: 'line' });
  });
  it('a stated rate is not moved by the GST assumption', () => {
    const r = recomputeLine({ ...base, conditions: ['GST included (5%)'] }, { ...a, gst_pct: 28 });
    expect(r.normalized_inr).toBeCloseTo(100 / 1.05, 10);
  });
  it('inclusive with no rate uses the default and is Assumed, naming the assumption', () => {
    const r = recomputeLine({ ...base, conditions: ['rate is inclusive of GST'] }, a);
    expect(r.normalized_inr).toBeCloseTo(100 / 1.18, 10);
    expect(r.assumption_keys).toContain('gst_pct');
    expect(r.steps[0]?.reason).toMatch(/assumed 18 percent/);
    expect(r.status).toBe('assumed');
  });
  it('a document level inclusive basis with a rate in the notes uses that rate', () => {
    const r = recomputeLine({ ...base, tax_basis: 'incl_gst', vendor_notes: ['All prices include GST at 28%.'] }, a);
    expect(r.normalized_inr).toBeCloseTo(100 / 1.28, 10);
  });
  it('a document level inclusive basis with no rate anywhere is the old behaviour, unchanged', () => {
    const r = recomputeLine({ ...base, tax_basis: 'incl_gst' }, a);
    expect(r.normalized_inr).toBeCloseTo(100 / 1.18, 10);
    expect(r.assumption_keys).toEqual(['gst_pct']);
  });
  it('normalizePrice itself takes the stated rate', () => {
    const n = normalizePrice({ price: 210, currency: 'INR', uom_text: 'each', tax_basis: 'incl_gst', gst_rate_pct: 5, base_uom: 'piece', last_year_rate_inr: null }, a);
    expect(n.ok && n.value_inr).toBeCloseTo(200, 10);
  });
});

describe('the tax basis shown (G1 c)', () => {
  it('a line that states GST extra is read as stated; the status is unchanged from before (still Assumed while the document basis is unknown)', () => {
    const r = recomputeLine({ ...base, conditions: ['GST extra'] }, a);
    expect(r.tax).toMatchObject({ basis: 'excl_gst', source: 'line' });
    expect(r.assumption_keys).toContain('tax_basis_assumed_excl');
    expect(r.normalized_inr).toBe(100);
  });
  it('a line that states GST extra under a document basis of excl is Confirmed as before', () => {
    expect(recomputeLine({ ...base, tax_basis: 'excl_gst', conditions: ['GST extra'] }, a).status).toBe('confirmed');
  });
  it('an inclusive line is never also marked as an assumed exclusive one', () => {
    expect(recomputeLine({ ...base, conditions: ['GST included (5%)'] }, a).assumption_keys).not.toContain('tax_basis_assumed_excl');
  });
  it('no statement anywhere keeps the existing assumption', () => {
    const r = recomputeLine(base, a);
    expect(r.assumption_keys).toContain('tax_basis_assumed_excl');
    expect(r.status).toBe('assumed');
  });
});

describe('conflicting tax statements (G1 d, e)', () => {
  const notes = ['All rates GST extra. Correction later: the item rates now include GST at 5%.'];
  const line: StoredLine = { ...base, conditions: ['GST included 5% per correction'], vendor_notes: notes };

  it('converts at the stated rate, shows the factor, and is never Confirmed', () => {
    const r = recomputeLine(line, a);
    expect(r.normalized_inr).toBeCloseTo(100 / 1.05, 10);
    expect(r.steps.map((s) => s.factor)).toEqual([1.05]);
    expect(r.status).toBe('assumed');
    expect(r.flags).toContain('tax_conflict');
    expect(r.assumption_keys).toContain('tax_basis_conflict');
    expect(r.reasons.join(' ')).toMatch(/Conflicting tax statements: "All rates GST extra" and "GST included 5% per correction"/);
  });
  it('a buyer "accept as read" does not settle it: still Assumed, key not accepted', () => {
    const r = recomputeLine({ ...line, overrides: { verified: true } }, a);
    expect(r.status).toBe('assumed');
    expect(r.accepted_keys).not.toContain('tax_basis_conflict');
    expect(r.reasons.join(' ')).toMatch(/still conflict/);
  });
  it('a line with no statement of its own under a conflicting document is capped too', () => {
    const r = recomputeLine({ ...base, vendor_notes: notes }, a);
    expect(r.flags).toContain('tax_conflict');
    expect(r.status).toBe('assumed');
    expect(r.normalized_inr).toBe(100);
  });
  it('a line that agrees with the blanket statement is not touched by the conflict', () => {
    const r = recomputeLine({ ...base, conditions: ['GST extra'], vendor_notes: notes }, a);
    expect(r.flags).not.toContain('tax_conflict');
    expect(r.assumption_keys).not.toContain('tax_basis_conflict');
  });
  it('the document basis against a line is also a conflict', () => {
    const r = recomputeLine({ ...base, tax_basis: 'excl_gst', conditions: ['GST included (12%)'] }, a);
    expect(r.flags).toContain('tax_conflict');
    expect(r.normalized_inr).toBeCloseTo(100 / 1.12, 10);
  });
  it('a line that says both included and extra has no converted price and is Needs review, even after a buyer check', () => {
    const c = { ...base, conditions: ['GST included', 'GST extra'] };
    for (const overrides of [{}, { verified: true }]) {
      const r = recomputeLine({ ...c, overrides }, a);
      expect(r.normalized_inr).toBeNull();
      expect(r.status).toBe('needs_review');
      expect(r.flags).toContain('tax_unresolved');
      expect(r.reasons.join(' ')).toMatch(/never be shown as an excluding GST price/);
    }
  });
});

describe('resolveTax on its own', () => {
  it('agreeing statements are not a conflict', () => {
    expect(resolveTax({ doc_basis: 'excl_gst', conditions: ['GST extra'], notes: ['All rates plus GST.'] }).conflict).toBeNull();
  });
  it('stored comparison shape: document excl, a discount condition with excl GST, no notes about tax', () => {
    const r = resolveTax({ doc_basis: 'excl_gst', conditions: ['4% discount if single PO above Rs. 25,00,000 excl. GST'], notes: ['Freight extra'] });
    expect(r).toMatchObject({ basis: 'excl_gst', source: 'document', conflict: null });
  });
});
