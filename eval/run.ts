// Evaluation harness. The ONLY code that reads seed/out/truth.json.
//   npm run eval -- --dry-run      cost estimate, no API calls
//   npm run eval -- --fresh        real calls for every document (the number that counts)
//   npm run eval                   cache allowed; hits are labelled in the report
//   npm run eval -- --score-only   score the current database state, no extraction
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { pgConfig } from '../api/_lib/pgconfig.js';
import { loadEnvLocal, requireEnv } from '../scripts/envfile.js';
import { planDocuments, printPlan, runAll } from '../scripts/extract-all.js';
import { flag } from '../scripts/runtime.js';

type TruthLine = {
  quoted: boolean;
  true_unit_price_inr: number | null;
  as_written: { price: number | null; unit: string | null; currency: string; per_n?: number } | null;
  conversion_factor: string | null;
  expected_status: string;
  edges: string[];
  notes: string | null;
  conditions: unknown[];
};
type TruthQ = { answer_text: string; value: unknown; status: string };
type TruthVendor = {
  name: string;
  coverage: number;
  lines: Record<string, TruthLine>;
  questionnaire: Record<string, TruthQ>;
  questionnaire_result: { result: string };
  terms: { freight: string };
};
type Truth = { meta: { usd_inr: number }; vendors: Record<string, TruthVendor> };

type Row = { id: string; code: string; status: string; normalized: number | null; quoted_price: number | null; flags: string[]; assumption_keys: string[]; conditions: unknown[]; evidence: { locator?: string; quote?: string | null } | null; source_type: string; filename: string };

const TRUTH_PATH = path.resolve('seed/out/truth.json');
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const exact = (a: number | null, b: number | null) => a != null && b != null && near(a, b, 0.005);
const within1 = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a / b - 1) <= 0.01;

