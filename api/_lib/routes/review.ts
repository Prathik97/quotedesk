// GET /api/review: the review queue, sorted by value at stake.
// POST /api/review { action, ... }: accept as read, edit value, set unit meaning, mark not quoted,
// dismiss with a reason, or undo. Every action writes a corrections row, then recomputes at once.
import { z } from 'zod';
import { BLOCKER_KINDS } from '../../../engine/certainty.js';
import { assumptionText } from '../../../engine/explain.js';
import type { LineOverrides } from '../../../engine/recompute.js';
import type { ActionResponse, ReviewItem, ReviewResponse } from '../../../src/lib/api-types.js';
import { defaults } from '../compare/assumptions.js';
import { storedRun } from '../compare/data.js';
import { recompute } from '../compare/recompute.js';
import { db } from '../db.js';
import { ApiError, route } from '../http.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const reason = z.string().trim().max(500);
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), quote_line_id: z.string().uuid(), reason: reason.optional(), review_item_id: z.string().uuid().optional() }),
  z.object({
    action: z.literal('edit'), quote_line_id: z.string().uuid(), price: z.number().positive().max(1e9), currency: z.enum(['INR', 'USD']).optional(),
    uom_text: z.string().trim().min(1).max(60).optional(), reason: reason.optional(), review_item_id: z.string().uuid().optional(),
  }),
  z.object({ action: z.literal('unit'), quote_line_id: z.string().uuid(), quantity: z.number().positive().max(1e6), reason: reason.optional(), review_item_id: z.string().uuid().optional() }),
  z.object({ action: z.literal('not_quoted'), quote_line_id: z.string().uuid(), reason: reason.min(3, 'Say why this line is not quoted.'), review_item_id: z.string().uuid().optional() }),
  z.object({ action: z.literal('dismiss'), review_item_id: z.string().uuid(), reason: reason.min(3, 'A dismissal needs a reason.') }),
  z.object({ action: z.literal('undo'), quote_line_id: z.string().uuid(), reason: reason.optional() }),
]);

const VENDOR_VALUE_KINDS = ['knockout_failed', 'knockout_pending', 'suspicious_content', 'low_visibility_text', 'certificate_expired', 'attachment_name_mismatch', 'conflict'];

export default route(['GET', 'POST'], async (req): Promise<ReviewResponse | ActionResponse> => {
  const pool = db();
  if (req.method === 'GET') return listReview(pool);
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'The review action is not valid.');
  return applyAction(pool, parsed.data);
});

