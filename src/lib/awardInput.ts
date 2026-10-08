// Builds the award engine's input from the comparison payload. Used by the Decision page in the
// browser and by the analyst tools and the decision memo on the server, so every surface runs the
// same engine over the same cells. Pure: no I/O, no model.
import type { AwardInput } from '../../engine/award';
import type { OpenItemInput } from '../../engine/readiness';
import type { Assumptions } from '../../engine/types';
import type { CompareResponse } from './api-types';
import { deriveAll } from './derive';

/** Vendor text must never reach a model, and a memo should not repeat an injected sentence either. */
const SUSPICIOUS_KINDS = ['suspicious_content', 'low_visibility_text'];

export function safeMessage(kind: string, message: string): string {
  if (SUSPICIOUS_KINDS.includes(kind)) {
    const where = /\(([^)]{1,60})\)/.exec(message)?.[1];
    return `Instruction-like text was found in a vendor document${where ? ` (${where})` : ''}. It was ignored and flagged for the buyer. Its content is not shown here.`;
  }
  return message.length > 400 ? `${message.slice(0, 400)}...` : message;
}

export type RawOpenItem = { vendor_id?: string | null; vendor_key?: string | null; kind: string; severity: 'info' | 'warn' | 'block'; message: string };

/**
 * The award input at the given assumptions. Cells are re-derived with the same engine function the
 * grid uses, so a different USD rate gives the prices the grid would show at that rate.
 * Item messages are scrubbed of vendor instruction text on the way in.
 */
export function awardInputFromCompare(c: CompareResponse, a: Assumptions, items: RawOpenItem[]): AwardInput {
  const derived = deriveAll(c, a, {});
  const idOfKey = new Map(c.vendors.map((v) => [v.key, v.id]));
  const byVendor = new Map<string, OpenItemInput[]>();
  for (const i of items) {
    const id = i.vendor_id ?? (i.vendor_key ? idOfKey.get(i.vendor_key) : undefined);
    if (!id) continue;
    byVendor.set(id, [...(byVendor.get(id) ?? []), { kind: i.kind, severity: i.severity, message: safeMessage(i.kind, i.message) }]);
  }
  return {
    vendors: derived.vendors.map((v) => ({
      id: v.id,
      key: v.key,
      name: v.name,
      questionnaire: v.questionnaire,
      freight: { terms: v.freight_terms, amount_inr: v.freight_amount_inr },
      discounts: v.discounts.map((d) => ({ id: d.id, percent: d.percent, condition: d.condition, text: d.text })),
      open_items: byVendor.get(v.id) ?? [],
    })),
    lines: derived.lines.map((l) => ({ id: l.id, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, ly_rate: l.ly_rate, sort: l.sort })),
    cells: derived.cells.map((c2) => ({ vendor_id: c2.vendor_id, line_id: c2.rfx_line_id, quote_line_id: c2.quote_line_id, price: c2.price, status: c2.status, conditions: c2.conditions })),
  };
}

export function globalAssumptionsOf(c: CompareResponse): Assumptions {
  const g = (k: string, d: number) => Number(c.assumptions.find((a) => a.key === k)?.value ?? d);
  return { usd_inr: g('usd_inr', 96), gst_pct: g('gst_pct', 18) };
}
