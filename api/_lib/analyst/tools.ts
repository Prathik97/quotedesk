// The analyst's tools. All deterministic and server side. The model asks; code answers.
// Each tool returns `model`, exactly what the model is given, and optionally a stored result
// the UI can render as a table or chart and a later turn can export.
import type pg from 'pg';
import { z } from 'zod';
import { AwardError, mergeScenario, simulateAward, type AwardResult, type Scenario } from '../../../engine/award.js';
import { STATUS_LABEL, toCellStatus } from '../../../engine/certainty.js';
import { assumptionText, flagText } from '../../../engine/explain.js';
import { formatInrCompact } from '../../../engine/format.js';
import { buildAwardInput, globalAssumptions, resolveVendor, safeMessage, type AnalystData } from './data.js';
import { limited, ROW_LIMIT, SqlRejected, validateSelect } from './sqlguard.js';
import type { AssumptionOverrides, ChartPayload, ExportChip, SessionState, StoredResult, Table, ToolOutcome } from './types.js';

export const MAX_TOOL_CALLS_PER_TURN = 8;

export type ToolCtx = {
  /** Read only role connection for query_comparison. */
  ro: pg.Pool;
  pool: pg.Pool;
  sessionId: string;
  state: SessionState;
  results: Map<string, StoredResult>;
  data: () => Promise<AnalystData>;
  newResultId: () => string;
};

const r2 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100) / 100);
const r1 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 10) / 10);

// ---------------------------------------------------------------- schemas

const VendorRef = z.string().min(1).max(60).describe('A vendor key such as "V4", or a name such as "Sunrise".');

const ScenarioPatch = z.object({
  strategy: z.enum(['single_vendor', 'cheapest_per_line', 'split_cap', 'cheapest_per_section']).optional(),
  filters: z
    .object({
      eligibility: z.enum(['cleared', 'cleared_and_pending', 'all']).optional().describe('cleared: passed all three knockouts (default). cleared_and_pending: also vendors whose knockouts are undecided. all: everyone, including vendors who failed.'),
      exclude_vendors: z.array(VendorRef).optional().describe('Replaces the whole exclusion list when given.'),
      include_vendors: z.array(VendorRef).nullable().optional().describe('Only these vendors. Null clears the restriction.'),
      apply_discounts: z.boolean().optional().describe('Apply conditional discounts where the vendor allocation meets the threshold as one PO.'),
      price_basis: z.enum(['confirmed', 'confirmed_assumed', 'all']).optional().describe('confirmed: only Confirmed prices. confirmed_assumed: also Assumed (default). all: also Needs review and Conflict prices, as read.'),
    })
    .optional(),
  constraints: z
    .object({
      vendor: VendorRef.nullable().optional().describe('Required for single_vendor.'),
      max_share: z.number().gt(0).lte(1).nullable().optional().describe('For split_cap: the most any vendor may hold, as a fraction (0.6 means 60 percent).'),
    })
    .optional(),
});