export async function score(pool: pg.Pool, runId: string | null) {
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, 'utf8')) as Truth;
  const vendors = (await pool.query<{ id: string; key: string }>(`select v.id, v.vendor_key as key from vendors v join rfx r on r.id = v.rfx_id and r.is_saved_demo`)).rows;
  const vid = new Map(vendors.map((v) => [v.key, v.id]));

  const rowsAll = (await pool.query<Row & { vendor_id: string }>(
    `select q.id, q.vendor_id, l.code, q.status, q.normalized_price_inr::float8 as normalized, q.quoted_price::float8 as quoted_price,
            q.flags, q.assumption_keys, q.conditions, q.evidence, q.source_type, d.filename
     from quote_lines q join rfx_lines l on l.id = q.rfx_line_id join documents d on d.id = q.source_document_id
     where q.status <> 'rejected'`)).rows;
  const reviews = (await pool.query<{ vendor_id: string; kind: string; severity: string; message: string; filename: string | null }>(
    `select r.vendor_id, r.kind, r.severity, r.message, d.filename from review_items r left join documents d on d.id = r.document_id where r.state = 'open'`)).rows;
  const terms = (await pool.query<{ vendor_id: string; flags: string[]; conditional_discounts: { percent: number | null }[]; freight_terms: string }>(
    'select vendor_id, flags, conditional_discounts, freight_terms from vendor_terms')).rows;
  const answers = (await pool.query<{ vendor_id: string; code: string; status: string; answer_value: unknown; answer_raw: string }>(
    'select a.vendor_id, q.code, a.status, a.answer_value, a.answer_raw from questionnaire_answers a join questionnaire_questions q on q.id = a.question_id')).rows;
  const docs = (await pool.query<{ vendor_id: string; filename: string; status: string; kind: string | null; error: string | null }>(
    'select vendor_id, filename, status, kind, error from documents')).rows;

  const lineMetrics = { truth_quoted: 0, recalled: 0, exact: 0, within1: 0, conv_lines: 0, conv_exact: 0, status_agree: 0, confirmed: 0, confident_wrong: 0, assumed_wrong: 0, correct_value: 0, false_alarm: 0, phantom: 0 };
  const confidentWrong: string[] = [];
  const failures: { vendor: string; code: string; problem: string; ours: string; truth: string; evidence: string }[] = [];
  const perVendor: Record<string, Record<string, number | string>> = {};
  let qTotal = 0;
  let qRight = 0;
  const qMismatch: string[] = [];

  for (const [key, tv] of Object.entries(truth.vendors)) {
    const id = vid.get(key) ?? '';
    const rows = rowsAll.filter((r) => r.vendor_id === id);
    const v = { truth_quoted: 0, recalled: 0, exact: 0, confirmed: 0, assumed: 0, needs_review: 0, conflict: 0, confident_wrong: 0 };
    for (const [code, tl] of Object.entries(tv.lines)) {
      const mine = rows.filter((r) => r.code === code);
      const best = mine.find((r) => r.normalized != null) ?? mine[0];
      if (!tl.quoted) {
        for (const r of mine) {
          lineMetrics.phantom++;
          if (r.status === 'confirmed') {
            lineMetrics.confident_wrong++;
            v.confident_wrong++;
            confidentWrong.push(`${key} ${code}: Confirmed at ${r.normalized} but the vendor did not quote this line.`);
          }
          failures.push({ vendor: key, code, problem: 'phantom line (vendor did not quote it)', ours: `${r.normalized} ${r.status}`, truth: 'not quoted', evidence: `${r.evidence?.locator ?? ''} "${r.evidence?.quote ?? ''}"` });
        }
        continue;
      }
      lineMetrics.truth_quoted++;
      v.truth_quoted++;
      if (!best) {
        failures.push({ vendor: key, code, problem: 'line not found', ours: 'missing', truth: `${tl.true_unit_price_inr}`, evidence: '' });
        continue;
      }
      lineMetrics.recalled++;
      v.recalled++;
      for (const r of mine) (v as Record<string, number>)[r.status] = ((v as Record<string, number>)[r.status] ?? 0) + 1;
      const isExact = exact(best.normalized, tl.true_unit_price_inr);
      if (isExact) {
        lineMetrics.exact++;
        v.exact++;
      }
      if (within1(best.normalized, tl.true_unit_price_inr)) lineMetrics.within1++;
      if (tl.conversion_factor && tl.conversion_factor !== '1') {
        lineMetrics.conv_lines++;
        if (isExact) lineMetrics.conv_exact++;
      }
      if (best.status === tl.expected_status) lineMetrics.status_agree++;
      for (const r of mine) {
        const ok = exact(r.normalized, tl.true_unit_price_inr);
        if (r.status === 'confirmed') {
          lineMetrics.confirmed++;
          if (!ok) {
            lineMetrics.confident_wrong++;
            v.confident_wrong++;
            confidentWrong.push(`${key} ${code}: Confirmed at ${r.normalized} but truth is ${tl.true_unit_price_inr}. Evidence ${r.evidence?.locator}: "${r.evidence?.quote}"`);
          }
        }
        if (r.status === 'assumed' && !ok) lineMetrics.assumed_wrong++;
      }
      if (isExact) {
        lineMetrics.correct_value++;
        if (['needs_review', 'conflict'].includes(best.status) && ['confirmed', 'assumed'].includes(tl.expected_status)) {
          lineMetrics.false_alarm++;
          failures.push({ vendor: key, code, problem: `right value but marked ${best.status}`, ours: `${best.normalized} ${best.status} [${best.flags.join(', ')}]`, truth: `${tl.true_unit_price_inr} ${tl.expected_status}`, evidence: `${best.evidence?.locator ?? ''} "${best.evidence?.quote ?? ''}"` });
        } else if (best.status !== tl.expected_status) {
          failures.push({ vendor: key, code, problem: `status ${best.status}, expected ${tl.expected_status}`, ours: `${best.normalized} [${best.flags.join(', ')}]`, truth: `${tl.true_unit_price_inr}`, evidence: `${best.evidence?.locator ?? ''} "${best.evidence?.quote ?? ''}"` });
        }
      } else {
        failures.push({ vendor: key, code, problem: best.normalized == null ? 'no normalized price' : 'wrong value', ours: `${best.normalized ?? 'none'} ${best.status} (as written ${best.quoted_price} ${best.flags.join(', ')})`, truth: `${tl.true_unit_price_inr} (as written ${tl.as_written?.price} ${tl.as_written?.unit})`, evidence: `${best.evidence?.locator ?? ''} "${best.evidence?.quote ?? ''}"` });
      }
    }

    // Questionnaire
    const mineQ = answers.filter((a) => a.vendor_id === id);
    for (const [code, tq] of Object.entries(tv.questionnaire)) {
      qTotal++;
      const a = mineQ.find((x) => x.code === code);
      const ourStatus = a?.status ?? 'unanswered';
      let ok = false;
      if (tq.status !== 'answered') ok = ourStatus === tq.status || (tq.status === 'unanswered' && !a);
      else if (ourStatus === 'answered' && a) ok = valueMatches(tq.value, a.answer_value);
      if (ok) qRight++;
      else qMismatch.push(`${key} ${code}: ours ${ourStatus} ${JSON.stringify(a?.answer_value ?? null)} vs truth ${tq.status} ${JSON.stringify(tq.value)}`);
    }
    const t = terms.find((x) => x.vendor_id === id);
    const qres = (t?.flags ?? []).find((f) => f.startsWith('questionnaire_'))?.replace('questionnaire_', '') ?? 'none';
    perVendor[key] = { ...v, coverage: `${v.recalled} of 30`, questionnaire: qres, questionnaire_truth: tv.questionnaire_result.result };
  }

  // Edges
  const rv = (key: string, kind: string) => reviews.filter((r) => r.vendor_id === vid.get(key) && r.kind === kind);
  const vRows = (key: string) => rowsAll.filter((r) => r.vendor_id === vid.get(key));
  const tLines = (key: string) => Object.entries(truth.vendors[key]?.lines ?? {});
  const share = (key: string, codes: string[], pred: (r: Row, tl: TruthLine) => boolean) => {
    const tl = truth.vendors[key]?.lines ?? {};
    const hits = codes.filter((c) => vRows(key).some((r) => r.code === c && tl[c] && pred(r, tl[c] as TruthLine)));
    return { n: hits.length, of: codes.length };
  };
  const qFlag = (key: string) => (terms.find((t) => t.vendor_id === vid.get(key))?.flags ?? []).find((f) => f.startsWith('questionnaire_')) ?? 'none';

  const e: Record<string, { detected: boolean; detail: string }> = {};
  {
    const all = tLines('V1').map(([c]) => c);
    const s = share('V1', all, (r, tl) => exact(r.normalized, tl.true_unit_price_inr));
    const hidden = rv('V1', 'hidden_sheet').length > 0;
    const leaked = vRows('V1').filter((r) => r.flags.includes('from_hidden_sheet')).length;
    e.E1 = { detected: s.n >= 28 && hidden && leaked === 0, detail: `${s.n}/${s.of} lines exact; hidden sheet surfaced: ${hidden}; lines taken from hidden sheet: ${leaked}` };
  }
  {
    const codes = tLines('V1').filter(([, t]) => t.edges.includes('E2')).map(([c]) => c);
    const s = share('V1', codes, (r, tl) => exact(r.normalized, tl.true_unit_price_inr) && r.status === 'confirmed');
    e.E2 = { detected: s.n === s.of, detail: `${s.n}/${s.of} per tonne lines exact per kg and Confirmed` };
  }
  {
    const t = terms.find((x) => x.vendor_id === vid.get('V2'));
    const disc = (t?.conditional_discounts ?? []).some((d) => d.percent === 4);
    const codes = tLines('V2').filter(([, t]) => t.edges.includes('E3')).map(([c]) => c);
    const s = share('V2', codes, (r, tl) => exact(r.normalized, tl.true_unit_price_inr));
    const cond = share('V2', codes, (r) => Array.isArray(r.conditions) && r.conditions.length > 0);
    e.E3 = { detected: disc && s.n === s.of, detail: `discount stored as condition: ${disc}; ${s.n}/${s.of} affected lines kept at undiscounted base price; ${cond.n}/${cond.of} lines carry the condition` };
  }
  e.E4 = { detected: rv('V2', 'total_mismatch').length > 0, detail: rv('V2', 'total_mismatch')[0]?.message ?? 'no total_mismatch raised' };
  {
    const omitted = tLines('V3').filter(([, t]) => !t.quoted).map(([c]) => c);
    const phantom = vRows('V3').filter((r) => omitted.includes(r.code)).length;
    const rec = perVendor.V3?.recalled ?? 0;
    e.E5 = { detected: rec === 27 && phantom === 0, detail: `coverage ${rec} of 30; rows for the 3 unquoted lines: ${phantom}; not_quoted review: ${rv('V3', 'not_quoted').length > 0}` };
  }
  e.E6 = { detected: rv('V3', 'attachment_name_mismatch').length > 0, detail: rv('V3', 'attachment_name_mismatch')[0]?.message ?? 'not raised' };
  {
    const codes = tLines('V4').filter(([, t]) => t.edges.includes('E7')).map(([c]) => c);
    const s = share('V4', codes, (r, tl) => exact(r.normalized, tl.true_unit_price_inr) && r.status === 'assumed');
    e.E7 = { detected: s.n >= Math.ceil(0.9 * s.of), detail: `${s.n}/${s.of} per box lines exact and Assumed` };
  }
  e.E8 = { detected: qFlag('V4') === 'questionnaire_failed', detail: `V4 questionnaire: ${qFlag('V4')}; expired certificate flagged: ${rv('V4', 'certificate_expired').length > 0}` };
  {
    const codes = tLines('V5').filter(([, t]) => t.notes === 'inherits_last_year').map(([c]) => c);
    const s = share('V5', codes, (r, tl) => exact(r.normalized, tl.true_unit_price_inr) && r.status === 'assumed' && r.assumption_keys.includes('last_year_inheritance'));
    e.E9 = { detected: s.n >= Math.ceil(0.9 * s.of), detail: `${s.n}/${s.of} inherited lines at last year rate and Assumed` };
  }
  {
    const codes = tLines('V5').filter(([, t]) => t.edges.includes('E10')).map(([c]) => c);
    const s = share('V5', codes, (r, tl) => exact(r.normalized, tl.true_unit_price_inr) && r.status === 'assumed' && r.assumption_keys.includes('usd_inr'));
    e.E10 = { detected: s.n === s.of, detail: `${s.n}/${s.of} USD lines converted at the assumed ${truth.meta.usd_inr} and Assumed` };
  }
  {
    const who = ['V3', 'V4', 'V5'].map((k) => `${k}:${rv(k, 'freight_amount_unknown').length > 0}`);
    e.E11 = { detected: who.every((w) => w.endsWith('true')), detail: `freight extra with no amount flagged ${who.join(' ')}` };
  }
  e.E12 = { detected: qFlag('V5') === 'questionnaire_pending', detail: `V5 questionnaire: ${qFlag('V5')}; pending knockouts listed: ${rv('V5', 'knockout_pending').length}` };
  {
    const sus = rv('V3', 'suspicious_content');
    const v3 = qFlag('V3');
    e.E13 = { detected: sus.length > 0 && v3 === 'questionnaire_cleared', detail: `suspicious content items on V3: ${sus.length}; V3 questionnaire still decided on its real answers: ${v3}` };
  }

  // Cost
  const usage = runId
    ? (await pool.query<{ live: string; hits: string; tin: string; tout: string; cost: string }>(
        `select count(*) filter (where not cache_hit) live, count(*) filter (where cache_hit) hits,
                coalesce(sum(tokens_in + coalesce(cache_read_tokens,0) + coalesce(cache_write_tokens,0)) filter (where not cache_hit),0) tin,
                coalesce(sum(tokens_out) filter (where not cache_hit),0) tout, coalesce(sum(est_cost_inr) filter (where not cache_hit),0) cost
         from usage_log where run_id = $1`, [runId])).rows[0]
    : null;

  const m = lineMetrics;
  const metrics = {
    line_recall: m.recalled / m.truth_quoted,
    price_exact: m.exact / m.truth_quoted,
    price_within_1pct: m.within1 / m.truth_quoted,
    unit_pack_correct: m.conv_lines ? m.conv_exact / m.conv_lines : null,
    questionnaire_accuracy: qRight / qTotal,
    status_agreement: m.status_agree / m.truth_quoted,
    confirmed_cells: m.confirmed,
    confident_wrong: m.confident_wrong,
    confident_wrong_rate: m.confirmed ? m.confident_wrong / m.confirmed : 0,
    assumed_but_wrong: m.assumed_wrong,
    false_alarm_rate: m.correct_value ? m.false_alarm / m.correct_value : 0,
    phantom_lines: m.phantom,
    edges_detected: Object.values(e).filter((x) => x.detected).length,
    live_calls: Number(usage?.live ?? 0),
    cache_hits: Number(usage?.hits ?? 0),
    tokens_in: Number(usage?.tin ?? 0),
    tokens_out: Number(usage?.tout ?? 0),
    cost_inr: Number(usage?.cost ?? 0),
  };
  const docFailures = docs.filter((d) => d.status === 'failed').map((d) => `${d.filename}: ${d.error}`);
  return { metrics, counts: m, perVendor, edges: e, confidentWrong, failures, qMismatch, qTotal, qRight, docFailures };
}

