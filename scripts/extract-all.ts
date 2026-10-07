// npm run extract:all [-- --dry-run] [-- --fresh] [-- --only <text>] [-- --concurrency 4]
// Runs every seeded document through the real pipeline, 4 at a time.
// --dry-run prints each document, the model(s) it would use, estimated tokens and cost, and calls nothing.
// --only filters by vendor key (V1..V5) or a file name fragment.
import { randomUUID } from 'node:crypto';
import { BudgetExceededError, sessionCapInr } from '../api/_lib/llm/call.js';
import { expectedInr } from '../api/_lib/llm/pricing.js';
import { MAX_TOKENS } from '../api/_lib/extract/model.js';
import { ingestSeed } from '../api/_lib/extract/ingest.js';
import { loadDocument, prepareDocument, processDocument, type ProcessResult } from '../api/_lib/extract/pipeline.js';
import { reconcileVendor } from '../api/_lib/extract/reconcile.js';
import { flag, mapLimit, option, runtime, sessionSpend } from './runtime.js';

const ORDER = ['V5', 'V1', 'V3', 'V2', 'V4'];
const SYSTEM_TOKENS = 3200; // extraction instructions plus RFx line list

export type DocPlan = { id: string; vendor_key: string; filename: string; kind_guess: 'quote' | 'certificate' | 'body'; est_in: number; est_out: number; est_inr: number; models: string };

export async function planDocuments(pool: import('pg').Pool, only?: string): Promise<DocPlan[]> {
  const { documents } = await ingestSeed(pool);
  const keys = new Map((await pool.query<{ id: string; vendor_key: string }>(
    'select d.id, v.vendor_key from documents d join vendors v on v.id = d.vendor_id where d.id = any($1)', [documents])).rows.map((r) => [r.id, r.vendor_key]));
  const fast = process.env.MODEL_FAST ?? 'claude-haiku-4-5-20251001';
  const ext = process.env.MODEL_EXTRACT ?? 'claude-sonnet-5-5';
  const plans: DocPlan[] = [];
  for (const id of documents) {
    const doc = await loadDocument(pool, id);
    const vendor_key = keys.get(id) ?? '?';
    if (only && !(vendor_key === only || doc.filename.toLowerCase().includes(only.toLowerCase()))) continue;
    const prep = await prepareDocument(doc);
    const kind_guess = doc.storage_path.startsWith('message:') ? 'body' : /cert|iso|gst|reg/i.test(doc.filename) ? 'certificate' : 'quote';
    const clsIn = Math.min(prep.estimated_tokens, prep.native ? prep.estimated_tokens : 2600) + 300;
    let est_in = clsIn;
    let est_out = 60;
    let inr = expectedInr(fast, clsIn, 60);
    if (kind_guess === 'certificate') {
      est_in += prep.estimated_tokens + 400;
      est_out += 500;
      inr += expectedInr(ext, prep.estimated_tokens + 400, 500);
    } else {
      // Bodies are assumed to need extraction too (conservative: cover notes will be classified "other" and skipped).
      const out = prep.source_type === 'email' ? 3000 : 7000;
      const cap = MAX_TOKENS.extract[prep.source_type];
      est_in += prep.estimated_tokens + SYSTEM_TOKENS;
      est_out += Math.min(out, cap);
      // First call writes the system cache (1.25x on those tokens); later calls read it. Price as all writes to stay safe.
      inr += expectedInr(ext, prep.estimated_tokens, Math.min(out, cap)) + expectedInr(ext, SYSTEM_TOKENS * 1.25, 0);
    }
    plans.push({ id, vendor_key, filename: doc.filename, kind_guess, est_in, est_out, est_inr: inr, models: kind_guess === 'quote' || kind_guess === 'body' ? `${fast} + ${ext}` : `${fast} + ${ext}` });
  }
  const rank = (p: DocPlan) => ORDER.indexOf(p.vendor_key) * 10 + (p.kind_guess === 'certificate' ? 5 : 0);
  return plans.sort((a, b) => rank(a) - rank(b));
}

