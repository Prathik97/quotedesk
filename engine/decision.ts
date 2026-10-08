// Deterministic sensitivity for a scenario (FR-8.1). Every figure comes from re running the award
// engine; nothing here is estimated or typed by a model.
//
//   1. total cost with the USD rate at 85, 96 and 105, with and without the conditional discount
//   2. the cost if the top vendor is lost (the same scenario re run without that vendor)
import { AwardError, simulateAward, type AwardInput, type AwardResult, type Scenario } from './award';
import { formatIndian } from './format';
import type { Assumptions } from './types';

export const FX_SWEEP = [85, 96, 105];

export type SensitivityCell = {
  ok: boolean;
  error: string | null;
  goods_inr: number;
  landed_inr: number;
  landed_complete: boolean;
  lines_awarded: number;
  lines_total: number;
};

export type FxRow = { usd_inr: number; is_current: boolean; without_discount: SensitivityCell; with_discount: SensitivityCell };

export type TopVendorLost = {
  vendor_key: string;
  vendor_name: string;
  share_pct: number;
  /** Set when the scenario's own strategy cannot run without this vendor and a different strategy was used instead. */
  strategy_note: string | null;
  cell: SensitivityCell;
  /** Goods total without the vendor less the base goods total. Null when the two do not cover the same lines. */
  goods_delta_inr: number | null;
  goods_delta_pct: number | null;
  like_for_like: boolean;
  new_top_vendor: string | null;
  lines_uncovered: string[];
  readiness_label: string | null;
  note: string;
};

export type Sensitivity = {
  assumptions: Assumptions;
  fx: FxRow[];
  /** Whether the USD rate moves this scenario's total, in words. */
  fx_note: string;
  /** True when at least one eligible vendor has a conditional discount, so the two columns can differ. */
  discount_in_play: boolean;
  discount_note: string;
  /** One sentence, built from the two runs, saying the with discount column is a different allocation. Null when the discount changes nothing. */
  with_discount_note: string | null;
  top_vendor_lost: TopVendorLost | null;
};

/**
 * The with discount column is not the no discount allocation at lower prices: the discount changes who wins some lines,
 * and the vendor's PO then clears its threshold. Every figure in the sentence comes from the two runs.
 */
function withDiscountNote(input: AwardInput, scenario: Scenario): string | null {
  let off: AwardResult;
  let on: AwardResult;
  try {
    off = simulateAward(input, { ...scenario, filters: { ...scenario.filters, apply_discounts: false } });
    on = simulateAward(input, { ...scenario, filters: { ...scenario.filters, apply_discounts: true } });
  } catch (e) {
    if (e instanceof AwardError) return null;
    throw e;
  }
  const d = on.discounts.find((x) => x.applied && x.threshold_inr != null && x.saving_inr > 0.005);
  if (!d || on.totals.goods_total_inr >= off.totals.goods_total_inr - 0.005) return null;
  const offWinner = new Map(off.allocation.map((a) => [a.line_code, a.vendor_key]));
  const gained = on.allocation.filter((a) => a.vendor_key === d.vendor_key && offWinner.get(a.line_code) !== d.vendor_key).map((a) => a.line_code);
  if (gained.length === 0) return null;
  const shown = gained.length > 6 ? `${gained.slice(0, 6).join(', ')} and ${gained.length - 6} more` : gained.join(', ');
  return `The with discount column is a different allocation, not the same one at lower prices: at the current rate ${d.vendor_key} wins ${gained.length} more ${gained.length === 1 ? 'line' : 'lines'} (${shown}), its PO of Rs ${formatIndian(d.vendor_po_value_inr, 0)} clears the Rs ${formatIndian(d.threshold_inr as number, 0)} threshold, and the ${d.percent} percent discount then applies, which lowers the goods total by Rs ${formatIndian(off.totals.goods_total_inr - on.totals.goods_total_inr, 0)}.`;
}

function cellOf(input: AwardInput, s: Scenario): { cell: SensitivityCell; result: AwardResult | null } {
  try {
    const r = simulateAward(input, s);
    return {
      result: r,
      cell: { ok: true, error: null, goods_inr: r.totals.goods_total_inr, landed_inr: r.totals.landed_total_inr, landed_complete: r.totals.landed_complete, lines_awarded: r.totals.lines_awarded, lines_total: r.totals.lines_total },
    };
  } catch (e) {
    if (e instanceof AwardError) {
      return { result: null, cell: { ok: false, error: e.message, goods_inr: 0, landed_inr: 0, landed_complete: false, lines_awarded: 0, lines_total: 0 } };
    }
    throw e;
  }
}

/**
 * @param makeInput builds the award input at a set of assumptions (the cells are re derived at that USD rate)
 * @param current the assumptions in force; the sweep always includes the current USD rate
 * @param base the already computed result of `scenario` at `current`
 */
