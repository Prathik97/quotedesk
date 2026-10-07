// Award simulation. Pure functions: no I/O, no model, never reads truth.json.
//
// The analyst agent calls this through a tool and never does the arithmetic itself.
// A scenario is: a strategy, filters (who is eligible, which prices may be used,
// whether conditional discounts count) and constraints (a vendor, a share cap).
//
// Missing is never zero: a line nobody eligible quoted is a coverage gap, not a free line.
import type { CellStatus } from './certainty';
import { landedTotal } from './convert';
import { isStrict, lineCarriesDiscount, parseThresholdInr, type ConditionalDiscount } from './scenario';
import type { Freight } from './totals';

export type Questionnaire = 'Cleared' | 'Failed' | 'Pending' | null;

export type OpenItemInput = { kind: string; severity: 'info' | 'warn' | 'block'; message: string };

export type AwardVendor = {
  id: string;
  key: string;
  name: string;
  questionnaire: Questionnaire;
  freight: Freight;
  discounts: ConditionalDiscount[];
  /** Open review items for this vendor, excluding the per cell Assumed entries. Used for readiness. */
  open_items: OpenItemInput[];
};

export type AwardLine = {
  id: string;
  code: string;
  section: string;
  description: string;
  uom: string;
  annual_qty: number;
  ly_rate: number | null;
  sort: number;
};

export type AwardCell = {
  vendor_id: string;
  line_id: string;
  quote_line_id: string | null;
  /** Normalized INR per base unit excluding GST, before any scenario discount. Null when not quoted. */
  price: number | null;
  status: CellStatus;
  conditions: string[];
};

export type AwardInput = { vendors: AwardVendor[]; lines: AwardLine[]; cells: AwardCell[] };

export type Strategy = 'single_vendor' | 'cheapest_per_line' | 'split_cap' | 'cheapest_per_section';
export type Eligibility = 'cleared' | 'cleared_and_pending' | 'all';
export type PriceBasis = 'confirmed' | 'confirmed_assumed' | 'all';

export type Scenario = {
  strategy: Strategy;
  filters: {
    /** cleared: passed all knockouts. cleared_and_pending: also vendors whose knockouts are undecided. all: everyone, including failed. */
    eligibility: Eligibility;
    exclude_vendors: string[];
    include_vendors: string[] | null;
    apply_discounts: boolean;
    /** confirmed: only Confirmed prices. confirmed_assumed: also Assumed. all: also Needs review and Conflict, as read. */
    price_basis: PriceBasis;
  };
  constraints: { vendor?: string | null; max_share?: number | null };
};

export const DEFAULT_SCENARIO: Scenario = {
  strategy: 'cheapest_per_line',
  filters: { eligibility: 'cleared', exclude_vendors: [], include_vendors: null, apply_discounts: false, price_basis: 'confirmed_assumed' },
  constraints: { vendor: null, max_share: null },
};

export class AwardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AllocationRow = {
  line_id: string;
  line_code: string;
  section: string;
  uom: string;
  annual_qty: number;
  ly_rate: number | null;
  vendor_key: string | null;
  vendor_name: string | null;
  quote_line_id: string | null;
  status: CellStatus | null;
  /** Price before any scenario discount. */
  base_price: number | null;
  /** Price used: base price less any discount applied. */
  price: number | null;
  discount_pct: number | null;
  annual_value_inr: number | null;
  ly_value_inr: number | null;
  /** Last year value less awarded value. Positive is a saving. */
  saving_vs_ly_inr: number | null;
  runner_up: { vendor_key: string; price: number } | null;
  gap_reason: string | null;
};

export type VendorAward = {
  vendor_key: string;
  vendor_name: string;
  lines: number;
  goods_value_inr: number;
  share: number;
  freight_terms: Freight['terms'];
  freight_amount_inr: number | null;
  landed_total_inr: number;
  landed_complete: boolean;
  landed_note: string;
  questionnaire: Questionnaire;
};

export type DiscountReport = {
  vendor_key: string;
  percent: number;
  condition: string;
  threshold_inr: number | null;
  /** The vendor's whole allocation at list price, treated as one PO. */
  vendor_po_value_inr: number;
  met: boolean | null;
  applied: boolean;
  affected_lines_won: string[];
  saving_inr: number;
  /** What this discount would save on the lines the vendor won, if it were applied. */
  potential_saving_inr: number;
  /** How much more business the vendor needs to reach the threshold. Zero when met, null when unreadable. */
  gap_to_threshold_inr: number | null;
  note: string;
};

export type FixedPointReport = {
  iterations: number;
  converged: boolean;
  start: 'none' | 'all' | 'n/a';
  /** Every start tried, so a second consistent answer is visible rather than hidden. */
  tried: { start: 'none' | 'all'; converged: boolean; iterations: number; total_goods_inr: number; applied: string[] }[];
  note: string;
};

