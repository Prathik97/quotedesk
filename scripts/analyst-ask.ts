// Dev check: asks the running dev server one question through the real /api/analyst route and
// prints the working steps, the answer, the checks and the cost. One question per run, on purpose.
// Usage: npx tsx scripts/analyst-ask.ts "question" [--session <id>] [--out file.json]
import fs from 'node:fs';
import pg from 'pg';
import { pgConfig } from '../api/_lib/pgconfig.js';
import { loadEnvLocal, requireEnv } from './envfile.js';
import { budgetSessionId } from '../api/_lib/llm/session.js';
import { flag, option } from './runtime.js';

loadEnvLocal();
const question = process.argv[2];
if (!question || question.startsWith('--')) throw new Error('Pass the question as the first argument.');
const base = option('base') ?? 'http://localhost:5173';
const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 2 }));
const spendNow = async () => Number((await pool.query('select coalesce(sum(est_cost_inr),0) s from usage_log where session_id=$1 and not cache_hit', [budgetSessionId()])).rows[0].s);
const before = await spendNow();
const res = await fetch(`${base}/api/analyst`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: option('session'), message: question }) });
if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
let sid = option('session') ?? '';
const results: Record<string, unknown>[] = [];
let final: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
const charts: unknown[] = [];
const exportsOut: unknown[] = [];
let err: string | null = null;
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.type === 'session') sid = e.session_id;
    else if (e.type === 'step' && e.status !== 'running') console.log(`  step [${e.status}] ${e.label}: ${e.summary}`);
    else if (e.type === 'result') results.push(e.result);
    else if (e.type === 'chart') charts.push(e.chart);
    else if (e.type === 'export') exportsOut.push(e.chip);
    else if (e.type === 'final') final = e.answer;
    else if (e.type === 'error') err = e.message;
  }
}
console.log(`\nsession ${sid}`);
if (err) console.log(`ERROR: ${err}`);
if (final) {
  console.log(`\nANSWER:\n${final.body}`);
  if (final.callout) console.log(`\nCALLOUT: ${final.callout}`);
  for (const a of final.alternatives) console.log(`CHIP: ${a.label} -> ${a.question}`);
  for (const w of final.warnings) console.log(`WARNING: ${w}`);
  console.log(`\nnumber check: ${final.number_check.ok ? 'PASSED' : 'FAILED'} (${final.number_check.checked} figures checked${final.number_check.ok ? '' : ', unmatched ' + final.number_check.unmatched.join(', ')})`);
  console.log(`tools: ${final.how.steps.map((s: { tool: string }) => s.tool).join(', ') || 'none'}`);
  for (const s of final.how.steps) if (s.sql) console.log(`  SQL: ${s.sql}`);
  const u = final.usage;
  console.log(`cost: Rs ${u.cost_inr.toFixed(2)} (${u.model_calls} calls, in ${u.tokens_in}, out ${u.tokens_out}, cache read ${u.cache_read_tokens}, cache write ${u.cache_write_tokens})`);
}
const after = await spendNow();
console.log(`session spend: Rs ${after.toFixed(2)} (this question Rs ${(after - before).toFixed(2)}) of the Rs 250 Phase 5 budget`);
const out = option('out');
if (out) fs.writeFileSync(out, JSON.stringify({ question, session: sid, final, results, charts, exports: exportsOut, error: err }, null, 1));
if (flag('json') && final) console.log(JSON.stringify(final.how, null, 1));
await pool.end();