async function listReview(pool: ReturnType<typeof db>): Promise<ReviewResponse> {
  const raw = (
    await pool.query<{ d: Json }>(`
      select jsonb_build_object(
        'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'severity', i.severity, 'vendor_id', i.vendor_id, 'quote_line_id', i.quote_line_id,
            'document_id', i.document_id, 'message', i.message, 'value', i.value_at_stake_inr, 'state', i.state, 'resolution', i.resolution,
            'code', l.code, 'uom', l.uom, 'quoted_uom', q.quoted_uom_text, 'quoted_price', q.quoted_price, 'currency', q.quoted_currency) order by i.created_at), '[]'::jsonb)
            from review_items i left join quote_lines q on q.id = i.quote_line_id left join rfx_lines l on l.id = q.rfx_line_id),
        'assumed', (select coalesce(jsonb_agg(jsonb_build_object('quote_line_id', c.quote_line_id, 'vendor_id', c.vendor_id, 'code', c.line_code, 'value', c.annual_value_inr,
            'keys', c.assumption_keys, 'uom', c.uom, 'quoted_uom', c.quoted_uom_text, 'quoted_price', c.quoted_price, 'currency', c.quoted_currency, 'doc', q.source_document_id)), '[]'::jsonb)
            from comparison_view c join quote_lines q on q.id = c.quote_line_id where c.status = 'assumed'),
        'vendors', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'key', v.vendor_key, 'name', v.name)), '[]'::jsonb) from vendors v),
        'totals', (select coalesce(jsonb_agg(jsonb_build_object('vendor_id', t.vendor_id, 'total', t.total)), '[]'::jsonb)
            from (select vendor_id, sum(annual_value_inr) as total from comparison_view group by vendor_id) t),
        'usage', (select jsonb_build_object('mx', max(created_at), 'n', count(*)) from usage_log where not cache_hit and stage = 'extract')
      ) as d`)
  ).rows[0]?.d as Json;
  const vendors = new Map((raw.vendors as Json[]).map((v) => [v.id as string, v]));
  const totals = new Map((raw.totals as Json[]).map((t) => [t.vendor_id as string, Number(t.total ?? 0)]));
  const d = defaults();
  const items: ReviewItem[] = [];

  for (const i of raw.items as Json[]) {
    const v = vendors.get(i.vendor_id);
    const lineLevel = i.quote_line_id != null && ['line_needs_review', 'conflict'].includes(i.kind);
    let value: number | null = i.value == null ? null : Number(i.value);
    if (value == null && VENDOR_VALUE_KINDS.includes(i.kind)) value = totals.get(i.vendor_id) ?? null;
    items.push({
      id: i.id, kind: i.kind, tier: lineLevel ? 'needs_review' : 'vendor', severity: i.severity, vendor_id: i.vendor_id, vendor_key: v?.key ?? '', vendor_name: v?.name ?? '',
      quote_line_id: i.quote_line_id ?? null, rfx_line_code: i.code ?? null, document_id: i.document_id ?? null, message: i.message, value_at_stake_inr: value, state: i.state,
      resolution: i.resolution ?? null, is_blocker: BLOCKER_KINDS.includes(i.kind) || i.severity === 'block',
      actions: lineLevel ? ['accept', 'edit', 'unit', 'not_quoted', 'dismiss'] : ['dismiss'],
      base_uom: i.uom ?? null, quoted_uom: i.quoted_uom ?? null, quoted_price: i.quoted_price == null ? null : Number(i.quoted_price), quoted_currency: i.currency ?? null,
    });
  }
  // Assumed cells are listed as items a buyer can confirm, edit or fix. They have no review row to dismiss.
  for (const c of raw.assumed as Json[]) {
    const v = vendors.get(c.vendor_id);
    const text = ((c.keys ?? []) as string[]).map((k) => assumptionText(k, d)).join(' ');
    items.push({
      id: `cell:${c.quote_line_id}`, kind: 'assumed_cell', tier: 'assumed', severity: 'info', vendor_id: c.vendor_id, vendor_key: v?.key ?? '', vendor_name: v?.name ?? '',
      quote_line_id: c.quote_line_id, rfx_line_code: c.code, document_id: c.doc ?? null, message: `${c.code}: Assumed. ${text || 'Read from a photo; photo values are never confirmed automatically.'}`,
      value_at_stake_inr: c.value == null ? null : Number(c.value), state: 'open', resolution: null, is_blocker: false, actions: ['accept', 'edit', 'unit', 'not_quoted'],
      base_uom: c.uom ?? null, quoted_uom: c.quoted_uom ?? null, quoted_price: c.quoted_price == null ? null : Number(c.quoted_price), quoted_currency: c.currency ?? null,
    });
  }
  items.sort((a, b) => {
    if ((a.state === 'open') !== (b.state === 'open')) return a.state === 'open' ? -1 : 1;
    const av = a.value_at_stake_inr ?? -1;
    const bv = b.value_at_stake_inr ?? -1;
    if (av !== bv) return bv - av;
    return Number(b.is_blocker) - Number(a.is_blocker);
  });
  const open = items.filter((i) => i.state === 'open');
  return {
    stored: storedRun(raw.usage),
    items,
    counts: {
      needs_review: open.filter((i) => i.tier === 'needs_review').length,
      assumed: open.filter((i) => i.tier === 'assumed').length,
      vendor: open.filter((i) => i.tier === 'vendor').length,
      open_total: open.length,
      resolved: items.length - open.length,
    },
  };
}