export type RelianceCell = {
  quote_line_id: string | null;
  vendor_key: string;
  line_code: string;
  status: CellStatus;
  annual_value_inr: number;
};

export type Reliance = {
  confirmed: number;
  assumed: number;
  needs_review: number;
  conflict: number;
  /** Lines with no allocation at all. */
  missing: number;
  confirmed_value_inr: number;
  assumed_value_inr: number;
  unresolved_value_inr: number;
  /** Every allocated cell that is not Confirmed, largest value first. */
  not_confirmed: RelianceCell[];
};

export type ScenarioReadiness = {
  level: 'ready' | 'ready_with_open_items' | 'not_ready';
  label: 'Ready' | 'Ready with open items' | 'Not ready';
  /** Vendors included in the scenario (eligible under its filters). */
  included_vendors: string[];
  blockers: { vendor_key: string; kind: string; message: string }[];
  open_items: { vendor_key: string | null; kind: string; message: string }[];
  summary: string;
};

export type AwardResult = {
  scenario: Scenario;
  eligibility_label: string;
  vendors_considered: { vendor_key: string; vendor_name: string; eligible: boolean; reason: string; questionnaire: Questionnaire }[];
  allocation: AllocationRow[];
  by_vendor: VendorAward[];
  totals: {
    lines_total: number;
    lines_awarded: number;
    goods_total_inr: number;
    landed_total_inr: number;
    /** False when any awarded vendor's freight is unknown or extra with no amount: the landed figure is a floor. */
    landed_complete: boolean;
    ly_value_of_awarded_lines_inr: number;
    savings_vs_ly_inr: number;
    savings_vs_ly_pct: number | null;
    /** What the gap lines would have cost at last year's rate. Information only, never added. */
    ly_value_of_gap_lines_inr: number;
  };
  coverage_gaps: { line_code: string; section: string; annual_qty: number; ly_value_inr: number | null; reason: string; quoted_by_ineligible: { vendor_key: string; price: number }[] }[];
  concentration: { top_vendor_key: string | null; top_share: number; vendor_count: number; hhi: number };
  reliance: Reliance;
  /** Unresolved (Needs review or Conflict) cells that would change the allocation if taken as read. */
  unresolved_that_change_result: (RelianceCell & { would_change: string })[];
  /** Assumed cells excluded by a Confirmed only filter that would change the allocation. */
  assumed_excluded_that_change_result: (RelianceCell & { would_change: string })[];
  /** Total if every Needs review and Conflict price among eligible vendors were taken as read. Null when none exist. */
  total_if_unresolved_taken_as_read_inr: number | null;
  discounts: DiscountReport[];
  fixed_point: FixedPointReport;
  /** Cheaper prices from vendors the filters left out, per vendor. An upper bound: ignores their discounts, freight and risk. */
  excluded_cheaper: { vendor_key: string; reason: string; lines_cheaper: number; saving_if_taken_inr: number }[];
  warnings: string[];
  readiness: ScenarioReadiness;
};

const EPS = 1e-9;

function eligibleVendors(input: AwardInput, s: Scenario): { eligible: Set<string>; considered: AwardResult['vendors_considered'] } {
  const keys = new Set(input.vendors.map((v) => v.key));
  for (const k of [...s.filters.exclude_vendors, ...(s.filters.include_vendors ?? []), ...(s.constraints.vendor ? [s.constraints.vendor] : [])]) {
    if (!keys.has(k)) throw new AwardError('unknown_vendor', `Unknown vendor "${k}". Known vendors: ${[...keys].join(', ')}.`);
  }
  const eligible = new Set<string>();
  const considered = input.vendors.map((v) => {
    let reason = '';
    let ok = true;
    if (s.filters.exclude_vendors.includes(v.key)) {
      ok = false;
      reason = 'Excluded by request.';
    } else if (s.filters.include_vendors && !s.filters.include_vendors.includes(v.key)) {
      ok = false;
      reason = 'Not in the requested vendor list.';
    } else if (s.filters.eligibility === 'cleared' && v.questionnaire !== 'Cleared') {
      ok = false;
      reason = `Questionnaire ${v.questionnaire ?? 'not read'}: only vendors who passed all knockouts are eligible.`;
    } else if (s.filters.eligibility === 'cleared_and_pending' && v.questionnaire !== 'Cleared' && v.questionnaire !== 'Pending') {
      ok = false;
      reason = `Questionnaire ${v.questionnaire ?? 'not read'}: a failed knockout excludes the vendor.`;
    } else {
      reason = v.questionnaire === 'Cleared' ? 'Cleared the questionnaire.' : `Included although the questionnaire is ${v.questionnaire ?? 'not read'}.`;
    }
    if (ok) eligible.add(v.id);
    return { vendor_key: v.key, vendor_name: v.name, eligible: ok, reason, questionnaire: v.questionnaire };
  });
  return { eligible, considered };
}

