// Try your file: read ONE vendor reply file live, against the saved FY27 RFx lines, in an isolated sandbox.
//   POST /api/sandbox   body: the raw file bytes (content-type application/octet-stream, at most 4 MB)
//                       headers: x-filename (URL encoded), x-browser-id
//   GET  /api/sandbox?browser_id=X   this visitor's latest unexpired result, and the uploads left this hour
// The result is shown on that page only and stored in sandbox_results (two hour expiry). It is never merged into
// quote_lines, vendor_terms, review_items or anything the comparison reads. Limits: 3 uploads per address per
// hour (request_log), the daily spend cap, the session budget. The file itself is never stored.
import type { VercelRequest } from '@vercel/node';
import { BrowserId } from '../copilot/drafts.js';
import { db } from '../db.js';
import { env } from '../env.js';
import { loadAssumptions, loadRfxContext } from '../extract/pipeline.js';
import { admitSandbox, CAPPED_LABEL, sandboxUploadsLeft, SANDBOX_PER_IP_HOURLY } from '../guard.js';
import { ApiError, log, route } from '../http.js';
import { BudgetExceededError } from '../llm/call.js';
import { realClient } from '../llm/client.js';
import { budgetSessionId } from '../llm/session.js';
import { pgStore } from '../llm/store.js';
import { noCache, runSandbox, SANDBOX_LABEL, type SandboxResult } from '../sandbox/run.js';
import { validateUpload } from '../uploads.js';

export const MAX_SANDBOX_BYTES = 4 * 1024 * 1024;
const KEEP_PER_BROWSER = 3;

const header = (req: VercelRequest, name: string): string => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

export default route(['GET', 'POST'], async (req) => {
  const pool = db();
  if (req.method === 'GET') {
    const bid = BrowserId.safeParse(req.query.browser_id);
    if (!bid.success) throw new ApiError(400, 'bad_request', bid.error.issues[0]?.message ?? 'Missing browser id.');
    await pool.query('delete from sandbox_results where expires_at < now()');
    const r = await pool.query<{ result: SandboxResult; expires_at: Date }>('select result, expires_at from sandbox_results where browser_id = $1 order by created_at desc limit 1', [bid.data]);
    return {
      label: SANDBOX_LABEL, result: r.rows[0]?.result ?? null, expires_at: r.rows[0]?.expires_at.toISOString() ?? null,
      uploads_left: await sandboxUploadsLeft(pool, req), uploads_per_hour: SANDBOX_PER_IP_HOURLY, max_mb: MAX_SANDBOX_BYTES / 1048576,
    };
  }

  // Validate before the gate, so a wrong file type never uses up one of the 3 uploads.
  const bid = BrowserId.safeParse(header(req, 'x-browser-id'));
  if (!bid.success) throw new ApiError(400, 'bad_request', bid.error.issues[0]?.message ?? 'Missing browser id.');
  let filename = '';
  try {
    filename = decodeURIComponent(header(req, 'x-filename')).slice(0, 200);
  } catch {
    filename = '';
  }
  const body = req.body;
  const bytes = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'utf8') : null;
  if (!bytes) throw new ApiError(400, 'bad_request', 'Send the file as the raw request body.');
  const mime = header(req, 'x-file-mime');
  const check = validateUpload({ filename, mime, size: bytes.byteLength }, MAX_SANDBOX_BYTES);
  if (!check.ok) throw new ApiError(400, 'bad_file', check.message);

  const gate = await admitSandbox(pool, req);
  if (!gate.ok) throw new ApiError(429, 'capped', gate.message, { reason: gate.reason, label: CAPPED_LABEL, uploads_left: await sandboxUploadsLeft(pool, req) });

  await pool.query('delete from sandbox_results where expires_at < now()');
  const saved = (await pool.query<{ id: string }>('select id from rfx where is_saved_demo order by created_at limit 1')).rows[0];
  if (!saved) throw new ApiError(404, 'not_found', 'No saved RFx is loaded.');
  const [{ lines, questions }, assumptions] = await Promise.all([loadRfxContext(pool, saved.id), loadAssumptions(pool)]);
  const e = env();
  let result: SandboxResult;
  try {
    result = await runSandbox(
      { filename: check.storage_name, mime: check.mime, bytes },
      { lines, questions, assumptions },
      { client: { complete: (r) => realClient().complete(r) }, store: noCache(pgStore(pool)), dailyCapInr: e.DAILY_SPEND_CAP_INR, log: (l) => console.log(l) },
      { route: 'api:sandbox', session_id: budgetSessionId(), models: { fast: e.MODEL_FAST, extract: e.MODEL_EXTRACT } },
    );
  } catch (err) {
    if (err instanceof BudgetExceededError) throw new ApiError(429, 'capped', err.message, { reason: 'daily_cap', label: CAPPED_LABEL, uploads_left: await sandboxUploadsLeft(pool, req) });
    log('error', 'sandbox_failed', { message: (err as Error).message.slice(0, 200) });
    throw new ApiError(500, 'sandbox_failed', 'The file could not be read. Nothing was added to the comparison. Try again, or try a different file.');
  }

  await pool.query('insert into sandbox_results (id, browser_id, filename, size_bytes, result, cost_inr) values ($1,$2,$3,$4,$5::jsonb,$6)', [result.id, bid.data, result.filename, result.size_bytes, JSON.stringify(result), result.usage.cost_inr]);
  await pool.query(`delete from sandbox_results where id in (select id from sandbox_results where browser_id = $1 order by created_at desc offset $2)`, [bid.data, KEEP_PER_BROWSER]);
  log('info', 'sandbox_run', { id: result.id, kind: result.kind, lines: result.lines.length, cost_inr: Number(result.usage.cost_inr.toFixed(3)), calls: result.usage.model_calls });
  return { label: SANDBOX_LABEL, result, uploads_left: await sandboxUploadsLeft(pool, req), uploads_per_hour: SANDBOX_PER_IP_HOURLY, max_mb: MAX_SANDBOX_BYTES / 1048576 };
});