export const TOOL_SCHEMAS = {
  query_comparison: z.object({
    sql: z.string().min(1).max(4000).describe('One read only SELECT or WITH query over the allowed views.'),
    title: z.string().max(100).optional().describe('A short title for the result table.'),
  }),
  simulate_award: ScenarioPatch.extend({
    assumptions: z
      .object({ usd_inr: z.number().positive().max(10000).optional(), gst_pct: z.number().min(0).max(100).optional() })
      .optional()
      .describe('One off assumptions for this run only, for example usd_inr 85. Does not change the buyer\'s global assumption.'),
    reset: z.boolean().optional().describe('Start from the default scenario instead of changing the previous one.'),
    title: z.string().max(100).optional(),
  }),
  get_evidence: z.object({
    quote_line_id: z.string().uuid().optional(),
    vendor: VendorRef.optional(),
    line_code: z.string().max(30).optional().describe('An RFx line code such as "CRT-5P-01", used with vendor.'),
  }),
  list_open_issues: z.object({
    vendor: VendorRef.optional(),
    min_value: z.number().min(0).optional().describe('Only items with at least this many rupees at stake.'),
    limit: z.number().int().min(1).max(60).optional().describe('How many rows to read back. The full list is kept for charts and exports.'),
  }),
  get_assumptions: z.object({}),
  set_scenario_assumption: z.object({
    key: z.enum(['usd_inr', 'gst_pct']),
    value: z.number().positive().max(10000),
  }),
  make_chart: z.object({
    type: z.enum(['bar', 'line', 'stacked_bar', 'scatter']),
    title: z.string().min(1).max(120),
    x_label: z.string().max(60).optional(),
    y_label: z.string().max(60).optional(),
    unit: z.enum(['inr', 'pct', 'count', 'number']).default('number'),
    source: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('table'),
        result_id: z.string().min(1).max(20),
        table: z.string().min(1).max(40).optional().describe('A table name inside the result. Defaults to the first table.'),
        x_column: z.string().min(1).max(60),
        y_columns: z.array(z.string().min(1).max(60)).min(1).max(6),
        limit: z.number().int().min(1).max(60).optional(),
      }),
      z.object({
        mode: z.literal('scalars'),
        series_name: z.string().min(1).max(60),
        points: z.array(z.object({ label: z.string().min(1).max(60), result_id: z.string().min(1).max(20), field: z.string().min(1).max(80).describe('A dot path into the result data, for example "totals.goods_total_inr".') })).min(1).max(12),
      }),
    ]),
  }),
  export: z.object({
    format: z.enum(['xlsx', 'csv']),
    source: z.string().min(1).max(20).describe('The result_id of a prior result.'),
    filename: z.string().max(60).optional(),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  query_comparison:
    'Run a read only SQL SELECT. Views: comparison_view (one row per vendor and RFx line: vendor_name, line_code, section, uom, annual_qty, last_year_rate_inr, normalized_price_inr, annual_value_inr, delta_vs_ly_pct, status, flags, assumption_keys, quote_line_id), vendor_summary_view (per vendor: lines_quoted, lines_total, confirmed, assumed, needs_review, conflict, missing, questionnaire_result, freight_terms, freight_amount_inr, payment_terms_days, stated_total_inr, open_review_items, open_warnings), award_input_view (priced cells only), rfx_lines_view, vendor_terms_view (includes conditional_discounts), open_issues_view, assumptions_view. A price is null and status is "missing" when the vendor did not quote the line: never treat that as zero. Do arithmetic in SQL (sum, avg, max, min, round), not in your head. Max 200 rows, 5 seconds.',
  simulate_award:
    'Run the award engine for a scenario. Without reset, your arguments change the previous scenario in this chat (follow ups like "now exclude Vendor 3"). Returns allocation per line, totals, savings against last year, coverage gaps, concentration, landed cost completeness, how many Confirmed, Assumed and Needs review cells the result relies on, unresolved cells that would change it, conditional discount handling, and readiness. All amounts are INR excluding GST.',
  get_evidence: 'Evidence for one cell: source locator and quote, raw quoted value and unit, status, flags, and the assumptions it depends on. Pass quote_line_id, or vendor and line_code.',
  list_open_issues:
    'Everything not yet confirmed or needing a decision, ranked by rupees at stake: Assumed, Needs review and Conflict cells plus vendor level open items (freight with no amount, a stated total that does not add up, failed or pending knockouts, certificate flags, ignored suspicious content). Returns totals and the largest rows; the whole list is stored for export.',
  get_assumptions: 'The global assumptions (USD to INR, GST), the scenario overrides in force in this chat, and the assumptions the extraction applied to specific cells (pack sizes, last year inheritance, USD prices).',
  set_scenario_assumption: 'Set an assumption for this chat\'s scenario only. It never overwrites the buyer\'s global assumption. Later simulate_award calls use it.',
  make_chart: 'Draw a chart from the rows of a prior result (mode table) or from single figures of several prior results (mode scalars). You never type the data: you name the result, table and columns.',
  export: 'Create a downloadable xlsx or csv from a prior result. Returns a download chip the user can click.',
};

export function toolDefinitions() {
  return (Object.keys(TOOL_SCHEMAS) as ToolName[]).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    input_schema: z.toJSONSchema(TOOL_SCHEMAS[name], { target: 'draft-7' }) as unknown as { type: 'object'; [k: string]: unknown },
  }));
}

// ---------------------------------------------------------------- helpers

function columnType(key: string, v: unknown): Table['columns'][number]['type'] {
  if (/_pct$|^pct_|percent/.test(key)) return 'pct';
  if (/_inr$|^value|^total|spread/.test(key)) return 'inr';
  if (/price|rate/.test(key) && typeof v === 'number') return 'inr_unit';
  if (key === 'status') return 'status';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'num';
  return 'text';
}

function toCellValue(v: unknown): unknown {
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && v.length < 18) return Math.round(Number(v) * 10000) / 10000;
  if (Array.isArray(v)) return v.join(', ');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function flatMoney(v: unknown): unknown {
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v;
}

function schemaHint(): string {
  return 'Tables you can query: comparison_view, vendor_summary_view, award_input_view, rfx_lines_view, vendor_terms_view, open_issues_view, assumptions_view.';
}

// ---------------------------------------------------------------- query_comparison

async function queryComparison(ctx: ToolCtx, input: z.infer<typeof TOOL_SCHEMAS.query_comparison>): Promise<ToolOutcome> {
  let sql: string;
  try {
    sql = validateSelect(input.sql);
  } catch (e) {
    const msg = e instanceof SqlRejected ? e.message : 'The query could not be checked.';
    return { model: { error: msg, hint: schemaHint() }, summary: `Query refused: ${msg}`, error: true };
  }
  const client = await ctx.ro.connect();
  try {
    await client.query('begin read only');
    await client.query("set local statement_timeout = '5000ms'");
    const res = await client.query(limited(sql));
    await client.query('rollback');
    const truncated = res.rows.length > ROW_LIMIT;
    const rows = (truncated ? res.rows.slice(0, ROW_LIMIT) : res.rows).map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, flatMoney(toCellValue(v))])));
    const columns = res.fields.map((f) => f.name);
    const first = rows[0] ?? {};
    const id = ctx.newResultId();
    const title = input.title ?? 'Query result';
    const result: StoredResult = {
      id, kind: 'query', title,
      notes: [`SQL: ${sql}`, `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}${truncated ? `, cut at ${ROW_LIMIT}` : ''}`],
      tables: [{ name: 'rows', title, columns: columns.map((c) => ({ key: c, label: c.replaceAll('_', ' '), type: columnType(c, first[c]) })), rows }],
    };
    ctx.results.set(id, result);
    const forModel = rows.slice(0, 80);
    return {
      model: { result_id: id, columns, row_count: rows.length, truncated, rows: forModel, rows_not_shown: Math.max(0, rows.length - forModel.length) },
      summary: `${rows.length} ${rows.length === 1 ? 'row' : 'rows'} returned`,
      result,
      rows_used: rows.length,
      sql,
    };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    const raw = (e as Error).message.split('\n')[0] ?? 'error';
    const msg = /statement timeout/.test(raw) ? 'The query took longer than 5 seconds and was stopped.' : /permission denied/.test(raw) ? 'That relation is not available. ' + schemaHint() : `The database rejected the query: ${raw}`;
    return { model: { error: msg }, summary: msg, error: true, sql };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- simulate_award