function basisAllows(status: CellStatus, basis: PriceBasis): boolean {
  if (status === 'confirmed') return true;
  if (status === 'assumed') return basis !== 'confirmed';
  if (status === 'needs_review' || status === 'conflict') return basis === 'all';
  return false;
}

function eligibilityLabel(e: Eligibility): string {
  if (e === 'cleared') return 'Cleared vendors only (passed all three knockouts).';
  if (e === 'cleared_and_pending') return 'Cleared vendors and vendors with undecided knockouts (Pending). A Pending vendor may still fail.';
  return 'All vendors, including those who failed a knockout. Not a defensible award.';
}

type Offer = { vendor: AwardVendor; cell: AwardCell; list: number; eff: number; disc: number | null };

type Alloc = { winners: Map<string, Offer | null>; notes: string[]; cap?: { met: boolean; note: string } };

function discountKey(v: AwardVendor, d: ConditionalDiscount): string {
  return `${v.key}|${d.id}`;
}

/** Offers per line with the discounts in `active` applied to the lines each discount names. */
function buildOffers(input: AwardInput, s: Scenario, eligible: Set<string>, active: Set<string>): Map<string, Offer[]> {
  const vById = new Map(input.vendors.map((v) => [v.id, v]));
  const out = new Map<string, Offer[]>();
  for (const l of input.lines) out.set(l.id, []);
  for (const c of input.cells) {
    const v = vById.get(c.vendor_id);
    if (!v || !eligible.has(v.id) || c.price == null || !basisAllows(c.status, s.filters.price_basis)) continue;
    let eff = c.price;
    let pct: number | null = null;
    for (const d of v.discounts) {
      if (active.has(discountKey(v, d)) && lineCarriesDiscount(d, c.conditions)) {
        eff *= 1 - d.percent / 100;
        pct = (pct ?? 0) + d.percent;
      }
    }
    out.get(c.line_id)?.push({ vendor: v, cell: c, list: c.price, eff, disc: pct });
  }
  for (const offers of out.values()) offers.sort((a, b) => a.eff - b.eff || a.vendor.key.localeCompare(b.vendor.key));
  return out;
}

function cheapest(offers: Offer[]): Offer | null {
  return offers[0] ?? null;
}

function allocateCheapestPerLine(input: AwardInput, offers: Map<string, Offer[]>): Alloc {
  const winners = new Map<string, Offer | null>();
  for (const l of input.lines) winners.set(l.id, cheapest(offers.get(l.id) ?? []));
  return { winners, notes: [] };
}

function allocateSingle(input: AwardInput, s: Scenario, offers: Map<string, Offer[]>, eligible: Set<string>): Alloc {
  const key = s.constraints.vendor;
  if (!key) throw new AwardError('vendor_required', 'single_vendor needs constraints.vendor (for example "V1").');
  const v = input.vendors.find((x) => x.key === key);
  if (!v || !eligible.has(v.id)) {
    throw new AwardError(
      'vendor_not_eligible',
      `${key} is not eligible under these filters. Change the filters (for example eligibility "all") to see the numbers, and expect warnings.`,
    );
  }
  const winners = new Map<string, Offer | null>();
  for (const l of input.lines) winners.set(l.id, (offers.get(l.id) ?? []).find((o) => o.vendor.id === v.id) ?? null);
  return { winners, notes: [] };
}

function allocateSection(input: AwardInput, offers: Map<string, Offer[]>): Alloc {
  const notes: string[] = [];
  const winners = new Map<string, Offer | null>();
  const sections = [...new Set(input.lines.map((l) => l.section))];
  for (const sec of sections) {
    const lines = input.lines.filter((l) => l.section === sec);
    const vendorIds = new Set(lines.flatMap((l) => (offers.get(l.id) ?? []).map((o) => o.vendor.id)));
    let bestV: string | null = null;
    let bestTotal = Infinity;
    for (const vid of [...vendorIds].sort()) {
      let total = 0;
      let full = true;
      for (const l of lines) {
        const o = (offers.get(l.id) ?? []).find((x) => x.vendor.id === vid);
        if (!o) {
          full = false;
          break;
        }
        total += o.eff * l.annual_qty;
      }
      if (full && total < bestTotal - EPS) {
        bestTotal = total;
        bestV = vid;
      }
    }
    if (bestV) {
      for (const l of lines) winners.set(l.id, (offers.get(l.id) ?? []).find((x) => x.vendor.id === bestV) ?? null);
    } else {
      notes.push(`No eligible vendor quoted every line in "${sec}", so that section is awarded line by line.`);
      for (const l of lines) winners.set(l.id, cheapest(offers.get(l.id) ?? []));
    }
  }
  return { winners, notes };
}

/**
 * Cheapest per line, then move lines away from any vendor above the share cap. Each step moves the
 * line that costs the least extra per rupee moved, to a vendor that stays within the cap. Greedy,
 * not a proven optimum: the report says so. Share is measured on awarded value at the prices used.
 */
