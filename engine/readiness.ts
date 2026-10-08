// Decision readiness, judged per scenario and only for the vendors included in it (owner rule,
// 2026-10-08). Not ready only if an included vendor has an unresolved Conflict, a Needs review
// cell or a pending knockout. Everything else open is listed as an open item.
// A failed knockout on a vendor that is actually in the award also blocks: calling an award to
// a vendor who failed "ready with open items" would mislead (DECISIONS D42).
import type { Freight } from './totals';

export type Questionnaire = 'Cleared' | 'Failed' | 'Pending' | null;
export type OpenItemInput = { kind: string; severity: 'info' | 'warn' | 'block'; message: string };

export type ReadinessVendor = {
  key: string;
  questionnaire: Questionnaire;
  needs_review: number;
  conflict: number;
  /** True when the vendor holds part of the award being judged. Always false for a plain comparison. */
  in_award: boolean;
  freight: Freight;
  open_items: OpenItemInput[];
};

export type ScenarioReadiness = {
  level: 'ready' | 'ready_with_open_items' | 'not_ready';
  label: 'Ready' | 'Ready with open items' | 'Not ready';
  included_vendors: string[];
  blockers: { vendor_key: string; kind: string; message: string }[];
  open_items: { vendor_key: string | null; kind: string; message: string }[];
  summary: string;
};

/** The two ways a vendor document can carry an injection attempt. One document with both is one open item, not two. */
export const HIDDEN_CONTENT_KINDS = ['suspicious_content', 'low_visibility_text'];
export const HIDDEN_CONTENT_KIND = 'hidden_instructions';
export const HIDDEN_CONTENT_MESSAGE = 'A vendor document contained near invisible text and instruction like text. Both were ignored.';

/** Replaces a vendor's near invisible text item and instruction like text item with one item. A vendor with only one of them is left alone. */
export function mergeHiddenContent<T extends { vendor_key: string | null; kind: string }>(items: T[], merged: (vendor_key: string | null) => T): T[] {
  const vendors = new Set(items.filter((i) => HIDDEN_CONTENT_KINDS.includes(i.kind)).map((i) => i.vendor_key));
  const both = [...vendors].filter((v) => HIDDEN_CONTENT_KINDS.every((k) => items.some((i) => i.vendor_key === v && i.kind === k)));
  if (both.length === 0) return items;
  const out: T[] = [];
  const done = new Set<string | null>();
  for (const i of items) {
    if (HIDDEN_CONTENT_KINDS.includes(i.kind) && both.includes(i.vendor_key)) {
      if (!done.has(i.vendor_key)) {
        done.add(i.vendor_key);
        out.push(merged(i.vendor_key));
      }
    } else out.push(i);
  }
  return out;
}

/** Kinds already judged from the cells and the questionnaire, so they are not listed twice. */
const JUDGED_ELSEWHERE = ['knockout_pending', 'line_needs_review', 'conflict'];

export function judgeScenario(included: ReadinessVendor[], extras: { assumed_cells: number; gaps: number }): ScenarioReadiness {
  const blockers: ScenarioReadiness['blockers'] = [];
  const open: ScenarioReadiness['open_items'] = [];
  for (const v of included) {
    if (v.needs_review > 0) blockers.push({ vendor_key: v.key, kind: 'line_needs_review', message: `${v.needs_review} ${v.needs_review === 1 ? 'cell needs' : 'cells need'} review.` });
    if (v.conflict > 0) blockers.push({ vendor_key: v.key, kind: 'conflict', message: `${v.conflict} ${v.conflict === 1 ? 'cell is' : 'cells are'} in conflict.` });
    if (v.questionnaire === 'Pending') blockers.push({ vendor_key: v.key, kind: 'knockout_pending', message: 'A knockout question is undecided.' });
    if (v.questionnaire === 'Failed' && v.in_award) blockers.push({ vendor_key: v.key, kind: 'knockout_failed', message: 'The vendor failed a knockout and is in the award.' });
    for (const i of v.open_items) {
      if (i.severity === 'info' || JUDGED_ELSEWHERE.includes(i.kind)) continue;
      open.push({ vendor_key: v.key, kind: i.kind, message: i.message });
    }
    if (v.freight.terms === 'extra' && v.freight.amount_inr == null && !v.open_items.some((i) => i.kind === 'freight_amount_unknown')) {
      open.push({ vendor_key: v.key, kind: 'freight_amount_unknown', message: 'Freight is extra with no amount stated.' });
    }
  }
  if (extras.assumed_cells > 0) open.push({ vendor_key: null, kind: 'assumed_cells', message: `${extras.assumed_cells} ${extras.assumed_cells === 1 ? 'cell is' : 'cells are'} Assumed.` });
  if (extras.gaps > 0) open.push({ vendor_key: null, kind: 'coverage_gaps', message: `${extras.gaps} ${extras.gaps === 1 ? 'line is' : 'lines are'} not covered.` });
  open.splice(0, open.length, ...mergeHiddenContent(open, (vendor_key) => ({ vendor_key, kind: HIDDEN_CONTENT_KIND, message: HIDDEN_CONTENT_MESSAGE })));
  const level: ScenarioReadiness['level'] = blockers.length > 0 ? 'not_ready' : open.length > 0 ? 'ready_with_open_items' : 'ready';
  return {
    level,
    label: level === 'not_ready' ? 'Not ready' : level === 'ready' ? 'Ready' : 'Ready with open items',
    included_vendors: included.map((v) => v.key),
    blockers,
    open_items: open,
    summary:
      level === 'not_ready'
        ? `${blockers.length} ${blockers.length === 1 ? 'blocker' : 'blockers'} among the included vendors.`
        : level === 'ready'
          ? 'Nothing is open for the included vendors.'
          : `${open.length} open ${open.length === 1 ? 'item' : 'items'} to close before a PO goes out.`,
  };
}