function resolveScenarioRefs(data: AnalystData, patch: z.infer<typeof ScenarioPatch>): { patch: Parameters<typeof mergeScenario>[1]; errors: string[] } {
  const errors: string[] = [];
  const one = (ref: string): string | null => {
    const k = resolveVendor(data.compare, ref);
    if (!k) errors.push(`Unknown vendor "${ref}". Vendors: ${data.compare.vendors.map((v) => `${v.key} ${v.name}`).join('; ')}.`);
    return k;
  };
  const many = (refs: string[]) => refs.map(one).filter((x): x is string => x != null);
  return {
    errors,
    patch: {
      strategy: patch.strategy,
      filters: patch.filters
        ? {
            eligibility: patch.filters.eligibility,
            apply_discounts: patch.filters.apply_discounts,
            price_basis: patch.filters.price_basis,
            exclude_vendors: patch.filters.exclude_vendors ? many(patch.filters.exclude_vendors) : undefined,
            include_vendors: patch.filters.include_vendors === undefined ? undefined : patch.filters.include_vendors === null ? null : many(patch.filters.include_vendors),
          }
        : undefined,
      constraints: patch.constraints
        ? {
            vendor: patch.constraints.vendor === undefined ? undefined : patch.constraints.vendor === null ? null : one(patch.constraints.vendor),
            max_share: patch.constraints.max_share,
          }
        : undefined,
    },
  };
}

type Assump = { usd_inr: number; gst_pct: number };

function awardTables(res: AwardResult): Table[] {
  const alloc: Table = {
    name: 'allocation', title: 'Allocation by line',
    columns: [
      { key: 'line_code', label: 'Line', type: 'text' }, { key: 'section', label: 'Section', type: 'text' }, { key: 'annual_qty', label: 'Annual qty', type: 'int' },
      { key: 'vendor_key', label: 'Vendor', type: 'text' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'base_price', label: 'List price', type: 'inr_unit' },
      { key: 'price', label: 'Price used', type: 'inr_unit' }, { key: 'discount_pct', label: 'Discount %', type: 'pct' }, { key: 'annual_value_inr', label: 'Annual value', type: 'inr' },
      { key: 'ly_value_inr', label: 'Last year value', type: 'inr' }, { key: 'saving_vs_ly_inr', label: 'Saving vs last year', type: 'inr' }, { key: 'runner_up', label: 'Next best', type: 'text' }, { key: 'gap_reason', label: 'Gap', type: 'text' },
    ],
    rows: res.allocation.map((a) => ({
      line_code: a.line_code, section: a.section, annual_qty: a.annual_qty, vendor_key: a.vendor_key ?? 'Not covered', status: a.status ? STATUS_LABEL[toCellStatus(a.status)] : 'Not quoted',
      base_price: r2(a.base_price), price: r2(a.price), discount_pct: a.discount_pct, annual_value_inr: r2(a.annual_value_inr), ly_value_inr: r2(a.ly_value_inr), saving_vs_ly_inr: r2(a.saving_vs_ly_inr),
      runner_up: a.runner_up ? `${a.runner_up.vendor_key} at ${r2(a.runner_up.price)}` : '', gap_reason: a.gap_reason ?? '', quote_line_id: a.quote_line_id,
    })),
  };
  const byVendor: Table = {
    name: 'by_vendor', title: 'By vendor',
    columns: [
      { key: 'vendor', label: 'Vendor', type: 'text' }, { key: 'lines', label: 'Lines', type: 'int' }, { key: 'goods_value_inr', label: 'Goods value', type: 'inr' }, { key: 'share_pct', label: 'Share %', type: 'pct' },
      { key: 'freight', label: 'Freight', type: 'text' }, { key: 'landed_total_inr', label: 'Landed total', type: 'inr' }, { key: 'landed_complete', label: 'Landed complete', type: 'text' }, { key: 'questionnaire', label: 'Questionnaire', type: 'text' },
    ],
    rows: res.by_vendor.map((v) => ({
      vendor: `${v.vendor_key} ${v.vendor_name}`, lines: v.lines, goods_value_inr: r2(v.goods_value_inr), share_pct: r1(v.share * 100),
      freight: v.freight_terms === 'extra' ? (v.freight_amount_inr == null ? 'Extra, no amount' : `Extra, ${r2(v.freight_amount_inr)}`) : v.freight_terms === 'included' ? 'Included' : 'Not stated',
      landed_total_inr: r2(v.landed_total_inr), landed_complete: v.landed_complete ? 'Yes' : 'No, a floor', questionnaire: v.questionnaire ?? 'Not read',
    })),
  };
  const notConfirmed: Table = {
    name: 'not_confirmed', title: 'Awarded cells that are not Confirmed',
    columns: [{ key: 'vendor_key', label: 'Vendor', type: 'text' }, { key: 'line_code', label: 'Line', type: 'text' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'annual_value_inr', label: 'Annual value', type: 'inr' }],
    rows: res.reliance.not_confirmed.map((c) => ({ vendor_key: c.vendor_key, line_code: c.line_code, status: STATUS_LABEL[toCellStatus(c.status)], annual_value_inr: r2(c.annual_value_inr), quote_line_id: c.quote_line_id })),
  };
  const gaps: Table = {
    name: 'gaps', title: 'Coverage gaps',
    columns: [{ key: 'line_code', label: 'Line', type: 'text' }, { key: 'annual_qty', label: 'Annual qty', type: 'int' }, { key: 'ly_value_inr', label: 'Last year value', type: 'inr' }, { key: 'reason', label: 'Reason', type: 'text' }],
    rows: res.coverage_gaps.map((g) => ({ line_code: g.line_code, annual_qty: g.annual_qty, ly_value_inr: r2(g.ly_value_inr), reason: g.reason })),
  };
  return [alloc, byVendor, ...(res.reliance.not_confirmed.length ? [notConfirmed] : []), ...(res.coverage_gaps.length ? [gaps] : [])];
}

