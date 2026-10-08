// Counts and a content hash of the SEEDED rows the co-pilot must never change: the FY27 RFx, its lines and
// questions, the vendors, the documents, the stored extractions and the lines read from them.
//   npm run verify:seeded -- --save <file>      write the baseline
//   npm run verify:seeded -- --compare <file>   compare with a baseline, exit 1 on any difference
// Only fields that extraction wrote are hashed (not derived fields a recompute may rewrite with the same value).
// Prints counts and hashes only, never row contents.
import fs from 'node:fs';
import pg from 'pg';
import { pgConfig } from '../../api/_lib/pgconfig.js';
import { loadEnvLocal, requireEnv } from '../envfile.js';

loadEnvLocal();

// table, columns hashed (the source of truth for each table, in a fixed order)
const TABLES: [string, string][] = [
  ['rfx', `id, ref, title, category, buyer_org, status, is_saved_demo, delivery_location, payment_terms_requested_days, validity_days, gst_basis_requested, currency`],
  ['rfx_lines', `id, rfx_id, code, section, description, spec, uom, annual_qty, last_year_rate_inr, is_one_time, sort`],
  ['questionnaire_questions', `id, rfx_id, code, text, answer_type, is_knockout, pass_rule, sort`],
  ['vendors', `id, rfx_id, vendor_key, name, legal_name, contact_email, location`],
  ['vendor_messages', `id, vendor_id, subject, body_text, arrival_day`],
  ['documents', `id, vendor_id, filename, mime, sha256, kind, status`],
  ['extractions', `id, document_id, model, prompt_version, raw_json, status`],
  ['quote_lines', `id, vendor_id, rfx_line_id, source_document_id, vendor_description, quoted_price, quoted_uom_text, quoted_currency, evidence`],
  ['vendor_terms', `id, vendor_id, freight_terms, freight_amount_inr, payment_terms_days, stated_total_inr, conditional_discounts, unit_definitions`],
  ['questionnaire_answers', `id, vendor_id, question_id, answer_raw, answer_value, evidence`],
];

const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 2 }));
const out: Record<string, { rows: number; hash: string }> = {};
try {
  for (const [t, cols] of TABLES) {
    const r = await pool.query<{ n: string; h: string }>(
      `select count(*) as n, coalesce(md5(string_agg(md5(row(${cols})::text), '' order by id)), 'empty') as h from ${t}`,
    );
    out[t] = { rows: Number(r.rows[0]?.n ?? 0), hash: r.rows[0]?.h ?? '' };
  }
  const total = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 16);
  const extra = (await pool.query<{ d: string; o: string; i: string; s: string }>(
    `select (select count(*) from rfx_drafts) as d, (select count(*) from outbox_emails where not is_saved) as o, (select count(*) from inbox_reveals) as i, (select count(*) from outbox_emails where is_saved) as s`,
  )).rows[0];
  const args = process.argv.slice(2);
  const save = args.indexOf('--save');
  const compare = args.indexOf('--compare');
  for (const [t, v] of Object.entries(out)) console.log(`${t.padEnd(24)} ${String(v.rows).padStart(5)} rows  ${v.hash.slice(0, 12)}`);
  console.log(`combined hash ${total}`);
  console.log(`phase 6 tables: drafts ${extra?.d}, non-saved emails ${extra?.o}, inbox reveals ${extra?.i}, saved emails ${extra?.s}`);
  if (save >= 0 && args[save + 1]) fs.writeFileSync(args[save + 1] as string, JSON.stringify({ out, total }));
  if (compare >= 0 && args[compare + 1]) {
    const base = JSON.parse(fs.readFileSync(args[compare + 1] as string, 'utf8')) as { out: typeof out; total: string };
    const diffs = Object.keys(out).filter((t) => base.out[t]?.rows !== out[t]?.rows || base.out[t]?.hash !== out[t]?.hash);
    console.log(diffs.length ? `FAIL differs from baseline: ${diffs.join(', ')}` : `PASS identical to baseline (${Object.keys(out).length} tables, combined hash ${total})`);
    if (diffs.length) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
