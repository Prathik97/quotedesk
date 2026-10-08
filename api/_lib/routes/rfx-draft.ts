// The buyer's draft RFx (not the seeded one).
//   GET  /api/rfx-draft?browser_id=X       the newest draft of this browser, or null
//   POST {action:'new'}                     starts a blank draft
//   POST {action:'save'}                    saves cell edits the buyer made directly
//   POST {action:'email'}                   drafts the covering email (ONE model call, or the template)
//   POST {action:'issue'}                   creates the five simulated emails; blocked while validation has errors
// Drafts live in rfx_drafts and outbox_emails only. The seeded RFx, lines, vendors and extractions are read, never written.
import { z } from 'zod';
import { validateRfx } from '../../../engine/rfx.js';
import { BrowserId, createDraft, DraftLimitError, DraftRfxSchema, getDraft, latestDraft, saveState, viewOf } from '../copilot/drafts.js';
import { db } from '../db.js';
import { env } from '../env.js';
import { admitModelCall } from '../guard.js';
import { ApiError, log, route } from '../http.js';
import { realClient } from '../llm/client.js';
import { budgetSessionId } from '../llm/session.js';
import { pgStore } from '../llm/store.js';
import { personalise, resolveEmail } from '../outbox/email.js';
import { savedBuyerOrg, savedVendors } from '../outbox/saved.js';
import { emailsOfDraft, packFilename } from './outbox.js';

const Base = { browser_id: BrowserId };
const Body = z.discriminatedUnion('action', [
  z.object({ ...Base, action: z.literal('new') }),
  z.object({ ...Base, action: z.literal('discard'), draft_id: z.string().uuid() }),
  z.object({ ...Base, action: z.literal('save'), draft_id: z.string().uuid(), rfx: DraftRfxSchema }),
  z.object({ ...Base, action: z.literal('email'), draft_id: z.string().uuid(), mode: z.enum(['model', 'template']).default('model') }),
  z.object({
    ...Base, action: z.literal('issue'), draft_id: z.string().uuid(),
    subject: z.string().trim().min(1, 'The subject is empty.').max(160, 'Keep the subject under 160 characters.'),
    body: z.string().trim().min(20, 'The email body is too short.').max(6000, 'Keep the email under 6000 characters.'),
    source: z.enum(['model', 'template']),
  }),
]);

export default route(['GET', 'POST'], async (req) => {
  const pool = db();
  if (req.method === 'GET') {
    const id = BrowserId.safeParse(req.query.browser_id);
    if (!id.success) throw new ApiError(400, 'bad_request', id.error.issues[0]?.message ?? 'Missing browser id.');
    const d = await latestDraft(pool, id.data);
    return { draft: d ? { ...viewOf(d), emails: d.status === 'issued' ? await emailsOfDraft(pool, d.id) : [] } : null };
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'That request could not be read.');
  const b = parsed.data;

  if (b.action === 'new') {
    try {
      const d = await createDraft(pool, b.browser_id);
      return { draft: { ...viewOf(d), emails: [] } };
    } catch (e) {
      if (e instanceof DraftLimitError) throw new ApiError(503, 'too_many_drafts', e.message);
      throw e;
    }
  }

  const draft = await getDraft(pool, b.browser_id, b.draft_id);
  if (!draft) throw new ApiError(404, 'not_found', 'That draft is not in this browser. Start a new one.');

  if (b.action === 'discard') {
    // The draft's own simulated emails go with it (on delete cascade). Nothing seeded is touched.
    await pool.query('delete from rfx_drafts where id = $1 and browser_id = $2', [draft.id, b.browser_id]);
    return { ok: true };
  }

  if (b.action === 'save') {
    if (draft.status === 'issued') throw new ApiError(409, 'already_issued', 'This RFx was already issued and is final. Start a new draft to change it.');
    await saveState(pool, draft.id, b.rfx);
    return { ok: true, validation: validateRfx(b.rfx) };
  }

  if (b.action === 'email') {
    if (draft.status === 'issued') throw new ApiError(409, 'already_issued', 'This RFx was already issued.');
    const v = validateRfx(draft.rfx);
    if (!v.can_issue) throw new ApiError(422, 'has_errors', `Fix ${v.errors} ${v.errors === 1 ? 'error' : 'errors'} before issuing. The email is drafted once the RFx can be issued.`, { validation: v });
    const org = await savedBuyerOrg(pool);
    const out = await resolveEmail(draft.rfx, org, {
      mode: b.mode,
      admit: async () => {
        const gate = await admitModelCall(pool, req, 'outbox');
        return gate.ok ? { ok: true } : { ok: false, message: gate.message };
      },
      deps: { call: { client: { complete: (r) => realClient().complete(r) }, store: pgStore(pool), dailyCapInr: env().DAILY_SPEND_CAP_INR, log: (l) => console.log(l) }, model: env().MODEL_FAST, budgetSession: budgetSessionId(), route: 'api:rfx-draft' },
    });
    return { subject: out.draft.subject, body: out.draft.body, source: out.source, label: out.label, cost_inr: out.cost_inr, fallback: out.fallback, attachment: packFilename(draft.rfx.terms.title) };
  }

  // issue
  const c = await pool.connect();
  try {
    await c.query('begin');
    const locked = await c.query<{ status: string; state: unknown }>('select status, state from rfx_drafts where id = $1 for update', [draft.id]);
    if (locked.rows[0]?.status !== 'draft') {
      await c.query('rollback');
      throw new ApiError(409, 'already_issued', 'This RFx was already issued, so the emails exist already.');
    }
    // Re-checked here, not only in the browser: Issue is blocked while any error remains.
    const v = validateRfx(draft.rfx);
    if (!v.can_issue) {
      await c.query('rollback');
      throw new ApiError(422, 'has_errors', `Issue is blocked: ${v.errors} ${v.errors === 1 ? 'error' : 'errors'} to fix first.`, { validation: v });
    }
    const vendors = await savedVendors(pool);
    if (vendors.length === 0) {
      await c.query('rollback');
      throw new ApiError(500, 'no_vendors', 'There are no vendors to send to. Run the seed.');
    }
    const attach = packFilename(draft.rfx.terms.title);
    for (const vd of vendors) {
      await c.query(
        `insert into outbox_emails (draft_id, browser_id, is_saved, vendor_id, vendor_key, vendor_name, to_email, subject, body, attachment_filename, source)
         values ($1, $2, false, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [draft.id, b.browser_id, vd.id, vd.vendor_key, vd.name, vd.contact_email, personalise(b.subject, vd.name), personalise(b.body, vd.name), attach, b.source],
      );
    }
    await c.query(`update rfx_drafts set status = 'issued', issued_at = now(), updated_at = now() where id = $1`, [draft.id]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  log('info', 'rfx_issued', { draft: draft.id, vendors: 5 });
  const issued = await getDraft(pool, b.browser_id, draft.id);
  return { ok: true, draft: issued ? { ...viewOf(issued), emails: await emailsOfDraft(pool, draft.id) } : null };
});