export function describeScenario(s: Scenario, a: AssumptionOverrides): string {
  const f = s.filters;
  const bits = [
    `strategy ${s.strategy}`,
    `eligibility ${f.eligibility}`,
    `price basis ${f.price_basis}`,
    `discounts ${f.apply_discounts ? 'applied where earned' : 'not applied'}`,
  ];
  if (f.exclude_vendors.length) bits.push(`excluding ${f.exclude_vendors.join(', ')}`);
  if (f.include_vendors) bits.push(`only ${f.include_vendors.join(', ')}`);
  if (s.constraints.vendor) bits.push(`vendor ${s.constraints.vendor}`);
  if (s.constraints.max_share != null) bits.push(`max share ${Math.round(s.constraints.max_share * 100)} percent`);
  if (a.usd_inr != null) bits.push(`USD rate ${a.usd_inr}`);
  if (a.gst_pct != null) bits.push(`GST ${a.gst_pct} percent`);
  return bits.join('; ');
}

export function awardForModel(res: AwardResult, id: string, assumptions: Assump, overrides: AssumptionOverrides) {
  const disp = formatInrCompact;
  return {
    result_id: id,
    scenario: res.scenario,
    scenario_text: describeScenario(res.scenario, overrides),
    assumptions_in_force: { usd_inr: assumptions.usd_inr, gst_pct: assumptions.gst_pct, scenario_override: Object.keys(overrides).length > 0 },
    eligibility_label: res.eligibility_label,
    vendors_considered: res.vendors_considered.map((v) => ({ vendor: v.vendor_key, name: v.vendor_name, eligible: v.eligible, reason: v.reason })),
    totals: {
      lines_awarded: res.totals.lines_awarded,
      lines_total: res.totals.lines_total,
      goods_total_inr: r2(res.totals.goods_total_inr),
      goods_total_display: disp(res.totals.goods_total_inr),
      landed_total_inr: r2(res.totals.landed_total_inr),
      landed_total_display: disp(res.totals.landed_total_inr),
      landed_complete: res.totals.landed_complete,
      ly_value_of_awarded_lines_inr: r2(res.totals.ly_value_of_awarded_lines_inr),
      savings_vs_ly_inr: r2(res.totals.savings_vs_ly_inr),
      savings_vs_ly_display: disp(res.totals.savings_vs_ly_inr),
      savings_vs_ly_pct: r1(res.totals.savings_vs_ly_pct),
      ly_value_of_gap_lines_inr: r2(res.totals.ly_value_of_gap_lines_inr),
    },
    by_vendor: res.by_vendor.map((v) => ({
      vendor: v.vendor_key, name: v.vendor_name, lines: v.lines, goods_value_inr: r2(v.goods_value_inr), goods_value_display: disp(v.goods_value_inr), share_pct: r1(v.share * 100),
      freight: v.freight_terms, freight_amount_inr: r2(v.freight_amount_inr), landed_total_inr: r2(v.landed_total_inr), landed_complete: v.landed_complete, landed_note: v.landed_note, questionnaire: v.questionnaire,
    })),
    allocation: res.allocation.map((a) => ({
      line: a.line_code, vendor: a.vendor_key, status: a.status, price: r2(a.price), list_price: a.discount_pct != null ? r2(a.base_price) : undefined, discount_pct: a.discount_pct ?? undefined,
      annual_value_inr: r2(a.annual_value_inr), ly_rate: r2(a.ly_rate), next_best: a.runner_up ? `${a.runner_up.vendor_key} at ${r2(a.runner_up.price)}` : undefined, gap: a.gap_reason ?? undefined,
    })),
    coverage_gaps: res.coverage_gaps.map((g) => ({ line: g.line_code, ly_value_inr: r2(g.ly_value_inr), reason: g.reason, quoted_by_ineligible: g.quoted_by_ineligible.map((q) => `${q.vendor_key} at ${r2(q.price)}`) })),
    concentration: { top_vendor: res.concentration.top_vendor_key, top_share_pct: r1(res.concentration.top_share * 100), vendor_count: res.concentration.vendor_count, hhi: Math.round(res.concentration.hhi * 1000) / 1000 },
    reliance: {
      confirmed_cells: res.reliance.confirmed, assumed_cells: res.reliance.assumed, needs_review_cells: res.reliance.needs_review, conflict_cells: res.reliance.conflict, missing_lines: res.reliance.missing,
      confirmed_value_inr: r2(res.reliance.confirmed_value_inr), assumed_value_inr: r2(res.reliance.assumed_value_inr), unresolved_value_inr: r2(res.reliance.unresolved_value_inr),
      largest_not_confirmed: res.reliance.not_confirmed.slice(0, 8).map((c) => ({ vendor: c.vendor_key, line: c.line_code, status: c.status, annual_value_inr: r2(c.annual_value_inr) })),
      not_confirmed_total_cells: res.reliance.not_confirmed.length,
    },
    unresolved_that_change_result: res.unresolved_that_change_result.map((c) => ({ vendor: c.vendor_key, line: c.line_code, status: c.status, annual_value_inr: r2(c.annual_value_inr), would_change: c.would_change, quote_line_id: c.quote_line_id })),
    assumed_excluded_that_change_result: res.assumed_excluded_that_change_result.map((c) => ({ vendor: c.vendor_key, line: c.line_code, annual_value_inr: r2(c.annual_value_inr), would_change: c.would_change })),
    total_if_unresolved_taken_as_read_inr: r2(res.total_if_unresolved_taken_as_read_inr),
    discounts: res.discounts.map((d) => ({
      vendor: d.vendor_key, percent: d.percent, condition: d.condition, threshold_inr: d.threshold_inr, vendor_po_value_at_list_inr: r2(d.vendor_po_value_inr), threshold_met: d.met, applied: d.applied,
      lines_won_that_carry_it: d.affected_lines_won, saving_inr: r2(d.saving_inr), potential_saving_inr: r2(d.potential_saving_inr), gap_to_threshold_inr: r2(d.gap_to_threshold_inr), note: d.note,
    })),
    discount_fixed_point: { converged: res.fixed_point.converged, iterations: res.fixed_point.iterations, note: res.fixed_point.note, tried: res.fixed_point.tried.map((t) => ({ start: t.start, converged: t.converged, total_goods_inr: r2(t.total_goods_inr), applied: t.applied })) },
    left_out_vendors_were_cheaper: res.excluded_cheaper.map((e) => ({ vendor: e.vendor_key, lines_cheaper: e.lines_cheaper, saving_if_taken_inr: r2(e.saving_if_taken_inr), caveat: 'Upper bound: ignores that vendor\'s discounts, freight and the reason it is left out.' })),
    warnings: res.warnings,
    readiness: { level: res.readiness.label, summary: res.readiness.summary, included_vendors: res.readiness.included_vendors, blockers: res.readiness.blockers, open_items: res.readiness.open_items },
  };
}