export function runSensitivity(makeInput: (a: Assumptions) => AwardInput, current: Assumptions, scenario: Scenario, base: AwardResult): Sensitivity {
  const rates = [...new Set([...FX_SWEEP, current.usd_inr])].sort((a, b) => a - b);
  const fx: FxRow[] = rates.map((usd) => {
    const input = makeInput({ ...current, usd_inr: usd });
    const off = cellOf(input, { ...scenario, filters: { ...scenario.filters, apply_discounts: false } }).cell;
    const on = cellOf(input, { ...scenario, filters: { ...scenario.filters, apply_discounts: true } }).cell;
    return { usd_inr: usd, is_current: usd === current.usd_inr, without_discount: off, with_discount: on };
  });

  const inputNow = makeInput(current);
  const eligible = new Set(base.vendors_considered.filter((v) => v.eligible).map((v) => v.vendor_key));
  const withDiscount = inputNow.vendors.filter((v) => eligible.has(v.key) && v.discounts.length > 0);
  const discountOn = fx.find((r) => r.is_current)?.with_discount;
  const discountOff = fx.find((r) => r.is_current)?.without_discount;
  const saves = discountOn && discountOff && discountOn.ok && discountOff.ok ? discountOff.goods_inr - discountOn.goods_inr : 0;
  const discount_note =
    withDiscount.length === 0
      ? 'No eligible vendor has a conditional discount, so the two columns are the same.'
      : saves > 0.005
        ? `${withDiscount.map((v) => v.key).join(', ')} offers a conditional discount. It lowers the total only where the vendor's allocation, as one PO, meets its threshold.`
        : `${withDiscount.map((v) => v.key).join(', ')} offers a conditional discount, but no allocation under these filters meets its threshold, so it changes nothing here.`;

  const ok = fx.filter((r) => r.without_discount.ok && r.with_discount.ok);
  const flat = ok.length > 0 && ok.every((r) => Math.abs(r.without_discount.goods_inr - (ok[0] as FxRow).without_discount.goods_inr) < 0.005 && Math.abs(r.with_discount.goods_inr - (ok[0] as FxRow).with_discount.goods_inr) < 0.005);
  const fx_note = flat
    ? 'The total does not move with the USD rate: no price this scenario relies on is quoted in US dollars.'
    : 'The total moves with the USD rate because at least one price that wins a line, or competes for one, is quoted in US dollars.';

  // Top vendor lost: re run without the vendor that holds the most value.
  let lost: TopVendorLost | null = null;
  const top = base.by_vendor[0];
  if (top) {
    const asked: Scenario = {
      ...scenario,
      filters: { ...scenario.filters, exclude_vendors: [...new Set([...scenario.filters.exclude_vendors, top.vendor_key])] },
    };
    let used = asked;
    let strategyNote: string | null = null;
    if (scenario.strategy === 'single_vendor') {
      // A single vendor award has no answer without that vendor, so show the nearest alternative and say so.
      used = { ...asked, strategy: 'cheapest_per_line', constraints: { ...scenario.constraints, vendor: null } };
      strategyNote = `This scenario awards everything to ${top.vendor_key}, so it has no answer without ${top.vendor_key}. Shown instead: cheapest per line among the remaining eligible vendors.`;
    }
    const { cell, result } = cellOf(inputNow, used);
    const likeForLike = !!result && result.totals.lines_awarded === base.totals.lines_awarded && result.coverage_gaps.length === base.coverage_gaps.length;
    const baseCovered = new Set(base.allocation.filter((a) => a.vendor_key).map((a) => a.line_code));
    const uncovered = result ? result.allocation.filter((a) => !a.vendor_key && baseCovered.has(a.line_code)).map((a) => a.line_code) : [];
    const delta = result && likeForLike ? result.totals.goods_total_inr - base.totals.goods_total_inr : null;
    lost = {
      vendor_key: top.vendor_key,
      vendor_name: top.vendor_name,
      share_pct: top.share * 100,
      strategy_note: strategyNote,
      cell,
      goods_delta_inr: delta,
      goods_delta_pct: delta != null && base.totals.goods_total_inr > 0 ? (delta / base.totals.goods_total_inr) * 100 : null,
      like_for_like: likeForLike,
      new_top_vendor: result?.concentration.top_vendor_key ?? null,
      lines_uncovered: uncovered,
      readiness_label: result?.readiness.label ?? null,
      note: !cell.ok
        ? cell.error ?? 'The scenario cannot run without this vendor.'
        : likeForLike
          ? `Same lines covered, so the difference is a like for like cost of losing ${top.vendor_key}.`
          : `Not like for like: ${uncovered.length} ${uncovered.length === 1 ? 'line loses' : 'lines lose'} all coverage, so the total is lower only because those lines are not bought.`,
    };
  }

  return { assumptions: current, fx, fx_note, discount_in_play: withDiscount.length > 0, discount_note, with_discount_note: withDiscount.length > 0 ? withDiscountNote(inputNow, scenario) : null, top_vendor_lost: lost };
}
