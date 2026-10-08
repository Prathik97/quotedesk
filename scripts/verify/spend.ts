// Phase 6 spend meter: what one budget session has spent, by stage. Prints money and counts only.
//   npm run verify:spend -- <budget session id>
import pg from 'pg';
import { pgConfig } from '../../api/_lib/pgconfig.js';
import { loadEnvLocal, requireEnv } from '../envfile.js';

loadEnvLocal();
const id = process.argv[2];
if (!id) throw new Error('Pass the budget session id.');
const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 1 }));
try {
  const r = await pool.query<{ stage: string; n: string; s: string; tin: string; tout: string }>(
    `select stage, count(*) as n, sum(est_cost_inr) as s, sum(tokens_in) as tin, sum(tokens_out) as tout from usage_log where session_id = $1 and not cache_hit group by stage order by stage`,
    [id],
  );
  let total = 0;
  for (const x of r.rows) {
    total += Number(x.s);
    console.log(`${x.stage.padEnd(10)} ${String(x.n).padStart(3)} calls  in ${x.tin}  out ${x.tout}  Rs ${Number(x.s).toFixed(2)}`);
  }
  console.log(`TOTAL Rs ${total.toFixed(2)} of the Rs 40 Phase 6 budget`);
} finally {
  await pool.end();
}