async function applyAction(pool: ReturnType<typeof db>, a: z.infer<typeof Body>): Promise<ActionResponse> {
  if (a.action === 'dismiss') return dismiss(pool, a);
  const row = (
    await pool.query<{ id: string; vendor_id: string; overrides: LineOverrides; quoted_price: string | null; quoted_uom_text: string | null; quoted_currency: string | null; price_basis: Json; code: string; uom: string }>(
      `select q.id, q.vendor_id, q.overrides, q.quoted_price, q.quoted_uom_text, q.quoted_currency, q.price_basis, l.code, l.uom
       from quote_lines q join rfx_lines l on l.id = q.rfx_line_id where q.id = $1`,
      [a.quote_line_id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, 'not_found', 'That cell does not exist. Reload the page.');
  const old = row.overrides ?? {};
  let next: LineOverrides = { ...old };
  const logs: { field: string; old: unknown; neu: unknown }[] = [];
  let why = ('reason' in a && a.reason) || '';

  switch (a.action) {
    case 'accept':
      next = { ...old, verified: true };
      logs.push({ field: 'verified', old: old.verified === true, neu: true });
      why ||= 'Checked against the source and accepted as read.';
      break;
    case 'edit': {
      next = { ...old, verified: true, price: a.price, ...(a.currency ? { currency: a.currency } : {}), ...(a.uom_text ? { uom_text: a.uom_text } : {}) };
      logs.push({ field: 'price', old: old.price ?? (row.quoted_price == null ? null : Number(row.quoted_price)), neu: a.price });
      if (a.currency) logs.push({ field: 'currency', old: old.currency ?? row.quoted_currency, neu: a.currency });
      if (a.uom_text) logs.push({ field: 'unit', old: old.uom_text ?? row.quoted_uom_text, neu: a.uom_text });
      why ||= 'Value corrected against the source.';
      break;
    }
    case 'unit':
      next = { ...old, verified: true, pack: { quantity: a.quantity, unit: row.uom } };
      logs.push({ field: 'unit_meaning', old: old.pack?.quantity ?? row.price_basis?.pack_size ?? null, neu: a.quantity });
      why ||= `Unit meaning set: 1 ${(row.quoted_uom_text ?? 'unit').replace(/^\s*per\s+/i, '')} = ${a.quantity} ${row.uom}.`;
      break;
    case 'not_quoted':
      next = { ...old, not_quoted: true };
      logs.push({ field: 'not_quoted', old: false, neu: true });
      break;
    case 'undo':
      next = {};
      logs.push({ field: 'overrides', old, neu: {} });
      why ||= 'Buyer changes undone. The original reading is restored.';
      break;
  }

  const c = await pool.connect();
  let correctionId = '';
  try {
    await c.query('begin');
    await c.query('update quote_lines set overrides = $2 where id = $1', [row.id, JSON.stringify(next)]);
    for (const l of logs) {
      const r = await c.query<{ id: string }>(
        `insert into corrections (quote_line_id, vendor_id, review_item_id, action, field, old_value, new_value, reason) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [row.id, row.vendor_id, ('review_item_id' in a && a.review_item_id) || null, a.action, l.field, JSON.stringify(l.old ?? null), JSON.stringify(l.neu ?? null), why],
      );
      correctionId ||= r.rows[0]?.id ?? '';
    }
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }

  const summary = await recompute(pool, { vendorIds: [row.vendor_id] });
  // Say who and why on the item the recompute closed on its own.
  await pool.query(
    `update review_items set resolution = jsonb_build_object('action', $2::text, 'reason', $3::text, 'correction_id', $4::text)
     where quote_line_id = $1 and state = 'resolved' and resolution->>'auto' = 'true'`,
    [row.id, a.action, why, correctionId],
  );
  return { ok: true, correction_id: correctionId, recompute: summary };
}

async function dismiss(pool: ReturnType<typeof db>, a: Extract<z.infer<typeof Body>, { action: 'dismiss' }>): Promise<ActionResponse> {
  const item = (await pool.query<{ id: string; vendor_id: string; quote_line_id: string | null; state: string; kind: string }>('select id, vendor_id, quote_line_id, state, kind from review_items where id = $1', [a.review_item_id])).rows[0];
  if (!item) throw new ApiError(404, 'not_found', 'That review item no longer exists. Reload the page.');
  if (item.state !== 'open') throw new ApiError(409, 'already_closed', 'That item is already closed.');
  const c = await pool.connect();
  let correctionId = '';
  try {
    await c.query('begin');
    await c.query(`update review_items set state = 'dismissed', resolution = $2 where id = $1`, [item.id, JSON.stringify({ action: 'dismiss', reason: a.reason })]);
    const r = await c.query<{ id: string }>(
      `insert into corrections (quote_line_id, vendor_id, review_item_id, action, field, old_value, new_value, reason) values ($1,$2,$3,'dismiss','review_item',$4,$5,$6) returning id`,
      [item.quote_line_id, item.vendor_id, item.id, JSON.stringify('open'), JSON.stringify('dismissed'), a.reason],
    );
    correctionId = r.rows[0]?.id ?? '';
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  const summary = await recompute(pool, { vendorIds: [item.vendor_id] });
  return { ok: true, correction_id: correctionId, recompute: summary };
}
