// POST /api/normalize { vendor_id? }: deterministic recompute of stored lines. No model call.
import { z } from 'zod';
import { recompute } from './_lib/compare/recompute.js';
import { db } from './_lib/db.js';
import { ApiError, route } from './_lib/http.js';

const Body = z.object({ vendor_id: z.string().uuid().optional() }).optional();

export default route(['POST'], async (req) => {
  const parsed = Body.safeParse(req.body && typeof req.body === 'object' ? req.body : undefined);
  if (!parsed.success) throw new ApiError(400, 'bad_request', 'Send { vendor_id } as JSON, or nothing to recompute every vendor.');
  const id = parsed.data?.vendor_id;
  return { ok: true, recompute: await recompute(db(), id ? { vendorIds: [id] } : {}) };
});