function valueMatches(truthV: unknown, ours: unknown): boolean {
  if (truthV === null || truthV === undefined) return true;
  if (typeof truthV === 'boolean') return ours === truthV || (typeof ours === 'object' && ours !== null && (ours as { has?: unknown }).has === truthV);
  if (typeof truthV === 'number') {
    const n = typeof ours === 'number' ? ours : typeof ours === 'string' ? Number(ours.replace(/[^0-9.]/g, '')) : NaN;
    return Number.isFinite(n) && Math.abs(n - truthV) <= Math.max(0.01, Math.abs(truthV) * 0.01);
  }
  if (typeof truthV === 'object') {
    const t = truthV as { has?: boolean; expiry?: string; number?: string };
    const o = (ours && typeof ours === 'object' ? ours : {}) as { has?: boolean; expiry?: string };
    if (t.has !== undefined && o.has !== undefined && o.has !== t.has) return false;
    return o.has === t.has || ours === t.has;
  }
  return true; // free text: status agreement is enough
}

export function report(r: Awaited<ReturnType<typeof score>>, meta: { run_id: string | null; fresh: boolean; mode: string }): string {
  const m = r.metrics;
  const f = (x: number | null) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const label = meta.mode === 'score-only'
    ? 'SCORE ONLY: no extraction ran; this scores what is currently stored.'
    : m.cache_hits > 0 && m.live_calls === 0
      ? 'ALL RESULTS FROM THE DEV CACHE (stored real responses from earlier runs). Not a fresh run.'
      : m.cache_hits > 0
        ? `MIXED: ${m.live_calls} live calls and ${m.cache_hits} cache hits (stored real responses).`
        : 'FRESH: every model call in this run was a live API call.';
  const lines: string[] = [];
  lines.push('# Evaluation report', '');
  lines.push(`Run: ${meta.run_id ?? 'n/a'}  |  ${new Date().toISOString()}  |  mode: ${meta.mode}`, '');
  lines.push(`**${label}**`, '');
  lines.push('Scored against `seed/out/truth.json`, which only this harness reads. "Exact" means within half a paisa of the true INR price per base unit after normalization.', '');
  lines.push('## Metrics', '', '| Metric | Value |', '|---|---|');
  lines.push(`| Line recall (quoted lines found) | ${f(m.line_recall)} (${r.counts.recalled} of ${r.counts.truth_quoted}) |`);
  lines.push(`| Price exact after normalization | ${f(m.price_exact)} (${r.counts.exact} of ${r.counts.truth_quoted}) |`);
  lines.push(`| Price within 1 percent | ${f(m.price_within_1pct)} |`);
  lines.push(`| Unit and pack size correctness (lines needing a conversion) | ${f(m.unit_pack_correct)} (${r.counts.conv_exact} of ${r.counts.conv_lines}) |`);
  lines.push(`| Questionnaire accuracy | ${f(m.questionnaire_accuracy)} (${r.qRight} of ${r.qTotal}) |`);
  lines.push(`| Status agrees with expected | ${f(m.status_agreement)} |`);
  lines.push(`| Edges detected (E1 to E13) | ${m.edges_detected} of 13 |`);
  lines.push(`| **Confident wrong (Confirmed but wrong)** | **${m.confident_wrong} of ${m.confirmed_cells} Confirmed cells (${f(m.confident_wrong_rate)})** |`);
  lines.push(`| Assumed but wrong | ${m.assumed_but_wrong} |`);
  lines.push(`| False alarm rate (right value sent to review) | ${f(m.false_alarm_rate)} |`);
  lines.push(`| Lines invented for unquoted items | ${m.phantom_lines} |`);
  lines.push(`| Model calls | ${m.live_calls} live, ${m.cache_hits} cache hits |`);
  lines.push(`| Tokens (live calls) | ${m.tokens_in} in, ${m.tokens_out} out |`);
  lines.push(`| Cost (live calls) | Rs ${m.cost_inr.toFixed(2)} |`, '');
  lines.push('## Per vendor', '', '| Vendor | Coverage | Exact | Confirmed | Assumed | Needs review | Conflict | Confident wrong | Questionnaire (ours / truth) |', '|---|---|---|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(r.perVendor)) {
    lines.push(`| ${k} | ${v.coverage} | ${v.exact} of ${v.truth_quoted} | ${v.confirmed ?? 0} | ${v.assumed ?? 0} | ${v.needs_review ?? 0} | ${v.conflict ?? 0} | ${v.confident_wrong} | ${v.questionnaire} / ${String(v.questionnaire_truth).toLowerCase()} |`);
  }
  lines.push('', '## Edge cases', '', '| Edge | Result | Detail |', '|---|---|---|');
  for (const [k, v] of Object.entries(r.edges)) lines.push(`| ${k} | ${v.detected ? 'Detected' : '**Missed**'} | ${v.detail.replace(/\|/g, '/')} |`);
  lines.push('', '## Confident wrong cells', '');
  lines.push(r.confidentWrong.length ? r.confidentWrong.map((c) => `- ${c}`).join('\n') : 'None.');
  lines.push('', '## Line failures', '');
  if (r.failures.length) {
    lines.push('| Vendor | Line | Problem | Ours | Truth | Evidence |', '|---|---|---|---|---|---|');
    for (const x of r.failures) lines.push(`| ${x.vendor} | ${x.code} | ${x.problem} | ${x.ours.replace(/\|/g, '/')} | ${x.truth} | ${x.evidence.replace(/\|/g, '/').slice(0, 160)} |`);
  } else lines.push('None.');
  lines.push('', '## Questionnaire mismatches', '');
  lines.push(r.qMismatch.length ? r.qMismatch.map((q) => `- ${q}`).join('\n') : 'None.');
  lines.push('', '## Document failures', '');
  lines.push(r.docFailures.length ? r.docFailures.map((d) => `- ${d}`).join('\n') : 'None.');
  const limits = path.resolve('eval/KNOWN_LIMITATIONS.md');
  if (fs.existsSync(limits)) lines.push('', fs.readFileSync(limits, 'utf8').trim());
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  loadEnvLocal();
  const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 4 }));
  try {
    if (flag('dry-run')) {
      printPlan(await planDocuments(pool));
      return;
    }
    let runId: string | null = null;
    const mode = flag('score-only') ? 'score-only' : flag('fresh') ? 'fresh' : 'cache-allowed';
    if (mode !== 'score-only') {
      runId = randomUUID();
      await runAll({ fresh: mode === 'fresh', concurrency: 4, run_id: runId, route: 'script:eval' });
    }
    const r = await score(pool, runId);
    const md = report(r, { run_id: runId, fresh: mode === 'fresh', mode });
    fs.writeFileSync(path.resolve('eval/EVAL_REPORT.md'), md);
    if (mode !== 'score-only') {
      await pool.query('insert into eval_runs (metrics, details) values ($1, $2)', [JSON.stringify({ ...r.metrics, mode, run_id: runId }), JSON.stringify({ perVendor: r.perVendor, edges: r.edges, confidentWrong: r.confidentWrong, failures: r.failures, qMismatch: r.qMismatch })]);
    }
    console.log(md.split('## Line failures')[0]);
  } finally {
    await pool.end();
  }
}

main().catch((e: Error) => {
  console.error(e.message.split('\n')[0]);
  process.exit(1);
});
