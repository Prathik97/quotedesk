import { describe, expect, it } from 'vitest';
import type { CompareResponse, GridCell } from './api-types';
import { deriveAll, diffCells } from './derive';

// A tiny fixture: one USD line from V5, one INR line from V1 and one line V3 did not quote.
const usdCell: GridCell = {
  vendor_id: 'v5', rfx_line_id: 'l1', quote_line_id: 'q1', price: 122.88, status: 'assumed', flags: [], assumption_keys: ['usd_inr'],
  quoted_price: 1.28, quoted_uom: 'per kg', quoted_currency: 'USD', conditions: [], source_type: 'email', buyer_verified: false, confidence: 0.95,
  raw: { per_n: 1, tax_basis: 'excl_gst', inherits_last_year: false, read_confidence: 'high', match_confidence: 0.95, evidence_quote: 'USD 1.28 per kg', evidence_locator: 'L8', sticky_flags: [], overrides: {}, unit_definitions: [] },
};
const inrCell: GridCell = {
  vendor_id: 'v1', rfx_line_id: 'l1', quote_line_id: 'q2', price: 120, status: 'confirmed', flags: [], assumption_keys: [],
  quoted_price: 120, quoted_uom: 'per kg', quoted_currency: 'INR', conditions: [], source_type: 'xlsx', buyer_verified: false, confidence: 0.95,
  raw: { per_n: 1, tax_basis: 'excl_gst', inherits_last_year: false, read_confidence: 'high', match_confidence: 0.95, evidence_quote: 'C3: 120', evidence_locator: "Sheet 'A'!C3", sticky_flags: [], overrides: {}, unit_definitions: [] },
};
const missing: GridCell = { vendor_id: 'v3', rfx_line_id: 'l1', quote_line_id: null, price: null, status: 'missing', flags: [], assumption_keys: [], quoted_price: null, quoted_uom: null, quoted_currency: null, conditions: [], source_type: null, buyer_verified: false, confidence: null, raw: null };

const base = {
  lines: [{ id: 'l1', code: 'FLM-STR-01', section: 's', description: 'd', spec: null, uom: 'kg', annual_qty: 1000, ly_rate: 120, is_one_time: false, sort: 1 }],
  vendors: ['v1', 'v3', 'v5'].map((id) => ({ id, key: id.toUpperCase(), counts: { confirmed: 0, assumed: 0, needs_review: 0, conflict: 0, missing: 0 }, coverage: { quoted: 0, total: 1 } })),
  cells: [usdCell, inrCell, missing],
} as unknown as CompareResponse;

describe('deriveAll', () => {
  it('changes only the USD cell when FX moves from 96 to 90', () => {
    const before = deriveAll(base, { usd_inr: 96, gst_pct: 18 }, {});
    const after = deriveAll(base, { usd_inr: 90, gst_pct: 18 }, {});
    const changes = diffCells(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ vendor_key: 'V5', code: 'FLM-STR-01' });
    expect(changes[0]?.before).toBeCloseTo(122.88, 10);
    expect(changes[0]?.after).toBeCloseTo(115.2, 10);
  });

  it('leaves a Not quoted cell alone and never turns it into a number', () => {
    const out = deriveAll(base, { usd_inr: 50, gst_pct: 18 }, {});
    expect(out.cells[2]?.price).toBeNull();
    expect(out.cells[2]?.status).toBe('missing');
  });

  it('updates certainty counts and coverage from the derived cells', () => {
    const out = deriveAll(base, { usd_inr: 96, gst_pct: 18 }, {});
    expect(out.certainty).toMatchObject({ confirmed: 1, assumed: 1, missing: 1, total: 3 });
    expect(out.vendors.find((v) => v.id === 'v3')?.coverage.quoted).toBe(0);
    expect(out.vendors.find((v) => v.id === 'v5')?.coverage.quoted).toBe(1);
  });

  it('applies a correction patch: edit the value and the cell is confirmed by the buyer', () => {
    const out = deriveAll(base, { usd_inr: 96, gst_pct: 18 }, { q2: { verified: true, price: 125 } });
    expect(out.cells[1]?.price).toBe(125);
    expect(out.cells[1]?.buyer_verified).toBe(true);
    expect(out.cells[1]?.flags).toContain('buyer_edited');
  });

  it('marking a line not quoted removes the price and counts it as Not quoted', () => {
    const out = deriveAll(base, { usd_inr: 96, gst_pct: 18 }, { q2: { not_quoted: true } });
    expect(out.cells[1]?.price).toBeNull();
    expect(out.cells[1]?.status).toBe('missing');
    expect(out.certainty.missing).toBe(2);
  });
});
