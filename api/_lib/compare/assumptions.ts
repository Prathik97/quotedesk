// Global assumptions (FX, GST). The latest row wins; a buyer edit replaces the system default in place.
import type pg from 'pg';
import type { Assumptions } from '../../../engine/types.js';

export const GLOBAL_KEYS = ['usd_inr', 'gst_pct'] as const;
export type GlobalKey = (typeof GLOBAL_KEYS)[number];

export function defaults(): Assumptions {
  return { usd_inr: Number(process.env.DEFAULT_USD_INR ?? 96), gst_pct: Number(process.env.DEFAULT_GST_PCT ?? 18) };
}

export async function loadAssumptions(pool: pg.Pool): Promise<Assumptions> {
  const r = await pool.query<{ key: string; value: number }>(`select key, value from assumptions where scope = 'global' and key = any($1) order by created_at desc`, [GLOBAL_KEYS]);
  const d = defaults();
  const get = (k: GlobalKey) => Number(r.rows.find((x) => x.key === k)?.value ?? d[k]);
  return { usd_inr: get('usd_inr'), gst_pct: get('gst_pct') };
}

export type AssumptionRow = { key: GlobalKey; label: string; value: number; default_value: number; set_by: 'system' | 'buyer'; note: string | null };

export async function listGlobal(pool: pg.Pool): Promise<AssumptionRow[]> {
  const r = await pool.query<{ key: GlobalKey; label: string; value: number; set_by: 'system' | 'buyer'; note: string | null }>(
    `select key, label, value, set_by, note from assumptions where scope = 'global' and key = any($1) order by key desc`,
    [GLOBAL_KEYS],
  );
  const d = defaults();
  return r.rows.map((x) => ({ ...x, value: Number(x.value), default_value: d[x.key] }));
}

/** Sets a global assumption as the buyer. Returns the previous value. */
export async function setGlobal(pool: pg.Pool, key: GlobalKey, value: number | null): Promise<{ old: number; value: number; set_by: 'system' | 'buyer' }> {
  const d = defaults();
  const old = (await loadAssumptions(pool))[key];
  const reset = value == null;
  const next = reset ? d[key] : value;
  const label = key === 'usd_inr' ? 'USD to INR rate' : 'GST percentage';
  await pool.query(
    `insert into assumptions (key, label, value, scope, set_by, note) values ($1, $2, $3, 'global', $4, $5)
     on conflict (key, scope, coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(rfx_line_id, '00000000-0000-0000-0000-000000000000'::uuid))
     do update set value = excluded.value, set_by = excluded.set_by, note = excluded.note`,
    [key, label, JSON.stringify(next), reset ? 'system' : 'buyer', reset ? 'Reset to the system default.' : 'Set by the buyer.'],
  );
  return { old, value: next, set_by: reset ? 'system' : 'buyer' };
}
