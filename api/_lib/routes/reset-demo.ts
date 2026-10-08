// POST /api/reset-demo: restore the seeded demo state (FR-12.3). Rate limited per IP and overall.
// A script can pass the header x-admin-token (DEMO_ADMIN_TOKEN) to skip the limits. No model call.
import { resetDemo } from '../demo/reset.js';
import { db } from '../db.js';
import { admitReset } from '../guard.js';
import { ApiError, log, route } from '../http.js';

export default route(['POST'], async (req) => {
  const pool = db();
  const gate = await admitReset(pool, req);
  if (!gate.ok) throw new ApiError(429, 'rate_limited', gate.message);
  const summary = await resetDemo(pool);
  log('info', 'demo_reset', { admin: gate.admin, ...summary });
  return { ok: true, message: 'The demo is back to its seeded state.', ...summary };
});
