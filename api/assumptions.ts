// GET /api/assumptions lists them. POST /api/assumptions { key, value } (or value null to reset)
// edits a global one as the buyer and recomputes every stored line at once. No model call.
import { z } from 'zod';
import type { AssumptionUpdateResponse } from '../src/lib/api-types.js';
import { GLOBAL_KEYS, setGlobal } from './_lib/compare/assumptions.js';
import { loadCompare } from './_lib/compare/data.js';
import { recompute } from './_lib/compare/recompute.js';
import { db } from './_lib/db.js';
import { ApiError, route } from './_lib/http.js';

const Body = z.discriminatedUnion('key', [
  z.object({ key: z.literal('usd_inr'), value: z.number().positive().max(10000).nullable() }),
  z.object({ key: z.literal('gst_pct'), value: z.number().min(0).max(100).nullable() }),
]);

export default route(['GET', 'POST', 'PUT'], async (req): Promise<unknown> => {
  const pool = db();
  if (req.method === 'GET') {
    const c = await loadCompare(pool);
    return { stored: c.stored, assumptions: c.assumptions, derived: c.derived_assumptions };
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'bad_request', `Send { key, value } where key is one of ${GLOBAL_KEYS.join(', ')} and value is a sensible number, or null to reset.`);
  const set = await setGlobal(pool, parsed.data.key, parsed.data.value);
  const out: AssumptionUpdateResponse = { ok: true, key: parsed.data.key, old: set.old, value: set.value, set_by: set.set_by, recompute: await recompute(pool) };
  return out;
});