function allocateSplitCap(input: AwardInput, s: Scenario, offers: Map<string, Offer[]>, eligible: Set<string>): Alloc {
  const cap = s.constraints.max_share;
  if (cap == null || !(cap > 0 && cap <= 1)) throw new AwardError('cap_required', 'split_cap needs constraints.max_share between 0 and 1 (for example 0.6).');
  const lineById = new Map(input.lines.map((l) => [l.id, l]));
  const base = allocateCheapestPerLine(input, offers);
  const winners = base.winners;
  const notes: string[] = [];
  const value = () => {
    const m = new Map<string, number>();
    for (const [lid, o] of winners) if (o) m.set(o.vendor.id, (m.get(o.vendor.id) ?? 0) + o.eff * (lineById.get(lid)?.annual_qty ?? 0));
    return m;
  };
  let guard = 0;
  let met = true;
  let why = '';
  if (eligible.size * cap < 1 - EPS) {
    return { winners, notes: [`${eligible.size} eligible vendors cannot each stay under ${(cap * 100).toFixed(0)} percent and cover everything.`], cap: { met: false, note: 'Cap is below one over the number of eligible vendors, so it cannot be met.' } };
  }
  while (guard++ < 1000) {
    const val = value();
    const total = [...val.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    const over = [...val.entries()].filter(([, v]) => v / total > cap + 1e-9).sort((a, b) => b[1] - a[1])[0];
    if (!over) break;
    const [xid] = over;
    let best: { lid: string; to: Offer; score: number } | null = null;
    for (const [lid, o] of winners) {
      if (!o || o.vendor.id !== xid) continue;
      const l = lineById.get(lid);
      if (!l) continue;
      for (const alt of offers.get(lid) ?? []) {
        if (alt.vendor.id === xid) continue;
        const newTotal = total - o.eff * l.annual_qty + alt.eff * l.annual_qty;
        const yNew = (val.get(alt.vendor.id) ?? 0) + alt.eff * l.annual_qty;
        if (yNew / newTotal > cap + 1e-9) continue;
        const score = ((alt.eff - o.eff) * l.annual_qty) / (o.eff * l.annual_qty);
        if (!best || score < best.score - EPS) best = { lid, to: alt, score };
      }
    }
    if (!best) {
      met = false;
      why = 'No line can move without pushing another vendor over the cap.';
      break;
    }
    winners.set(best.lid, best.to);
  }
  if (guard >= 1000) {
    met = false;
    why = 'Stopped after 1000 moves without meeting the cap.';
  }
  const val = value();
  const total = [...val.values()].reduce((a, b) => a + b, 0);
  const top = Math.max(0, ...val.values()) / (total || 1);
  if (met) notes.push(`Share cap ${(cap * 100).toFixed(0)} percent met. Found by a greedy search, which is not proven to be the cheapest split.`);
  else notes.push(`Share cap ${(cap * 100).toFixed(0)} percent could not be met: ${why} Highest share ${(top * 100).toFixed(1)} percent.`);
  return { winners, notes, cap: { met, note: notes[notes.length - 1] as string } };
}

function allocate(input: AwardInput, s: Scenario, eligible: Set<string>, active: Set<string>): { alloc: Alloc; offers: Map<string, Offer[]> } {
  const offers = buildOffers(input, s, eligible, active);
  let alloc: Alloc;
  switch (s.strategy) {
    case 'cheapest_per_line':
      alloc = allocateCheapestPerLine(input, offers);
      break;
    case 'single_vendor':
      alloc = allocateSingle(input, s, offers, eligible);
      break;
    case 'cheapest_per_section':
      alloc = allocateSection(input, offers);
      break;
    case 'split_cap':
      alloc = allocateSplitCap(input, s, offers, eligible);
      break;
  }
  return { alloc, offers };
}

function goodsValue(input: AwardInput, alloc: Alloc): number {
  let t = 0;
  for (const l of input.lines) {
    const o = alloc.winners.get(l.id);
    if (o) t += o.eff * l.annual_qty;
  }
  return t;
}

/** Vendor allocation at list price, treated as one PO: the figure a discount threshold is compared with. */
function listPoValues(input: AwardInput, alloc: Alloc): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of input.lines) {
    const o = alloc.winners.get(l.id);
    if (o) m.set(o.vendor.id, (m.get(o.vendor.id) ?? 0) + o.list * l.annual_qty);
  }
  return m;
}

function thresholdOf(d: ConditionalDiscount): number | null {
  return parseThresholdInr(d.condition ?? d.text) ?? parseThresholdInr(d.text);
}

