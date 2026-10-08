// Deterministic recompute of every stored quote line. No model calls.
// Usage: npm run recompute   (prints how many lines moved; 0 means stored results already match the engine)
import pg from 'pg';
import { recompute } from '../api/_lib/compare/recompute.js';
import { pgConfig } from '../api/_lib/pgconfig.js';
import { loadEnvLocal, requireEnv } from './envfile.js';

loadEnvLocal();
const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 3 }));
const dryRun = process.argv.includes('--dry-run');
const s = await recompute(pool, { dryRun });
console.log(`${dryRun ? 'dry run (nothing written), derived' : 'recomputed'} ${s.lines} lines in ${s.ms} ms at USD/INR ${s.assumptions.usd_inr}, GST ${s.assumptions.gst_pct}; ${s.changed.length} changed`);
for (const c of s.changed.slice(0, 20)) console.log(` ${c.vendor_key} ${c.code}: ${c.price_before} -> ${c.price_after}, ${c.status_before} -> ${c.status_after}`);
await pool.end();
