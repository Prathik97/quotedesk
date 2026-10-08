// One-off capture: run a vendor file through the real Try your file code path (runSandbox) and save ONLY the
// raw model replies and the global notes as a regression fixture. No database is read or written: the RFx
// context comes from seed/rfx.json and the store is in memory. The input file is read from the path given and
// is never copied into the repo.
// Usage: tsx scripts/capture-sandbox.ts <file path> <fixture name> [max spend INR]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { realClient, type LlmResponse } from '../api/_lib/llm/client.js';
import { costInr } from '../api/_lib/llm/pricing.js';
import type { LlmStore } from '../api/_lib/llm/store.js';
import { canonicalMime, runSandbox } from '../api/_lib/sandbox/run.js';
import { loadEnvLocal, requireEnv } from './envfile.js';

loadEnvLocal();
const [file, name, cap = '12'] = process.argv.slice(2);
if (!file || !name) throw new Error('Usage: capture-sandbox <file> <fixture name> [max spend INR]');

const seed = JSON.parse(readFileSync(new URL('../seed/rfx.json', import.meta.url), 'utf8')) as {
  lines: { code: string; section: string; description: string; uom: never; annual_qty: number; ly_rate: number | null }[];
  questions: { code: string; text: string; is_knockout: boolean; pass_rule: unknown }[];
};
const lines = seed.lines.map((l, i) => ({ id: `seed-${i}`, code: l.code, section: l.section, description: l.description, uom: l.uom, annual_qty: l.annual_qty, last_year_rate_inr: l.ly_rate }));
const questions = seed.questions.map((q) => ({ id: `q-${q.code}`, code: q.code, text: q.text, is_knockout: q.is_knockout, pass_rule: q.pass_rule }));

const memory: LlmStore = {
  getCache: async () => null,
  putCache: async () => undefined,
  logUsage: async () => undefined,
  sessionSpendInr: async () => 0,
  daySpendInr: async () => 0,
};
let spent = 0;
const replies: { n: number; max_tokens: number; text: string; stop_reason: string | null }[] = [];
const client = realClient();
const bytes = new Uint8Array(readFileSync(file));
const filename = basename(file);
const mime = canonicalMime(filename);
if (!mime) throw new Error('Unsupported file type.');

const result = await runSandbox(
  { filename, mime, bytes },
  { lines, questions, assumptions: { usd_inr: Number(process.env.DEFAULT_USD_INR ?? 96), gst_pct: Number(process.env.DEFAULT_GST_PCT ?? 18) } },
  {
    client: { complete: async (r): Promise<LlmResponse> => {
      if (spent >= Number(cap)) throw new Error(`Actual spend Rs ${spent.toFixed(2)} reached the Rs ${cap} limit. No further call.`);
      const res = await client.complete(r);
      spent += costInr(r.model, res.usage);
      replies.push({ n: replies.length + 1, max_tokens: r.max_tokens, text: res.text, stop_reason: res.stop_reason }); return res; } },
    store: memory,
    // Only the worst case reservation check of the call wrapper. The real limit is the actual spend check above.
    dailyCapInr: 40,
  },
  { route: 'capture', session_id: 'capture-sandbox', models: { fast: requireEnv('MODEL_FAST'), extract: requireEnv('MODEL_EXTRACT') } },
);

const extractReply = replies.find((r) => /"document"\s*:/.test(r.text));
let globalNotes: string[] = [];
try { globalNotes = (JSON.parse(extractReply?.text ?? '{}').document?.global_notes ?? []) as string[]; } catch { /* the notes stay empty when the reply is not plain JSON */ }
writeFileSync(
  new URL(`../eval/fixtures/${name}.raw.json`, import.meta.url),
  JSON.stringify({ file: { filename, size_bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }, captured_with: { prompt: process.env.CAPTURE_PROMPT ?? 'extract.v3', note: 'Raw model replies only. The vendor file itself is not stored.' }, usage: result.usage, global_notes: globalNotes, result_lines: result.lines.map((l) => ({ code: l.code, price: l.price, normalized_inr: l.normalized_inr, status: l.status, flags: l.flags, assumptions: l.assumptions, tax: l.tax ?? null, reason: l.reasons[0] ?? null })), result_review: result.review.filter((r) => r.kind.startsWith('tax')).map((r) => r.message), replies }, null, 1) + '\n',
);
console.log(`${filename}: ok=${result.ok} lines=${result.lines.length} calls=${result.usage.model_calls} cost Rs ${result.usage.cost_inr.toFixed(2)} global_notes=${globalNotes.length}`);
if (process.env.CAPTURE_PRINT === '1') {
  for (const l of result.lines) console.log(`${(l.code ?? '-').padEnd(10)} ${l.status.padEnd(12)} ${String(l.normalized_inr ?? '-').padEnd(8)} flags=[${l.flags.join(',')}] ${l.reasons.join(' ').slice(0, 150)}`);
  console.log(`status counts ${JSON.stringify(result.status_counts)}`);
  for (const r of result.review) console.log(`REVIEW ${r.kind} (${r.message.length} chars): ${r.message.slice(0, 220)}`);
  console.log(`review items ${result.review.length}`);
}
