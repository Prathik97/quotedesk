// Independent checks for the analyst test questions. These read the base tables directly with plain SQL
// and recompute in plain JavaScript. They share no code with engine/award.ts or the analyst tools.
import pg from 'pg';
import { pgConfig } from '../../api/_lib/pgconfig.js';
import { loadEnvLocal, requireEnv } from '../envfile.js';

loadEnvLocal();
export const pool = new pg.Pool(pgConfig(requireEnv('SUPABASE_DB_URL'), { max: 2 }));

export type Cell = { vendor: string; line: string; sort: number; section: string; qty: number; ly: number; price: number | null; status: string; keys: string[]; conds: string[] };

/** Every vendor by line cell straight from the tables, at the stored global assumptions. */
export async function cells(): Promise<Cell[]> {
  const r = await pool.query(`
    select v.vendor_key vendor, l.code line, l.sort, l.section, l.annual_qty::float qty, l.last_year_rate_inr::float ly,
           q.normalized_price_inr::float price, coalesce(q.status,'missing') status, coalesce(q.assumption_keys,'{}') keys, q.conditions conds
    from vendors v cross join rfx_lines l
    left join lateral (select * from quote_lines q where q.vendor_id=v.id and q.rfx_line_id=l.id and q.status<>'rejected' order by created_at desc limit 1) q on true
    order by v.vendor_key, l.sort`);
  return r.rows.map((x) => ({ ...x, conds: Array.isArray(x.conds) ? x.conds : [] }));
}

export const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const lakh = (n: number) => `${(n / 1e5).toFixed(2)} lakh`;
export const crore = (n: number) => `${(n / 1e7).toFixed(4)} crore`;

export async function questionnaire(): Promise<Record<string, string>> {
  const r = await pool.query(`select v.vendor_key k, case when 'questionnaire_failed' = any(t.flags) then 'Failed' when 'questionnaire_pending' = any(t.flags) then 'Pending' when 'questionnaire_cleared' = any(t.flags) then 'Cleared' end q from vendors v join vendor_terms t on t.vendor_id=v.id`);
  return Object.fromEntries(r.rows.map((x) => [x.k, x.q]));
}

/** Plain cheapest per line over a set of vendors and statuses. Returns winners and the total. */
export function cheapest(all: Cell[], vendors: string[], statuses = ['confirmed', 'assumed'], fxScale: (c: Cell) => number = () => 1) {
  const winners: Record<string, { vendor: string; price: number; value: number; status: string }> = {};
  let total = 0;
  let ly = 0;
  for (const line of [...new Set(all.map((c) => c.line))]) {
    const offers = all.filter((c) => c.line === line && vendors.includes(c.vendor) && c.price != null && statuses.includes(c.status)).map((c) => ({ c, p: (c.price as number) * fxScale(c) }));
    offers.sort((a, b) => a.p - b.p);
    const w = offers[0];
    if (!w) continue;
    const value = w.p * w.c.qty;
    winners[line] = { vendor: w.c.vendor, price: w.p, value, status: w.c.status };
    total += value;
    ly += w.c.ly * w.c.qty;
  }
  return { winners, total, ly, saving: ly - total, lines: Object.keys(winners).length };
}
