// Parity of the Try your file sandbox with the stored pipeline, on the real stored data. For every stored
// extraction it re-derives the lines with deriveLines (the function the sandbox uses) from the stored model
// output, and compares code, status, normalized price and flags with the quote_lines rows the comparison shows.
// Read only. No model call. Prints counts and the first few differences by line code, never document text.
//   npm run verify:sandbox
import pg from 'pg';
import { pgConfig } from '../../api/_lib/pgconfig.js';
import { loadAssumptions, loadRfxContext, loadDocument, prepareDocument } from '../../api/_lib/extract/pipeline.js';
import { storedRun } from '../../api/_lib/compare/data.js';
import { STORED_RUN_ROW_SQL } from '../../api/_lib/compare/stored-run.js';
import { deriveLines } from '../../api/_lib/extract/persist.js';
import { ExtractionSchema } from '../../src/lib/schemas/extraction.js';
import { loadEnvLocal, requireEnv } from '../envfile.js';

loadEnvLocal();
const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 2 }));
try {
  const rfx = (await pool.query<{ id: string }>('select id from rfx where is_saved_demo limit 1')).rows[0];
  if (!rfx) throw new Error('No saved RFx.');
  const { lines } = await loadRfxContext(pool, rfx.id);
  const a = await loadAssumptions(pool);
  const docs = (await pool.query<{ document_id: string; raw_json: unknown }>(
    `select distinct on (document_id) document_id, raw_json from extractions where status in ('ok','repaired') and raw_json is not null order by document_id, created_at desc`,
  )).rows;
  let compared = 0;
  let same = 0;
  const diffs: string[] = [];
  for (const d of docs) {
    const parsed = ExtractionSchema.safeParse(d.raw_json);
    if (!parsed.success) continue;
    const doc = await loadDocument(pool, d.document_id);
    const prep = await prepareDocument(doc);
    const derived = deriveLines(prep, parsed.data, lines, a);
    const stored = (await pool.query<{ code: string | null; status: string; n: string | null; flags: string[]; ov: unknown }>(
      `select rl.code, q.status, q.normalized_price_inr as n, q.flags, q.overrides as ov from quote_lines q left join rfx_lines rl on rl.id = q.rfx_line_id where q.source_document_id = $1`, [d.document_id],
    )).rows;
    const key = (code: string | null, desc: string) => code ?? `unmatched:${desc.slice(0, 20)}`;
    const byKey = new Map(stored.map((s) => [s.code ?? 'unmatched', s]));
    for (const x of derived) {
      compared++;
      const s = x.rfx ? byKey.get(x.rfx.code) : stored.find((y) => !y.code);
      const sameNum = s && (s.n == null ? x.normalized == null : x.normalized != null && Math.abs(Number(s.n) - x.normalized) < 1e-9);
      const sameFlags = s && JSON.stringify([...s.flags].sort()) === JSON.stringify([...x.flags].sort());
      if (s && s.status === x.status && sameNum && sameFlags) same++;
      else if (diffs.length < 8) diffs.push(`${doc.filename} ${key(x.rfx?.code ?? null, x.line.vendor_description)}: stored ${s ? `${s.status} ${s.n}` : 'missing'} vs derived ${x.status} ${x.normalized}`);
    }
  }
  // The stored comparison label counts only extractions of the five vendors' documents, never sandbox or script runs.
  const label = storedRun((await pool.query(STORED_RUN_ROW_SQL)).rows[0]);
  const allExtract = Number((await pool.query<{ n: string }>(`select count(*) n from usage_log where not cache_hit and stage = 'extract'`)).rows[0]?.n ?? 0);
  const sandboxRows = Number((await pool.query<{ n: string }>(`select count(*) n from usage_log where not cache_hit and stage = 'extract' and route like '%sandbox%'`)).rows[0]?.n ?? 0);
  console.log(`stored run label: "${label.label}", ${label.live_calls} live calls (usage_log holds ${allExtract} extract rows, ${sandboxRows} from Try your file, none counted)`);
  const labelOk = label.live_calls <= allExtract - sandboxRows;
  console.log(`documents ${docs.length}, lines compared ${compared}, identical ${same}`);
  if (diffs.length) console.log(diffs.join('\n'));
  console.log(same === compared && compared > 0 && labelOk ? `PASS the sandbox derivation reproduces all ${compared} stored comparison cells` : 'FAIL the derivation differs from the stored cells');
  if (same !== compared || !labelOk) process.exitCode = 1;
} finally {
  await pool.end();
}
