// POST /api/extract { document_id, fresh? }  One document per call, idempotent.
import { z } from 'zod';
import { db } from './_lib/db.js';
import { ApiError, route } from './_lib/http.js';
import { BudgetExceededError } from './_lib/llm/call.js';
import { realClient } from './_lib/llm/client.js';
import { budgetSessionId } from './_lib/llm/session.js';
import { pgStore } from './_lib/llm/store.js';
import { processDocument } from './_lib/extract/pipeline.js';

const Body = z.object({ document_id: z.string().uuid(), fresh: z.boolean().optional().default(false) });

export default route(['POST'], async (req) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'bad_request', 'Send { document_id } as JSON.');
  const pool = db();
  try {
    return await processDocument(parsed.data.document_id, {
      deps: { client: realClient(), store: pgStore(pool) },
      pool,
      fresh: parsed.data.fresh,
      run_id: null,
      session_id: budgetSessionId(),
      route: 'api:extract',
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) throw new ApiError(429, 'budget_exceeded', e.message);
    throw e;
  }
});
