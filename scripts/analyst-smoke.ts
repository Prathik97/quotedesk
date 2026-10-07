// Dev check: runs every analyst tool against the live database. No model call, no cost.
import 'dotenv/config';
import { config } from 'dotenv';
import { db, roDb } from '../api/_lib/db.js';
import { loadAnalystData } from '../api/_lib/analyst/data.js';
import { executeTool, type ToolCtx } from '../api/_lib/analyst/tools.js';
import { DEFAULT_SCENARIO } from '../engine/award.js';

config({ path: '.env.local' });
const pool = db();
let data: Awaited<ReturnType<typeof loadAnalystData>> | null = null;
let n = 0;
const ctx: ToolCtx = {
  pool, ro: roDb(), sessionId: 'smoke', state: { scenario: DEFAULT_SCENARIO, assumptions: {} }, results: new Map(),
  data: async () => (data ??= await loadAnalystData(pool)), newResultId: () => `r${++n}`,
};
const show = async (name: string, input: unknown, max = 900) => {
  const t = Date.now();
  const o = await executeTool(ctx, name, input);
  console.log(`\n## ${name} ${JSON.stringify(input).slice(0, 140)}  (${Date.now() - t} ms) ${o.error ? 'ERROR' : ''}\n${o.summary}\n${JSON.stringify(o.model).slice(0, max)}`);
  return o;
};
await show('query_comparison', { sql: 'select vendor_name, lines_quoted, questionnaire_result from vendor_summary_view order by 1' });
await show('query_comparison', { sql: 'select * from rfx' });
await show('query_comparison', { sql: 'select count(*) from vendor_terms_view' });
await show('query_comparison', { sql: 'select count(*) from open_issues_view' });
await show('simulate_award', { filters: { eligibility: 'cleared' } }, 1500);
await show('simulate_award', { filters: { exclude_vendors: ['Kaveri'] } }, 400);
await show('simulate_award', { assumptions: { usd_inr: 85 }, filters: { eligibility: 'all' } }, 300);
await show('list_open_issues', { limit: 5 }, 1200);
await show('get_assumptions', {}, 1200);
await show('get_evidence', { vendor: 'V4', line_code: 'CRT-5P-01' }, 1500);
await show('make_chart', { type: 'bar', title: 't', source: { mode: 'table', result_id: 'r5', table: 'by_vendor', x_column: 'vendor', y_columns: ['goods_value_inr'] } }, 300);
await show('export', { format: 'xlsx', source: 'r5' }, 300);
await pool.end();
await ctx.ro.end();