export function printPlan(plans: DocPlan[]): number {
  const total = plans.reduce((s, p) => s + p.est_inr, 0);
  console.log('DRY RUN: no API calls made.\n');
  console.log('vendor | document | path | models | est tokens in | est tokens out | est Rs');
  for (const p of plans) {
    console.log(`${p.vendor_key} | ${p.filename} | ${p.kind_guess} | ${p.models} | ${p.est_in} | ${p.est_out} | ${p.est_inr.toFixed(2)}`);
  }
  const tin = plans.reduce((s, p) => s + p.est_in, 0);
  const tout = plans.reduce((s, p) => s + p.est_out, 0);
  console.log(`\n${plans.length} documents, about ${tin} tokens in and ${tout} out. Estimated cost Rs ${total.toFixed(2)}.`);
  console.log('Worst case if every extraction ran to its max_tokens limit is higher; the budget guard reserves for that per call.');
  return total;
}

export function printResult(r: ProcessResult): void {
  const status = r.ok ? 'ok' : `FAILED: ${r.error}`;
  const src = r.live_calls === 0 && r.cache_hits > 0 ? 'CACHED (stored real responses, no API call)' : r.cache_hits > 0 ? `LIVE ${r.live_calls} call(s), CACHED ${r.cache_hits}` : `LIVE ${r.live_calls} call(s)`;
  console.log(`-> ${r.vendor} | ${r.filename} | ${r.kind ?? '?'} | ${status} | ${src} | in ${r.tokens_in} out ${r.tokens_out} | Rs ${r.cost_inr.toFixed(2)}${r.lines != null ? ` | ${r.lines} lines ${JSON.stringify(r.statuses)}` : ''}${r.repaired ? ' | repaired once' : ''}`);
}

export async function runAll(opts: { fresh: boolean; only?: string; concurrency: number; run_id: string; route: string }): Promise<ProcessResult[]> {
  const { pool, deps, session_id } = runtime();
  const plans = await planDocuments(pool, opts.only);
  const before = await sessionSpend(pool, session_id);
  console.log(`Run ${opts.run_id}: ${plans.length} documents, ${opts.fresh ? 'FRESH (cache bypassed, real calls)' : 'cache allowed (hits are labelled)'}, concurrency ${opts.concurrency}. Session spend so far Rs ${before.toFixed(2)} of ${sessionCapInr()}.`);
  try {
    const results = await mapLimit(plans, opts.concurrency, async (p) => {
      const r = await processDocument(p.id, { deps, pool, fresh: opts.fresh, run_id: opts.run_id, session_id, route: opts.route, reconcile: false });
      printResult(r);
      return r;
    });
    const vendors = (await pool.query<{ vendor_id: string }>('select distinct vendor_id from documents where id = any($1)', [plans.map((p) => p.id)])).rows;
    for (const v of vendors) await reconcileVendor(pool, v.vendor_id);
    const after = await sessionSpend(pool, session_id);
    const sum = (k: 'tokens_in' | 'tokens_out' | 'cost_inr') => results.reduce((s, r) => s + r[k], 0);
    console.log(`\nBatch: ${results.length} documents (${results.filter((r) => r.ok).length} ok), live calls ${results.reduce((s, r) => s + r.live_calls, 0)}, cache hits ${results.reduce((s, r) => s + r.cache_hits, 0)}, tokens in ${sum('tokens_in')} out ${sum('tokens_out')}, cost Rs ${sum('cost_inr').toFixed(2)}. Session total Rs ${after.toFixed(2)} of ${sessionCapInr()}.`);
    return results;
  } catch (e) {
    if (e instanceof BudgetExceededError) console.error(`\nSTOPPED. ${e.message}`);
    throw e;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (flag('dry-run')) {
    const { pool } = runtime();
    try {
      printPlan(await planDocuments(pool, option('only')));
    } finally {
      await pool.end();
    }
    return;
  }
  await runAll({ fresh: flag('fresh'), only: option('only'), concurrency: Number(option('concurrency') ?? 4), run_id: randomUUID(), route: 'script:extract-all' });
}

if (process.argv[1]?.endsWith('extract-all.ts')) {
  main().catch((e: Error) => {
    console.error(e.message.split('\n')[0]);
    process.exit(1);
  });
}