async function simulate(ctx: ToolCtx, input: z.infer<typeof TOOL_SCHEMAS.simulate_award>): Promise<ToolOutcome> {
  const data = await ctx.data();
  const { patch, errors } = resolveScenarioRefs(data, input);
  if (errors.length) return { model: { error: errors.join(' ') }, summary: errors[0] ?? 'Unknown vendor', error: true };
  const prev = input.reset ? undefined : ctx.state.scenario;
  const base: Scenario = prev ?? { strategy: 'cheapest_per_line', filters: { eligibility: 'cleared', exclude_vendors: [], include_vendors: null, apply_discounts: false, price_basis: 'confirmed_assumed' }, constraints: { vendor: null, max_share: null } };
  const scenario = mergeScenario(base, patch);
  const overrides: AssumptionOverrides = { ...(input.reset ? {} : ctx.state.assumptions), ...(input.assumptions ?? {}) };
  const a: Assump = { ...globalAssumptions(data.compare), ...overrides };
  let res: AwardResult;
  try {
    res = simulateAward(buildAwardInput(data, a), scenario);
  } catch (e) {
    if (e instanceof AwardError) return { model: { error: e.message, code: e.code }, summary: e.message, error: true, scenario };
    throw e;
  }
  // The scenario carries over to the next question. One off assumptions on this call do not.
  ctx.state.scenario = scenario;
  if (input.reset) ctx.state.assumptions = {};
  const id = ctx.newResultId();
  const title = input.title ?? `Award scenario ${id}`;
  const result: StoredResult = {
    id, kind: 'award', title,
    notes: [`Scenario: ${describeScenario(scenario, overrides)}`, `Assumptions: USD to INR ${a.usd_inr}, GST ${a.gst_pct} percent${Object.keys(overrides).length ? ' (scenario override)' : ''}`, ...res.warnings],
    tables: awardTables(res),
    data: { award: res, assumptions: a, overrides },
  };
  ctx.results.set(id, result);
  return {
    model: awardForModel(res, id, a, overrides),
    summary: `${res.totals.lines_awarded} of ${res.totals.lines_total} lines awarded, goods ${formatInrCompact(res.totals.goods_total_inr)}`,
    result, scenario, assumptions: overrides, rows_used: res.allocation.length,
  };
}

// ---------------------------------------------------------------- get_evidence

