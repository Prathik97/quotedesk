// POST /api/extract { document_id, fresh? }  One document per call, idempotent.
import { z } from 'zod';
import { db } from '../db.js';
import { admitModelCall, CAPPED_LABEL } from '../guard.js';
import { env } from '../env.js';
import { ApiError, route } from '../http.js';
import { BudgetExceededError } from '../llm/call.js';
import { realClient } from '../llm/client.js';
import { budgetSessionId } from '../llm/session.js';
import { pgStore } from '../llm/store.js';
import { processDocument } from '../extract/pipeline.js';

const Body = z.object({ document_id: z.string().uuid(), fresh: z.boolean().optional().default(false) });

export default route(['POST'], async (req) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'bad_request', 'Send { document_id } as JSON.');
  const pool = db();
  // Before any work. When a cap is reached nothing is re-run: the stored extraction stays as it is.
  const gate = await admitModelCall(pool, req, 'extract');
  if (!gate.ok) {
    const d = await pool.query<{ filename: string; status: string; kind: string | null; lines: string }>(
      `select d.filename, d.status, d.kind, (select count(*) from quote_lines q where q.source_document_id = d.id) as lines from documents d where d.id = $1`,
      [parsed.data.document_id],
    );
    const doc = d.rows[0];
    if (!doc) throw new ApiError(404, 'not_found', 'That document does not exist. Reload the page.');
    return { capped: true, reason: gate.reason, message: gate.message, label: CAPPED_LABEL, document_id: parsed.data.document_id, stored: { filename: doc.filename, status: doc.status, kind: doc.kind, lines: Number(doc.lines) } };
  }
  try {
    return await processDocument(parsed.data.document_id, {
      deps: { client: realClient(), store: pgStore(pool), dailyCapInr: env().DAILY_SPEND_CAP_INR },
      pool,
      fresh: parsed.data.fresh,
      run_id: null,
      session_id: budgetSessionId(),
      route: 'api:extract',
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) throw new ApiError(429, 'capped', e.message, { reason: 'daily_cap', label: CAPPED_LABEL, stored: true });
    throw e;
  }
});
