// Re-derives every cell in the browser with the same engine function the server
// uses, so an FX or GST edit, or a correction, shows at once. The server persists
// the change and its own result replaces this one when it returns.
import { certaintyCounts, toCellStatus } from '../../engine/certainty';
import { recomputeLine, type LineOverrides, type StoredLine } from '../../engine/recompute';
import type { Assumptions, BaseUom } from '../../engine/types';
import type { CompareResponse, GridCell, VendorHeader } from './api-types';

export type Patches = Record<string, LineOverrides>;

export function deriveCell(cell: GridCell, base: { uom: string; ly: number | null }, a: Assumptions, patch?: LineOverrides): GridCell {
  const raw = cell.raw;
  if (!raw || !cell.quote_line_id) return cell;
  const overrides = (patch ?? raw.overrides) as LineOverrides;
  if (overrides.not_quoted) {
    return { ...cell, price: null, status: 'missing', flags: [], assumption_keys: [], buyer_verified: false, raw: { ...raw, overrides } };
  }
  const stored: StoredLine = {
    price: cell.quoted_price,
    currency: cell.quoted_currency,
    uom_text: cell.quoted_uom,
    per_n: raw.per_n,
    tax_basis: raw.tax_basis,
    inherits_last_year: raw.inherits_last_year,
    base_uom: base.uom as BaseUom,
    last_year_rate_inr: base.ly,
    unit_definitions: raw.unit_definitions,
    read_confidence: raw.read_confidence,
    match_confidence: raw.match_confidence,
    source_type: (cell.source_type ?? 'xlsx') as StoredLine['source_type'],
    evidence_quote: raw.evidence_quote,
    evidence_locator: raw.evidence_locator,
    sticky_flags: raw.sticky_flags,
    overrides,
  };
  const r = recomputeLine(stored, a);
  return {
    ...cell,
    price: r.normalized_inr,
    // A cross document conflict is decided on the server; keep it until the server answers.
    status: cell.status === 'conflict' && patch === undefined ? 'conflict' : toCellStatus(r.status),
    flags: r.flags,
    assumption_keys: r.assumption_keys,
    buyer_verified: r.buyer_verified,
    confidence: r.confidence,
    raw: { ...raw, overrides },
  };
}

export function deriveAll(d: CompareResponse, a: Assumptions, patches: Patches): CompareResponse {
  const lineById = new Map(d.lines.map((l) => [l.id, l]));
  const cells = d.cells.map((c) => {
    const l = lineById.get(c.rfx_line_id);
    if (!l) return c;
    return deriveCell(c, { uom: l.uom, ly: l.ly_rate }, a, c.quote_line_id ? patches[c.quote_line_id] : undefined);
  });
  const vendors: VendorHeader[] = d.vendors.map((v) => {
    const mine = cells.filter((c) => c.vendor_id === v.id);
    const counts = certaintyCounts(mine.map((c) => c.status));
    return {
      ...v,
      coverage: { quoted: mine.filter((c) => c.price != null).length, total: mine.length },
      counts: { confirmed: counts.confirmed, assumed: counts.assumed, needs_review: counts.needs_review, conflict: counts.conflict, missing: counts.missing },
    };
  });
  return { ...d, cells, vendors, certainty: certaintyCounts(cells.map((c) => c.status)) };
}

export type CellChange = { vendor_key: string; code: string; before: number | null; after: number | null; status_before: string; status_after: string };

/** What moved between two derivations, for the "recomputed N cells" summary. */
export function diffCells(before: CompareResponse, after: CompareResponse): CellChange[] {
  const vendorKey = new Map(before.vendors.map((v) => [v.id, v.key]));
  const codeOf = new Map(before.lines.map((l) => [l.id, l.code]));
  const prior = new Map(before.cells.map((c) => [`${c.vendor_id}:${c.rfx_line_id}`, c]));
  const out: CellChange[] = [];
  for (const c of after.cells) {
    const b = prior.get(`${c.vendor_id}:${c.rfx_line_id}`);
    if (!b) continue;
    const moved = (b.price ?? null) !== (c.price ?? null) && Math.abs((b.price ?? 0) - (c.price ?? 0)) > 1e-9;
    if (moved || b.status !== c.status) {
      out.push({ vendor_key: vendorKey.get(c.vendor_id) ?? '', code: codeOf.get(c.rfx_line_id) ?? '', before: b.price, after: c.price, status_before: b.status, status_after: c.status });
    }
  }
  return out;
}