async function getEvidence(ctx: ToolCtx, input: z.infer<typeof TOOL_SCHEMAS.get_evidence>): Promise<ToolOutcome> {
  const data = await ctx.data();
  let key: string | null = null;
  if (input.vendor) {
    key = resolveVendor(data.compare, input.vendor);
    if (!key) return { model: { error: `Unknown vendor "${input.vendor}".` }, summary: 'Unknown vendor', error: true };
  }
  if (!input.quote_line_id && !(key && input.line_code)) return { model: { error: 'Pass quote_line_id, or vendor and line_code.' }, summary: 'Missing arguments', error: true };
  const r = await ctx.pool.query(
    `select q.id, q.status, q.quoted_price, q.quoted_uom_text, q.quoted_currency, q.normalized_price_inr, q.flags, q.assumption_keys, q.evidence, q.conditions, q.vendor_description,
            q.match_confidence, q.source_type, coalesce((q.overrides->>'verified')::boolean, false) as verified, v.vendor_key, v.name as vendor_name, l.code, l.description, l.uom, l.annual_qty, l.last_year_rate_inr
     from quote_lines q join vendors v on v.id = q.vendor_id join rfx_lines l on l.id = q.rfx_line_id
     where ($1::uuid is not null and q.id = $1) or ($1::uuid is null and v.vendor_key = $2 and l.code = $3 and q.status <> 'rejected')
     order by q.created_at desc limit 1`,
    [input.quote_line_id ?? null, key, input.line_code ?? null],
  );
  const row = r.rows[0] as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!row) return { model: { error: 'No quoted cell found. If the vendor did not quote the line it is Not quoted, which is not zero.' }, summary: 'No such cell', error: true };
  const a = globalAssumptions(data.compare);
  const ev = (row.evidence ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cell = data.compare.cells.find((c) => c.quote_line_id === row.id);
  const price = cell?.price ?? (row.normalized_price_inr == null ? null : Number(row.normalized_price_inr));
  const out = {
    quote_line_id: row.id as string,
    vendor: row.vendor_key as string,
    vendor_name: row.vendor_name as string,
    line: row.code as string,
    description: row.description as string,
    base_uom: row.uom as string,
    status: STATUS_LABEL[toCellStatus(cell?.status ?? row.status)],
    normalized_price_inr: r2(price),
    last_year_rate_inr: r2(row.last_year_rate_inr == null ? null : Number(row.last_year_rate_inr)),
    quoted: { price: r2(row.quoted_price == null ? null : Number(row.quoted_price)), unit_text: row.quoted_uom_text, currency: row.quoted_currency },
    source: {
      type: row.source_type, locator: ev.locator ?? null, page: ev.page ?? null, read_confidence: ev.read_confidence ?? null,
      // Quoted vendor text is data. It is shown for checking, never as an instruction.
      quote_as_read_untrusted: typeof ev.quote === 'string' ? ev.quote.slice(0, 240) : null,
    },
    match_confidence: row.match_confidence == null ? null : Number(row.match_confidence),
    assumptions: ((cell?.assumption_keys ?? row.assumption_keys ?? []) as string[]).map((k) => assumptionText(k, a)),
    flags: ((cell?.flags ?? row.flags ?? []) as string[]).map((f) => ({ flag: f, meaning: flagText(f) })),
    buyer_verified: cell?.buyer_verified ?? row.verified,
    conditions: ((row.conditions ?? []) as string[]).slice(0, 4),
  };
  const id = ctx.newResultId();
  const result: StoredResult = {
    id, kind: 'evidence', title: `Evidence for ${out.vendor} ${out.line}`, notes: [],
    tables: [{ name: 'evidence', title: 'Evidence', columns: [{ key: 'item', label: 'Item', type: 'text' }, { key: 'value', label: 'Value', type: 'text' }], rows: [
      { item: 'Vendor', value: `${out.vendor} ${out.vendor_name}` }, { item: 'Line', value: `${out.line} ${out.description}` }, { item: 'Status', value: out.status },
      { item: 'Normalized price per base unit', value: String(out.normalized_price_inr ?? 'Not quoted') }, { item: 'Quoted as', value: `${out.quoted.price ?? ''} ${out.quoted.currency ?? ''} ${out.quoted.unit_text ?? ''}`.trim() },
      { item: 'Source', value: `${out.source.type ?? ''} ${out.source.locator ?? ''}`.trim() }, ...out.assumptions.map((t) => ({ item: 'Assumption', value: t })), ...out.flags.map((f) => ({ item: 'Flag', value: f.meaning })),
    ] }],
  };
  ctx.results.set(id, result);
  return { model: { result_id: id, ...out }, summary: `Evidence for ${out.vendor} ${out.line}`, result, rows_used: 1, evidence_ids: [out.quote_line_id] };
}

// ---------------------------------------------------------------- list_open_issues

const SHORT_ASSUMPTION: Record<string, string> = {
  usd_inr: 'Priced in USD with no rate stated; the assumed rate is used',
  pack_size: 'Quoted per pack; pack size comes from the vendor footnote',
  last_year_inheritance: 'Same as last year, no price stated; last year\'s rate is used',
  tax_basis_assumed_excl: 'GST basis not stated; read as excluding GST',
  gst_pct: 'Quoted including GST; converted at the assumed percent',
};

