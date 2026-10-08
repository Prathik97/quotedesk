// Reset demo (FR-12.3): put the shared demo back to its seeded state.
//
// Cleared:  buyer corrections and the overrides they wrote, buyer changes to FX and GST,
//           review items a buyer dismissed or resolved (they reopen), and chat sessions.
// Also cleared: co-pilot drafts, the emails they issued (the five saved FY27 emails stay) and inbox reveals.
// Kept:     everything extraction produced (documents, extractions, quote lines as read,
//           answers, terms), the seeded RFx, usage_log (spend is real), and the saved analyst
//           chats from development, which are what visitors see when the spend cap is reached.
// Then a deterministic recompute rebuilds every derived field. No model call is made.
import type pg from 'pg';
import { defaults, GLOBAL_KEYS } from '../compare/assumptions.js';
import { recompute } from '../compare/recompute.js';

/** The notes written by seed/load.ts, so a reset row is identical to a seeded one. */
const SEED_NOTE: Record<(typeof GLOBAL_KEYS)[number], string> = {
  usd_inr: 'Default from configuration. No vendor stated a rate.',
  gst_pct: 'Default from configuration. Display and conversion only.',
};

export type ResetSummary = {
  corrections_cleared: number;
  overrides_cleared: number;
  assumptions_restored: number;
  review_items_reopened: number;
  chats_cleared: number;
  drafts_cleared: number;
  outbox_cleared: number;
  inbox_reveals_cleared: number;
  cells_changed_by_recompute: number;
  ms: number;
};

export async function resetDemo(pool: pg.Pool): Promise<ResetSummary> {
  const t0 = Date.now();
  const c = await pool.connect();
  let out: Omit<ResetSummary, 'cells_changed_by_recompute' | 'ms'>;
  try {
    await c.query('begin');
    const corrections = await c.query('delete from corrections');
    const overrides = await c.query(`update quote_lines set overrides = '{}'::jsonb where overrides <> '{}'::jsonb`);
    const d = defaults();
    let restored = 0;
    for (const key of GLOBAL_KEYS) {
      const r = await c.query(
        `update assumptions set value = $2::jsonb, set_by = 'system', note = $3
         where key = $1 and scope = 'global' and (set_by <> 'system' or value <> $2::jsonb or note is distinct from $3)`,
        [key, JSON.stringify(d[key]), SEED_NOTE[key]],
      );
      restored += r.rowCount ?? 0;
    }
    const items = await c.query(`update review_items set state = 'open', resolution = null where state <> 'open'`);
    const chats = await c.query('delete from chat_sessions where not is_saved_demo');
    // Co-pilot drafts, the emails they issued and the inbox reveals. The saved FY27 emails (is_saved) stay.
    const outbox = await c.query('delete from outbox_emails where not is_saved');
    const drafts = await c.query('delete from rfx_drafts');
    const reveals = await c.query('delete from inbox_reveals');
    // The hourly limits only need an hour of history.
    await c.query(`delete from request_log where created_at < now() - interval '2 days'`);
    await c.query('commit');
    out = {
      corrections_cleared: corrections.rowCount ?? 0,
      overrides_cleared: overrides.rowCount ?? 0,
      assumptions_restored: restored,
      review_items_reopened: items.rowCount ?? 0,
      chats_cleared: chats.rowCount ?? 0,
      drafts_cleared: drafts.rowCount ?? 0,
      outbox_cleared: outbox.rowCount ?? 0,
      inbox_reveals_cleared: reveals.rowCount ?? 0,
    };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  const rec = await recompute(pool);
  return { ...out, cells_changed_by_recompute: rec.changed.length, ms: Date.now() - t0 };
}
