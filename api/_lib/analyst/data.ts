// Loads what the analyst tools need: the comparison payload (the same one the grid uses),
// open review items, and the award input derived from them at a given set of assumptions.
import type pg from 'pg';
import type { AwardInput } from '../../../engine/award.js';
import type { Assumptions } from '../../../engine/types.js';
import type { CompareResponse } from '../../../src/lib/api-types.js';
import { deriveAll } from '../../../src/lib/derive.js';
import { loadCompare } from '../compare/data.js';

export type OpenItemRow = {
  id: string;
  vendor_id: string;
  quote_line_id: string | null;
  line_code: string | null;
  kind: string;
  severity: 'info' | 'warn' | 'block';
  message: string;
  value_at_stake_inr: number | null;
};

export type AnalystData = { compare: CompareResponse; items: OpenItemRow[] };

/** Vendor text must never reach the model as something that reads like an instruction. */
const SUSPICIOUS_KINDS = ['suspicious_content', 'low_visibility_text'];

export function safeMessage(kind: string, message: string): string {
  if (SUSPICIOUS_KINDS.includes(kind)) {
    const where = /\(([^)]{1,60})\)/.exec(message)?.[1];
    return `Instruction-like text was found in a vendor document${where ? ` (${where})` : ''}. It was ignored and flagged for the buyer. Its content is not shown here.`;
  }
  return message.length > 400 ? `${message.slice(0, 400)}...` : message;
}

export async function loadAnalystData(pool: pg.Pool): Promise<AnalystData> {
  const [compare, items] = await Promise.all([
    loadCompare(pool),
    pool.query<{
      id: string; vendor_id: string; quote_line_id: string | null; line_code: string | null; kind: string; severity: 'info' | 'warn' | 'block'; message: string; value: string | null;
    }>(
      `select i.id, i.vendor_id, i.quote_line_id, l.code as line_code, i.kind, i.severity, i.message, i.value_at_stake_inr as value
       from review_items i left join quote_lines q on q.id = i.quote_line_id left join rfx_lines l on l.id = q.rfx_line_id
       where i.state = 'open' order by i.created_at`,
    ),
  ]);
  return {
    compare,
    items: items.rows.map((r) => ({
      id: r.id, vendor_id: r.vendor_id, quote_line_id: r.quote_line_id, line_code: r.line_code, kind: r.kind, severity: r.severity,
      message: safeMessage(r.kind, r.message), value_at_stake_inr: r.value == null ? null : Number(r.value),
    })),
  };
}

export function globalAssumptions(c: CompareResponse): Assumptions {
  const g = (k: string, d: number) => Number(c.assumptions.find((a) => a.key === k)?.value ?? d);
  return { usd_inr: g('usd_inr', 96), gst_pct: g('gst_pct', 18) };
}

/** The award input at the given assumptions. Cells are re-derived with the same engine function the grid uses. */
export function buildAwardInput(data: AnalystData, a: Assumptions): AwardInput {
  const derived = deriveAll(data.compare, a, {});
  const itemsByVendor = new Map<string, AwardInput['vendors'][number]['open_items']>();
  for (const i of data.items) {
    // Per cell Assumed entries are not review items; line level kinds are judged from the cells themselves.
    itemsByVendor.set(i.vendor_id, [...(itemsByVendor.get(i.vendor_id) ?? []), { kind: i.kind, severity: i.severity, message: i.message }]);
  }
  return {
    vendors: derived.vendors.map((v) => ({
      id: v.id,
      key: v.key,
      name: v.name,
      questionnaire: v.questionnaire,
      freight: { terms: v.freight_terms, amount_inr: v.freight_amount_inr },
      discounts: v.discounts.map((d) => ({ id: d.id, percent: d.percent, condition: d.condition, text: d.text })),
      open_items: itemsByVendor.get(v.id) ?? [],
    })),
    lines: derived.lines.map((l) => ({ id: l.id, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, ly_rate: l.ly_rate, sort: l.sort })),
    cells: derived.cells.map((c) => ({ vendor_id: c.vendor_id, line_id: c.rfx_line_id, quote_line_id: c.quote_line_id, price: c.price, status: c.status, conditions: c.conditions })),
  };
}

/** Resolves "V3", "vendor 3", "Sunrise" or "Kaveri Packaging" to a vendor key. Null when nothing matches. */
export function resolveVendor(c: CompareResponse, ref: string): string | null {
  const t = ref.trim().toLowerCase();
  const num = /^(?:v|vendor)\s*#?\s*(\d)$/.exec(t);
  if (num) {
    const k = `V${num[1]}`;
    return c.vendors.some((v) => v.key === k) ? k : null;
  }
  const exact = c.vendors.find((v) => v.key.toLowerCase() === t);
  if (exact) return exact.key;
  const hits = c.vendors.filter((v) => v.name.toLowerCase().includes(t) || t.includes(v.name.toLowerCase().split(' ')[0] ?? '@@'));
  return hits.length === 1 ? (hits[0] as { key: string }).key : null;
}