async function listOpenIssues(ctx: ToolCtx, input: z.infer<typeof TOOL_SCHEMAS.list_open_issues>): Promise<ToolOutcome> {
  const data = await ctx.data();
  const c = data.compare;
  let vendorId: string | null = null;
  if (input.vendor) {
    const k = resolveVendor(c, input.vendor);
    if (!k) return { model: { error: `Unknown vendor "${input.vendor}".` }, summary: 'Unknown vendor', error: true };
    vendorId = c.vendors.find((v) => v.key === k)?.id ?? null;
  }
  const lineById = new Map(c.lines.map((l) => [l.id, l]));
  const vendorById = new Map(c.vendors.map((v) => [v.id, v]));
  const totalByVendor = new Map<string, number>();
  for (const x of c.cells) if (x.price != null) totalByVendor.set(x.vendor_id, (totalByVendor.get(x.vendor_id) ?? 0) + x.price * (lineById.get(x.rfx_line_id)?.annual_qty ?? 0));
  type Row = { vendor: string; line_code: string; tier: string; status: string; kind: string; severity: string; message: string; value_at_stake_inr: number; quote_line_id: string | null };
  const rows: Row[] = [];
  for (const x of c.cells) {
    const st = toCellStatus(x.status);
    if (x.price == null || st === 'confirmed' || st === 'missing') continue;
    const l = lineById.get(x.rfx_line_id);
    if (!l) continue;
    const why = x.assumption_keys.length ? x.assumption_keys.map((k) => SHORT_ASSUMPTION[k] ?? k.replaceAll('_', ' ')).join('; ') : x.source_type === 'image' ? 'Read from a photo; a person has not checked the crop' : x.flags.map(flagText).join('; ') || 'Not confirmed';
    rows.push({ vendor: vendorById.get(x.vendor_id)?.key ?? '', line_code: l.code, tier: 'cell', status: STATUS_LABEL[st], kind: `cell_${st}`, severity: st === 'assumed' ? 'info' : 'warn', message: why, value_at_stake_inr: x.price * l.annual_qty, quote_line_id: x.quote_line_id });
  }
  for (const i of data.items) {
    if (i.severity === 'info') continue;
    if (['line_needs_review', 'conflict'].includes(i.kind)) continue;
    rows.push({ vendor: vendorById.get(i.vendor_id)?.key ?? '', line_code: i.line_code ?? '', tier: 'vendor item', status: 'Open', kind: i.kind, severity: i.severity, message: i.message, value_at_stake_inr: i.value_at_stake_inr ?? totalByVendor.get(i.vendor_id) ?? 0, quote_line_id: i.quote_line_id });
  }
  const filtered = rows.filter((r) => (!vendorId || vendorById.get(vendorId)?.key === r.vendor) && r.value_at_stake_inr >= (input.min_value ?? 0)).sort((a, b) => b.value_at_stake_inr - a.value_at_stake_inr);
  const cellRows = filtered.filter((r) => r.tier === 'cell');
  const byVendor = new Map<string, { cells: number; value: number; items: number }>();
  for (const r of filtered) {
    const v = byVendor.get(r.vendor) ?? { cells: 0, value: 0, items: 0 };
    if (r.tier === 'cell') {
      v.cells++;
      v.value += r.value_at_stake_inr;
    } else v.items++;
    byVendor.set(r.vendor, v);
  }
  const id = ctx.newResultId();
  const table: Table = {
    name: 'issues', title: 'Open issues ranked by rupees at stake',
    columns: [{ key: 'vendor', label: 'Vendor', type: 'text' }, { key: 'line_code', label: 'Line', type: 'text' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'kind', label: 'Kind', type: 'text' }, { key: 'severity', label: 'Severity', type: 'text' }, { key: 'value_at_stake_inr', label: 'Rupees at stake', type: 'inr' }, { key: 'message', label: 'Why', type: 'text' }],
    rows: filtered.map((r) => ({ ...r, value_at_stake_inr: r2(r.value_at_stake_inr) })),
  };
  const result: StoredResult = {
    id, kind: 'issues', title: 'Open issues ranked by rupees at stake',
    notes: ['Assumed, Needs review and Conflict cells at annual quantity and current assumptions, plus open vendor level items. For a vendor item with no price of its own, the value shown is that vendor\'s whole quoted annual total, the most that depends on it.', 'Cells and items are not additive across the two tiers.'],
    tables: [table],
  };
  ctx.results.set(id, result);
  const limit = input.limit ?? 40;
  return {
    model: {
      result_id: id,
      cell_items: cellRows.length,
      vendor_items: filtered.length - cellRows.length,
      assumed_cells: cellRows.filter((r) => r.status === 'Assumed').length,
      needs_review_cells: cellRows.filter((r) => r.status === 'Needs review').length,
      conflict_cells: cellRows.filter((r) => r.status === 'Conflict').length,
      cell_value_at_stake_inr: r2(cellRows.reduce((s, r) => s + r.value_at_stake_inr, 0)),
      by_vendor: [...byVendor.entries()].map(([vendor, v]) => ({ vendor, cell_items: v.cells, cell_value_inr: r2(v.value), vendor_items: v.items })),
      rows: filtered.slice(0, limit).map((r) => ({ vendor: r.vendor, line: r.line_code || undefined, status: r.status, kind: r.kind, severity: r.severity, value_at_stake_inr: r2(r.value_at_stake_inr), why: r.message })),
      rows_not_shown: Math.max(0, filtered.length - limit),
      note: 'Vendor item values are that vendor\'s whole quoted total and overlap with its cell values. Do not add the two tiers together.',
    },
    summary: `${filtered.length} open items`, result, rows_used: filtered.length,
  };
}

// ---------------------------------------------------------------- assumptions

async function getAssumptions(ctx: ToolCtx): Promise<ToolOutcome> {
  const c = (await ctx.data()).compare;
  const g = globalAssumptions(c);
  return {
    model: {
      global: c.assumptions.map((a) => ({ key: a.key, label: a.label, value: a.value, set_by: a.set_by, default: a.default_value })),
      scenario_overrides: ctx.state.assumptions,
      in_force: { ...g, ...ctx.state.assumptions },
      applied_to_cells: c.derived_assumptions.map((d) => ({ label: d.label, vendor: d.vendor_key, detail: d.detail, lines: d.lines, set_by: d.set_by })),
      note: 'Scenario overrides apply only inside this chat. The buyer\'s global assumption is unchanged.',
    },
    summary: 'Assumptions read', assumptions: ctx.state.assumptions,
  };
}

async function setScenarioAssumption(ctx: ToolCtx, input: z.infer<typeof TOOL_SCHEMAS.set_scenario_assumption>): Promise<ToolOutcome> {
  ctx.state.assumptions = { ...ctx.state.assumptions, [input.key]: input.value };
  const g = globalAssumptions((await ctx.data()).compare);
  return {
    model: { set: { [input.key]: input.value }, in_force: { ...g, ...ctx.state.assumptions }, buyer_global_unchanged: g, note: 'Scenario only. The buyer\'s global assumption was not changed.' },
    summary: `Scenario ${input.key} set to ${input.value}`, assumptions: ctx.state.assumptions,
  };
}

// ---------------------------------------------------------------- make_chart

