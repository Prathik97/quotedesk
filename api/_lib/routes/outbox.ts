// GET /api/outbox?browser_id=X              the five saved emails of the FY27 RFx and this browser's issued drafts
// GET /api/outbox?pack=saved                the saved RFx pack (PDF)
// GET /api/outbox?pack=<draft id>&browser_id=X   the pack of this browser's issued draft (PDF)
// Nothing is ever sent: every email is simulated and says so.
import type pg from 'pg';
import { z } from 'zod';
import { BrowserId, getDraft } from '../copilot/drafts.js';
import { db } from '../db.js';
import { ApiError, route } from '../http.js';
import { packFromDraft, renderPack } from '../outbox/pack.js';
import { loadSavedPack, savedBuyerOrg } from '../outbox/saved.js';

export type EmailView = {
  id: string; vendor_key: string | null; vendor_name: string; to_email: string | null; subject: string; body: string;
  attachment_filename: string; source: 'saved' | 'model' | 'template'; status: string; is_saved: boolean; created_at: string; draft_id: string | null;
};

const COLS = 'id, vendor_key, vendor_name, to_email, subject, body, attachment_filename, source, status, is_saved, created_at, draft_id';
type Row = Omit<EmailView, 'created_at'> & { created_at: Date };
const view = (r: Row): EmailView => ({ ...r, created_at: r.created_at.toISOString() });

export function packFilename(title: string | null): string {
  const slug = (title ?? 'rfx').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40).replace(/^_+|_+$/g, '') || 'rfx';
  return `RFx_pack_${slug}.pdf`;
}

export async function emailsOfDraft(pool: pg.Pool, draftId: string): Promise<EmailView[]> {
  const r = await pool.query<Row>(`select ${COLS} from outbox_emails where draft_id = $1 order by vendor_key`, [draftId]);
  return r.rows.map(view);
}

export default route(['GET'], async (req, res) => {
  const pool = db();
  const pack = typeof req.query.pack === 'string' ? req.query.pack : null;
  if (pack) {
    const now = new Date();
    let bytes: Uint8Array;
    let name: string;
    if (pack === 'saved') {
      const p = await loadSavedPack(pool);
      if (!p) throw new ApiError(404, 'not_found', 'No saved RFx is loaded.');
      bytes = await renderPack(p, now);
      name = packFilename(p.title);
    } else {
      const id = z.string().uuid().safeParse(pack);
      const bid = BrowserId.safeParse(req.query.browser_id);
      if (!id.success || !bid.success) throw new ApiError(400, 'bad_request', 'That pack address is not valid.');
      const d = await getDraft(pool, bid.data, id.data);
      if (!d || d.status !== 'issued') throw new ApiError(404, 'not_found', 'That RFx pack is not available. Only an issued RFx has one.');
      bytes = await renderPack(packFromDraft(d.rfx, await savedBuyerOrg(pool)), d.issued_at ? new Date(d.issued_at) : now);
      name = packFilename(d.rfx.terms.title);
    }
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('cache-control', 'private, max-age=60');
    res.status(200).send(Buffer.from(bytes));
    return undefined;
  }

  const bid = req.query.browser_id === undefined ? null : BrowserId.safeParse(req.query.browser_id);
  if (bid && !bid.success) throw new ApiError(400, 'bad_request', bid.error.issues[0]?.message ?? 'Missing browser id.');
  const [saved, drafts, title] = await Promise.all([
    pool.query<Row>(`select ${COLS} from outbox_emails where is_saved order by vendor_key`),
    bid
      ? pool.query<Row & { title: string | null; issued_at: Date | null }>(
          `select e.id, e.vendor_key, e.vendor_name, e.to_email, e.subject, e.body, e.attachment_filename, e.source, e.status, e.is_saved, e.created_at, e.draft_id,
                  d.state->'terms'->>'title' as title, d.issued_at
           from outbox_emails e join rfx_drafts d on d.id = e.draft_id where e.browser_id = $1 order by d.issued_at desc, e.vendor_key`,
          [bid.data],
        )
      : Promise.resolve({ rows: [] as (Row & { title: string | null; issued_at: Date | null })[] }),
    pool.query<{ title: string }>(`select title from rfx where is_saved_demo order by created_at limit 1`),
  ]);
  const groups = new Map<string, { draft_id: string; title: string | null; issued_at: string | null; emails: EmailView[] }>();
  for (const r of drafts.rows) {
    const key = r.draft_id as string;
    if (!groups.has(key)) groups.set(key, { draft_id: key, title: r.title, issued_at: r.issued_at?.toISOString() ?? null, emails: [] });
    groups.get(key)?.emails.push(view(r));
  }
  return { saved: { title: title.rows[0]?.title ?? 'Saved RFx', pack_url: '/api/outbox?pack=saved', emails: saved.rows.map(view) }, drafts: [...groups.values()] };
});
