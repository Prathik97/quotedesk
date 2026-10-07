// GET /api/inbox: vendor replies with attachments and extraction status, read only.
import type { InboxResponse } from '../../../src/lib/api-types.js';
import { pipelineOf, storedRun } from '../compare/data.js';
import { loadDocuments } from '../compare/docs.js';
import { db } from '../db.js';
import { route } from '../http.js';

export default route(['GET'], async (): Promise<InboxResponse> => {
  const pool = db();
  const [meta, docs] = await Promise.all([
    pool.query<{ d: Record<string, any> }>(`select jsonb_build_object(
      'vendors', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'key', v.vendor_key, 'name', v.name, 'from', v.contact_email,
          'msg', (select to_jsonb(m) from (select subject, body_text, arrival_day, received_at from vendor_messages m where m.vendor_id = v.id order by arrival_day limit 1) m)) order by v.vendor_key), '[]'::jsonb) from vendors v),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('vendor_id', i.vendor_id, 'kind', i.kind, 'severity', i.severity)), '[]'::jsonb) from review_items i where i.state = 'open'),
      'usage', (select jsonb_build_object('mx', max(created_at), 'n', count(*)) from usage_log where not cache_hit and stage = 'extract')) as d`),
    loadDocuments(pool),
  ]);
  const d = meta.rows[0]?.d ?? {};
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
  return { stored: storedRun(d.usage), messages };
});