function dig(obj: unknown, path: string): number | null {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

async function makeChart(ctx: ToolCtx, input: z.infer<typeof TOOL_SCHEMAS.make_chart>): Promise<ToolOutcome> {
  const fail = (m: string): ToolOutcome => ({ model: { error: m }, summary: m, error: true });
  const get = (id: string) => ctx.results.get(id);
  const series: ChartPayload['series'] = [];
  const sources = new Set<string>();
  if (input.source.mode === 'table') {
    const src = input.source;
    const res = get(src.result_id);
    if (!res) return fail(`There is no result "${src.result_id}". Use a result_id from an earlier tool call.`);
    const t = src.table ? res.tables.find((x) => x.name === src.table) : res.tables[0];
    if (!t) return fail(`Result ${res.id} has no table "${src.table}". Tables: ${res.tables.map((x) => x.name).join(', ')}.`);
    const cols = new Set(t.columns.map((c) => c.key));
    if (!cols.has(src.x_column)) return fail(`Column "${src.x_column}" is not in the table. Columns: ${[...cols].join(', ')}.`);
    const rows = t.rows.slice(0, src.limit ?? 60);
    const xOf = (r: Record<string, unknown>): string | number => (typeof r[src.x_column] === 'number' ? (r[src.x_column] as number) : String(r[src.x_column]));
    for (const y of src.y_columns) {
      if (!cols.has(y)) return fail(`Column "${y}" is not in the table. Columns: ${[...cols].join(', ')}.`);
      const pts = rows.flatMap((r) => (typeof r[y] === 'number' ? [{ x: xOf(r), y: r[y] as number }] : []));
      if (pts.length === 0) return fail(`Column "${y}" has no numbers to plot.`);
      series.push({ name: t.columns.find((c) => c.key === y)?.label ?? y, points: pts });
    }
    sources.add(res.id);
  } else {
    const pts: { x: string; y: number }[] = [];
    for (const p of input.source.points) {
      const res = get(p.result_id);
      if (!res) return fail(`There is no result "${p.result_id}".`);
      const v = dig(res.data, p.field) ?? dig((res.data as { award?: unknown } | undefined)?.award, p.field);
      if (v == null) return fail(`Field "${p.field}" is not a number in result ${p.result_id}. Example: totals.goods_total_inr.`);
      pts.push({ x: p.label, y: Math.round(v * 100) / 100 });
      sources.add(res.id);
    }
    series.push({ name: input.source.series_name, points: pts });
  }
  const chart: ChartPayload = { type: input.type, title: input.title, x_label: input.x_label ?? null, y_label: input.y_label ?? null, unit: input.unit, series, sources: [...sources] };
  return { model: { chart_created: true, title: chart.title, type: chart.type, series: series.map((s) => ({ name: s.name, points: s.points.length })), note: 'The chart is drawn from the stored result. Do not repeat its data points in text unless they appear in a tool result.' }, summary: `Chart: ${chart.title}`, chart };
}

// ---------------------------------------------------------------- export

async function exportTool(ctx: ToolCtx, input: z.infer<typeof TOOL_SCHEMAS.export>): Promise<ToolOutcome> {
  const res = ctx.results.get(input.source);
  if (!res) return { model: { error: `There is no result "${input.source}".` }, summary: 'No such result', error: true };
  const rows = res.tables.reduce((s, t) => s + t.rows.length, 0);
  const base = (input.filename ?? res.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'export';
  const chip: ExportChip = {
    result_id: res.id, format: input.format, filename: `${base}.${input.format}`, rows,
    url: `/api/export?session=${ctx.sessionId}&result=${encodeURIComponent(res.id)}&format=${input.format}&name=${encodeURIComponent(base)}`,
  };
  return { model: { export_ready: true, filename: chip.filename, format: chip.format, rows: chip.rows, note: 'A download chip is shown to the user. Tell them the file is ready; do not invent a link.' }, summary: `Export ready: ${chip.filename}`, export: chip, rows_used: rows };
}

// ---------------------------------------------------------------- dispatcher

export async function executeTool(ctx: ToolCtx, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (!(name in TOOL_SCHEMAS)) return { model: { error: `Unknown tool "${name}".` }, summary: `Unknown tool ${name}`, error: true };
  const tool = name as ToolName;
  const parsed = TOOL_SCHEMAS[tool].safeParse(rawInput ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return { model: { error: `Invalid input. ${msg}` }, summary: `Invalid input: ${msg}`, error: true };
  }
  try {
    switch (tool) {
      case 'query_comparison': return await queryComparison(ctx, parsed.data as z.infer<typeof TOOL_SCHEMAS.query_comparison>);
      case 'simulate_award': return await simulate(ctx, parsed.data as z.infer<typeof TOOL_SCHEMAS.simulate_award>);
      case 'get_evidence': return await getEvidence(ctx, parsed.data as z.infer<typeof TOOL_SCHEMAS.get_evidence>);
      case 'list_open_issues': return await listOpenIssues(ctx, parsed.data as z.infer<typeof TOOL_SCHEMAS.list_open_issues>);
      case 'get_assumptions': return await getAssumptions(ctx);
      case 'set_scenario_assumption': return await setScenarioAssumption(ctx, parsed.data as z.infer<typeof TOOL_SCHEMAS.set_scenario_assumption>);
      case 'make_chart': return await makeChart(ctx, parsed.data as z.infer<typeof TOOL_SCHEMAS.make_chart>);
      case 'export': return await exportTool(ctx, parsed.data as z.infer<typeof TOOL_SCHEMAS.export>);
    }
  } catch (e) {
    return { model: { error: 'The tool failed. Try a simpler request.' }, summary: `Tool failed: ${(e as Error).message.slice(0, 120)}`, error: true };
  }
}

export { safeMessage };