function discountMet(d: ConditionalDiscount, po: number): boolean | null {
  const t = thresholdOf(d);
  if (t == null) return null;
  return isStrict(d.condition ?? d.text) ? po > t : po >= t;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

const MAX_ITER = 3;

/**
 * Discounts depend on the allocation and the allocation depends on the discounts. We iterate:
 * allocate with a set of active discounts, then see which thresholds that allocation meets, and
 * repeat until the set stops changing, at most 3 rounds. Two starts are tried, no discounts and
 * every discount, because the circle can have two consistent answers (Kaveri wins lines 1 to 14
 * only if its discount applies, and the discount applies only if it wins enough). The cheaper
 * consistent answer is reported and the other is shown. If neither settles, discounts are off.
 */
function solveWithDiscounts(input: AwardInput, s: Scenario, eligible: Set<string>): { alloc: Alloc; offers: Map<string, Offer[]>; active: Set<string>; fp: FixedPointReport } {
  const withDisc = input.vendors.filter((v) => eligible.has(v.id) && v.discounts.length > 0);
  if (!s.filters.apply_discounts || withDisc.length === 0) {
    const r = allocate(input, s, eligible, new Set());
    return { ...r, active: new Set(), fp: { iterations: 1, converged: true, start: 'n/a', tried: [], note: s.filters.apply_discounts ? 'No eligible vendor has a conditional discount.' : 'Conditional discounts are not applied in this scenario.' } };
  }
  const allKeys = new Set(withDisc.flatMap((v) => v.discounts.map((d) => discountKey(v, d))));
  const tried: FixedPointReport['tried'] = [];
  const runs: { start: 'none' | 'all'; converged: boolean; iterations: number; active: Set<string>; r: ReturnType<typeof allocate>; total: number }[] = [];
  for (const start of ['none', 'all'] as const) {
    let active = start === 'none' ? new Set<string>() : new Set(allKeys);
    let converged = false;
    let iterations = 0;
    let r = allocate(input, s, eligible, active);
    for (let i = 1; i <= MAX_ITER; i++) {
      iterations = i;
      r = allocate(input, s, eligible, active);
      const po = listPoValues(input, r.alloc);
      const next = new Set<string>();
      for (const v of withDisc) for (const d of v.discounts) if (discountMet(d, po.get(v.id) ?? 0) === true) next.add(discountKey(v, d));
      if (sameSet(next, active)) {
        converged = true;
        break;
      }
      active = next;
    }
    const total = goodsValue(input, r.alloc);
    tried.push({ start, converged, iterations, total_goods_inr: total, applied: [...active].sort() });
    runs.push({ start, converged, iterations, active, r, total });
  }
  const ok = runs.filter((x) => x.converged);
  if (ok.length === 0) {
    const r = allocate(input, s, eligible, new Set());
    return { ...r, active: new Set(), fp: { iterations: MAX_ITER, converged: false, start: 'none', tried, note: 'The discount and the allocation did not settle within 3 rounds from either start, so discounts are left off. Treat any discount saving as unconfirmed.' } };
  }
  ok.sort((a, b) => a.total - b.total);
  const pick = ok[0] as (typeof runs)[number];
  const distinct = ok.length > 1 && !sameSet(ok[0]!.active, ok[1]!.active);
  return {
    alloc: pick.r.alloc,
    offers: pick.r.offers,
    active: pick.active,
    fp: {
      iterations: pick.iterations,
      converged: true,
      start: pick.start,
      tried,
      note: distinct
        ? 'Two consistent answers exist. The cheaper one is shown; the other is listed under tried.'
        : 'Settled: each discount applies exactly when the vendor wins enough to meet its threshold.',
    },
  };
}

function relianceOf(rows: AllocationRow[], gapCount: number): Reliance {
  const r: Reliance = { confirmed: 0, assumed: 0, needs_review: 0, conflict: 0, missing: gapCount, confirmed_value_inr: 0, assumed_value_inr: 0, unresolved_value_inr: 0, not_confirmed: [] };
  for (const row of rows) {
    if (!row.vendor_key || !row.status || row.annual_value_inr == null) continue;
    if (row.status === 'confirmed') {
      r.confirmed++;
      r.confirmed_value_inr += row.annual_value_inr;
      continue;
    }
    if (row.status === 'assumed') {
      r.assumed++;
      r.assumed_value_inr += row.annual_value_inr;
    } else if (row.status === 'needs_review' || row.status === 'conflict') {
      r[row.status]++;
      r.unresolved_value_inr += row.annual_value_inr;
    }
    r.not_confirmed.push({ quote_line_id: row.quote_line_id, vendor_key: row.vendor_key, line_code: row.line_code, status: row.status, annual_value_inr: row.annual_value_inr });
  }
  r.not_confirmed.sort((a, b) => b.annual_value_inr - a.annual_value_inr);
  return r;
}

function describeChange(base: Offer | null, alt: Offer | null): string {
  if (!base) return `Fills a line nobody else quoted, at ${alt?.eff.toFixed(2)}.`;
  if (!alt) return 'Would remove the current award.';
  if (alt.vendor.id !== base.vendor.id) return `${alt.vendor.key} would win at ${alt.eff.toFixed(2)} instead of ${base.vendor.key} at ${base.eff.toFixed(2)}.`;
  return `Price would change from ${base.eff.toFixed(2)} to ${alt.eff.toFixed(2)}.`;
}

export function simulateAward(input: AwardInput, scenario: Scenario): AwardResult {
  const s = scenario;
  const { eligible, considered } = eligibleVendors(input, s);
  const lineById = new Map(input.lines.map((l) => [l.id, l]));
  const sorted = [...input.lines].sort((a, b) => a.sort - b.sort);
  const solved = solveWithDiscounts(input, s, eligible);
  const { alloc, offers, active } = solved;
  const warnings: string[] = [...alloc.notes];

  // Allocation rows and coverage gaps.
  const rows: AllocationRow[] = [];
  const gaps: AwardResult['coverage_gaps'] = [];
  const vById = new Map(input.vendors.map((v) => [v.id, v]));
  for (const l of sorted) {
    const w = alloc.winners.get(l.id) ?? null;
    const lyValue = l.ly_rate != null ? l.ly_rate * l.annual_qty : null;
    if (!w) {
      const inel = input.cells
        .filter((c) => c.line_id === l.id && c.price != null && !eligible.has(c.vendor_id) && basisAllows(c.status, s.filters.price_basis))
        .map((c) => ({ vendor_key: vById.get(c.vendor_id)?.key ?? '', price: c.price as number }));
      const other = (offers.get(l.id) ?? []).length > 0;
      const reason =
        s.strategy === 'single_vendor'
          ? `${s.constraints.vendor} did not quote this line${other ? ' (other eligible vendors did)' : ''}.`
          : 'No eligible vendor quoted this line with a usable price.';
      rows.push({ line_id: l.id, line_code: l.code, section: l.section, uom: l.uom, annual_qty: l.annual_qty, ly_rate: l.ly_rate, vendor_key: null, vendor_name: null, quote_line_id: null, status: null, base_price: null, price: null, discount_pct: null, annual_value_inr: null, ly_value_inr: lyValue, saving_vs_ly_inr: null, runner_up: null, gap_reason: reason });
      gaps.push({ line_code: l.code, section: l.section, annual_qty: l.annual_qty, ly_value_inr: lyValue, reason, quoted_by_ineligible: inel });
      continue;
    }
    const all = offers.get(l.id) ?? [];
    const ru = all.find((o) => o.vendor.id !== w.vendor.id);
    const value = w.eff * l.annual_qty;
    rows.push({
      line_id: l.id, line_code: l.code, section: l.section, uom: l.uom, annual_qty: l.annual_qty, ly_rate: l.ly_rate,
      vendor_key: w.vendor.key, vendor_name: w.vendor.name, quote_line_id: w.cell.quote_line_id, status: w.cell.status,
      base_price: w.list, price: w.eff, discount_pct: w.disc, annual_value_inr: value, ly_value_inr: lyValue,
      saving_vs_ly_inr: lyValue != null ? lyValue - value : null,
      runner_up: ru ? { vendor_key: ru.vendor.key, price: ru.eff } : null, gap_reason: null,
    });
  }

  // Totals, per vendor, landed cost.
  const awarded = rows.filter((r) => r.vendor_key != null);
  const goods = awarded.reduce((a, r) => a + (r.annual_value_inr ?? 0), 0);
  const byVendor: VendorAward[] = [];
  for (const v of input.vendors) {
    const mine = awarded.filter((r) => r.vendor_key === v.key);
    if (mine.length === 0) continue;
    const g = mine.reduce((a, r) => a + (r.annual_value_inr ?? 0), 0);
    const landed = landedTotal(g, v.freight);
    byVendor.push({
      vendor_key: v.key, vendor_name: v.name, lines: mine.length, goods_value_inr: g, share: goods > 0 ? g / goods : 0,
      freight_terms: v.freight.terms, freight_amount_inr: v.freight.amount_inr, landed_total_inr: landed.total_inr,
      landed_complete: landed.complete, landed_note: landed.reason, questionnaire: v.questionnaire,
    });
  }
  byVendor.sort((a, b) => b.goods_value_inr - a.goods_value_inr);
  const landedSum = byVendor.reduce((a, v) => a + v.landed_total_inr, 0);
  const landedComplete = byVendor.every((v) => v.landed_complete);
  const lyAwarded = awarded.reduce((a, r) => a + (r.ly_value_inr ?? 0), 0);
  const savings = awarded.reduce((a, r) => a + (r.saving_vs_ly_inr ?? 0), 0);
  const lyGap = gaps.reduce((a, g) => a + (g.ly_value_inr ?? 0), 0);

  // Discount reports for every discount of every eligible vendor.
  const po = listPoValues(input, alloc);
  const discounts: DiscountReport[] = [];
  for (const v of input.vendors) {
    if (!eligible.has(v.id)) continue;
    for (const d of v.discounts) {
      const value = po.get(v.id) ?? 0;
      const t = thresholdOf(d);
      const met = discountMet(d, value);
      const won = awarded.filter((r) => r.vendor_key === v.key);
      const cellsWon = won.flatMap((r) => {
        const cell = input.cells.find((c) => c.vendor_id === v.id && c.line_id === r.line_id);
        return cell && lineCarriesDiscount(d, cell.conditions) ? [{ r, cell }] : [];
      });
      const potential = cellsWon.reduce((a, x) => a + (x.cell.price ?? 0) * (lineById.get(x.r.line_id)?.annual_qty ?? 0) * (d.percent / 100), 0);
      const applied = active.has(discountKey(v, d));
      discounts.push({
        vendor_key: v.key, percent: d.percent, condition: d.condition ?? d.text, threshold_inr: t, vendor_po_value_inr: value, met, applied,
        affected_lines_won: cellsWon.map((x) => x.r.line_code), saving_inr: applied ? potential : 0, potential_saving_inr: potential,
        gap_to_threshold_inr: t == null ? null : Math.max(0, t - value),
        note: t == null ? 'The threshold could not be read, so the discount is not applied.' : met ? 'The vendor allocation meets the threshold as a single PO.' : 'The vendor allocation is below the threshold.',
      });
    }
  }
  if (s.filters.apply_discounts && !solved.fp.converged) warnings.push(solved.fp.note);

  // Reliance and unresolved cells that change the result.
  const reliance = relianceOf(rows, gaps.length);
  let unresolvedChange: AwardResult['unresolved_that_change_result'] = [];
  let assumedChange: AwardResult['assumed_excluded_that_change_result'] = [];
  let totalIfRead: number | null = null;
  if (s.filters.price_basis !== 'all') {
    const altS: Scenario = { ...s, filters: { ...s.filters, price_basis: 'all' } };
    try {
      const alt = solveWithDiscounts(input, altS, eligible);
      const hasUnresolved = input.cells.some((c) => eligible.has(c.vendor_id) && c.price != null && (c.status === 'needs_review' || c.status === 'conflict'));
      if (hasUnresolved) totalIfRead = goodsValue(input, alt.alloc);
      for (const l of sorted) {
        const b = alloc.winners.get(l.id) ?? null;
        const a = alt.alloc.winners.get(l.id) ?? null;
        if (!a) continue;
        const different = !b || a.vendor.id !== b.vendor.id || Math.abs(a.eff - b.eff) > 1e-9;
        if (!different) continue;
        const item = { quote_line_id: a.cell.quote_line_id, vendor_key: a.vendor.key, line_code: l.code, status: a.cell.status, annual_value_inr: a.eff * l.annual_qty, would_change: describeChange(b, a) };
        if (a.cell.status === 'needs_review' || a.cell.status === 'conflict') unresolvedChange.push(item);
        else if (a.cell.status === 'assumed' && s.filters.price_basis === 'confirmed') assumedChange.push(item);
      }
    } catch {
      // single_vendor on a vendor that vanished under the alternate basis: nothing to compare.
    }
  }
  unresolvedChange = unresolvedChange.sort((a, b) => b.annual_value_inr - a.annual_value_inr);
  assumedChange = assumedChange.sort((a, b) => b.annual_value_inr - a.annual_value_inr);

  // What the filters leave on the table.
  const excludedCheaper: AwardResult['excluded_cheaper'] = [];
  for (const c of considered.filter((x) => !x.eligible)) {
    const v = input.vendors.find((x) => x.key === c.vendor_key) as AwardVendor;
    let n = 0;
    let save = 0;
    for (const r of awarded) {
      const cell = input.cells.find((x) => x.vendor_id === v.id && x.line_id === r.line_id);
      if (!cell || cell.price == null || !basisAllows(cell.status, s.filters.price_basis) || r.price == null) continue;
      if (cell.price < r.price - EPS) {
        n++;
        save += (r.price - cell.price) * r.annual_qty;
      }
    }
    if (n > 0) excludedCheaper.push({ vendor_key: v.key, reason: c.reason, lines_cheaper: n, saving_if_taken_inr: save });
  }

  // Concentration.
  const top = byVendor[0];
  const hhi = byVendor.reduce((a, v) => a + v.share * v.share, 0);

  // Warnings about the vendors the award relies on.
  for (const v of byVendor) {
    if (v.questionnaire === 'Failed') warnings.push(`${v.vendor_key} failed a knockout question. Awarding to it is not defensible as it stands.`);
    else if (v.questionnaire === 'Pending') warnings.push(`${v.vendor_key} has an undecided knockout (Pending). It may still fail.`);
    if (!v.landed_complete) warnings.push(`${v.vendor_key}: ${v.landed_note}`);
  }
  if (gaps.length > 0) warnings.push(`${gaps.length} ${gaps.length === 1 ? 'line has' : 'lines have'} no eligible usable price and ${gaps.length === 1 ? 'is' : 'are'} not in the totals.`);

  // Readiness for this scenario: only vendors included in it.
  const included = input.vendors.filter((v) => eligible.has(v.id));
  const blockers: ScenarioReadiness['blockers'] = [];
  const open: ScenarioReadiness['open_items'] = [];
  for (const v of included) {
    const cells = input.cells.filter((c) => c.vendor_id === v.id);
    const nr = cells.filter((c) => c.status === 'needs_review').length;
    const cf = cells.filter((c) => c.status === 'conflict').length;
    if (nr > 0) blockers.push({ vendor_key: v.key, kind: 'line_needs_review', message: `${nr} ${nr === 1 ? 'cell needs' : 'cells need'} review.` });
    if (cf > 0) blockers.push({ vendor_key: v.key, kind: 'conflict', message: `${cf} ${cf === 1 ? 'cell is' : 'cells are'} in conflict.` });
    if (v.questionnaire === 'Pending') blockers.push({ vendor_key: v.key, kind: 'knockout_pending', message: 'A knockout question is undecided.' });
    if (v.questionnaire === 'Failed' && byVendor.some((x) => x.vendor_key === v.key)) blockers.push({ vendor_key: v.key, kind: 'knockout_failed', message: 'The vendor failed a knockout and is in the award.' });
    for (const i of v.open_items) {
      if (i.kind === 'knockout_pending' || i.kind === 'line_needs_review' || i.kind === 'conflict') continue;
      open.push({ vendor_key: v.key, kind: i.kind, message: i.message });
    }
    if (v.freight.terms === 'extra' && v.freight.amount_inr == null && byVendor.some((x) => x.vendor_key === v.key) && !v.open_items.some((i) => i.kind === 'freight_amount_unknown')) {
      open.push({ vendor_key: v.key, kind: 'freight_amount_unknown', message: 'Freight is extra with no amount stated.' });
    }
  }
  if (reliance.assumed > 0) open.push({ vendor_key: null, kind: 'assumed_cells', message: `${reliance.assumed} awarded ${reliance.assumed === 1 ? 'cell is' : 'cells are'} Assumed.` });
  if (gaps.length > 0) open.push({ vendor_key: null, kind: 'coverage_gaps', message: `${gaps.length} ${gaps.length === 1 ? 'line is' : 'lines are'} not covered.` });
  const level: ScenarioReadiness['level'] = blockers.length > 0 ? 'not_ready' : open.length > 0 ? 'ready_with_open_items' : 'ready';
  const readiness: ScenarioReadiness = {
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

  return {
    scenario: s,
    eligibility_label: eligibilityLabel(s.filters.eligibility),
    vendors_considered: considered,
    allocation: rows,
    by_vendor: byVendor,
    totals: {
      lines_total: input.lines.length,
      lines_awarded: awarded.length,
      goods_total_inr: goods,
      landed_total_inr: landedSum,
      landed_complete: landedComplete,
      ly_value_of_awarded_lines_inr: lyAwarded,
      savings_vs_ly_inr: savings,
      savings_vs_ly_pct: lyAwarded > 0 ? (savings / lyAwarded) * 100 : null,
      ly_value_of_gap_lines_inr: lyGap,
    },
    coverage_gaps: gaps,
    concentration: { top_vendor_key: top?.vendor_key ?? null, top_share: top?.share ?? 0, vendor_count: byVendor.length, hhi },
    reliance,
    unresolved_that_change_result: unresolvedChange,
    assumed_excluded_that_change_result: assumedChange,
    total_if_unresolved_taken_as_read_inr: totalIfRead,
    discounts,
    fixed_point: solved.fp,
    excluded_cheaper: excludedCheaper,
    warnings,
    readiness,
  };
}

/** Merge a partial scenario over a previous one, so a follow up like "now exclude Vendor 3" changes only that. */
export function mergeScenario(prev: Scenario, patch: DeepPartial<Scenario> | undefined): Scenario {
  if (!patch) return prev;
  return {
    strategy: patch.strategy ?? prev.strategy,
    filters: {
      eligibility: patch.filters?.eligibility ?? prev.filters.eligibility,
      exclude_vendors: (patch.filters?.exclude_vendors as string[] | undefined) ?? prev.filters.exclude_vendors,
      include_vendors: patch.filters?.include_vendors === undefined ? prev.filters.include_vendors : ((patch.filters.include_vendors as string[] | null) ?? null),
      apply_discounts: patch.filters?.apply_discounts ?? prev.filters.apply_discounts,
      price_basis: patch.filters?.price_basis ?? prev.filters.price_basis,
    },
    constraints: {
      vendor: patch.constraints?.vendor === undefined ? prev.constraints.vendor : (patch.constraints.vendor ?? null),
      max_share: patch.constraints?.max_share === undefined ? prev.constraints.max_share : (patch.constraints.max_share ?? null),
    },
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> | null : T[K] | null };
