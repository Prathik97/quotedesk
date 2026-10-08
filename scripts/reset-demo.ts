// Restores the seeded demo state from a script. No model call, no HTTP, no rate limit.
//   npm run demo:reset
// Against the deployed app instead (needs DEMO_ADMIN_TOKEN set on Vercel):
//   curl -X POST https://<your-app>.vercel.app/api/reset-demo -H "x-admin-token: $DEMO_ADMIN_TOKEN"
import pg from 'pg';
import { pgConfig } from '../api/_lib/pgconfig.js';
import { resetDemo } from '../api/_lib/demo/reset.js';
import { loadEnvLocal, requireEnv } from './envfile.js';

loadEnvLocal();
const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 3 }));
try {
  console.log(JSON.stringify(await resetDemo(pool), null, 2));
} finally {
  await pool.end();
}
