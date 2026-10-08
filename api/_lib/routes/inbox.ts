// GET /api/inbox: vendor replies with attachments and extraction status, read only.
import type { InboxResponse } from '../../../src/lib/api-types.js';
import { pipelineOf, storedRun } from '../compare/data.js';
import { loadDocuments } from '../compare/docs.js';
import { db } from '../db.js';
import { z } from 'zod';
import { BrowserId } from '../copilot/drafts.js';
import { ApiError, route } from '../http.js';
import { STORED_RUN_USAGE_SQL } from '../compare/stored-run.js';

// GET  /api/inbox?browser_id=X        the vendor replies, once this browser has pressed "Simulate vendor replies"
// POST /api/inbox {action:'simulate'}  reveals the stored replies for this browser (no model call)
// POST /api/inbox {action:'hide'}      puts this browser back to the unrevealed state
// The replies are the stored real extraction results. Revealing them only records that fact.
const Post = z.object({ browser_id: BrowserId, action: z.enum(['simulate', 'hide']) });

export default route(['GET', 'POST'], async (req): Promise<InboxResponse | { ok: true }> => {
  const pool = db();
  if (req.method === 'POST') {
    const p = Post.safeParse(req.body);
    if (!p.success) throw new ApiError(400, 'bad_request', p.error.issues[0]?.message ?? 'Send { browser_id, action } as JSON.');
    if (p.data.action === 'simulate') await pool.query('insert into inbox_reveals (browser_id) values ($1) on conflict (browser_id) do nothing', [p.data.browser_id]);
    else await pool.query('delete from inbox_reveals where browser_id = $1', [p.data.browser_id]);
    return { ok: true };
  }
  const bid = BrowserId.safeParse(req.query.browser_id);
  const revealed = bid.success ? ((await pool.query('select 1 from inbox_reveals where browser_id = $1', [bid.data])).rowCount ?? 0) > 0 : false;
  const [meta, docs] = await Promise.all([
    pool.query<{ d: Record<string, any> }>(`select jsonb_build_object(
      'vendors', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'key', v.vendor_key, 'name', v.name, 'from', v.contact_email,
          'msg', (select to_jsonb(m) from (select subject, body_text, arrival_day, received_at from vendor_messages m where m.vendor_id = v.id order by arrival_day limit 1) m)) order by v.vendor_key), '[]'::jsonb) from vendors v),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('vendor_id', i.vendor_id, 'kind', i.kind, 'severity', i.severity)), '[]'::jsonb) from review_items i where i.state = 'open'),
      'usage', ${STORED_RUN_USAGE_SQL}) as d`),
    loadDocuments(pool),
  ]);
  const d = meta.rows[0]?.d ?? {};
  const waiting = (d.vendors as unknown[]).length;
  const messages = (d.vendors as Record<string, any>[]).map((v) => {
    const mine = docs.filter((x) => x.vendor_id === v.id);
    return {
      vendor_id: v.id as string,
      vendor_key: v.key as string,
      vendor_name: v.name as string,
      from: (v.from ?? null) as string | null,
      subject: (v.msg?.subject ?? null) as string | null,
      arrival_day: (v.msg?.arrival_day ?? null) as number | null,
      received_at: (v.msg?.received_at ?? null) as string | null,
      body_text: (v.msg?.body_text ?? null) as string | null,
      pipeline: pipelineOf(mine, (d.items as { vendor_id: string; kind: string; severity: string }[]).filter((i) => i.vendor_id === v.id)),
      documents: mine.map(({ storage_path: _p, message: _m, ...doc }) => doc),
    };
  });
  // Until the buyer presses Simulate, no reply has "arrived": the stored data is held back, not deleted.
  return { stored: storedRun(d.usage), revealed, waiting, messages: revealed ? messages : [] };
});
