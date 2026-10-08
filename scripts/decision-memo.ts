// Builds a decision pack straight from the database and writes the files to disk. Template note only:
// this script never calls the model. Use it to look at a memo, or to feed the independent check.
//   npm run decision:memo -- --out .decision-out --strategy cheapest_per_line --pending --discounts
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvLocal } from './envfile.js';
import { flag, option } from './runtime.js';

loadEnvLocal();
const { db } = await import('../api/_lib/db.js');
const { loadAnalystData } = await import('../api/_lib/analyst/data.js');
const { buildPack, requiredMemoStrings } = await import('../api/_lib/decision/pack.js');
const { memoBlocks, missingFromMemo, renderMemo } = await import('../api/_lib/decision/memo.js');
const { buildAppendix } = await import('../api/_lib/decision/appendix.js');
const { templateResult } = await import('../api/_lib/decision/note.js');

const out = path.resolve(option('out') ?? '.decision-out');
fs.mkdirSync(out, { recursive: true });
const pool = db();
const data = await loadAnalystData(pool);
const pack = buildPack(data, {
  strategy: (option('strategy') ?? 'cheapest_per_line') as never,
  include_pending: flag('pending'),
  apply_discounts: flag('discounts'),
  price_basis: flag('confirmed-only') ? 'confirmed' : 'confirmed_assumed',
  vendor: option('vendor') ?? null,
  max_share: option('cap') ? Number(option('cap')) : null,
  buyer_note: option('note'),
});
const note = templateResult(pack);
const blocks = memoBlocks(pack, note);
const missing = missingFromMemo(blocks, requiredMemoStrings(pack));
if (missing.length) {
  console.error(`FAIL memo is missing ${missing.length} required items`);
  process.exit(1);
}
const pdf = await renderMemo(blocks, { title: `Award decision memo, ${pack.rfx.title}`, subject: pack.scenario_text, header: `${pack.rfx.title}. ${pack.generated_on}`, footer: `Draft for approval. INR excluding GST. ${pack.readiness.label}. Scenario: ${pack.slug}.`, now: new Date(pack.generated_at) });
const xlsx = await buildAppendix(pack, note);
const base = `QuoteDesk_Decision_Memo_${pack.slug}`;
fs.writeFileSync(path.join(out, `${base}.pdf`), pdf);
fs.writeFileSync(path.join(out, `QuoteDesk_Decision_Appendix_${pack.slug}.xlsx`), xlsx);
fs.writeFileSync(path.join(out, `${base}.pack.json`), JSON.stringify({ totals: pack.result.totals, by_vendor: pack.result.by_vendor, allocation: pack.result.allocation, sensitivity: pack.sensitivity, readiness: pack.readiness, scenario: pack.scenario }, null, 1));
console.log(`Wrote ${base}.pdf (${pdf.byteLength} bytes), appendix (${xlsx.byteLength} bytes) to ${out}`);
console.log(`Note (${note.source}): ${note.text}`);
await pool.end();
