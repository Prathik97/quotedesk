import pg from 'pg';
import { env } from './env.js';
import { pgConfig } from './pgconfig.js';

let pool: pg.Pool | null = null;

/** Service connection (server only). One small pool per function instance. */
export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool(pgConfig(env().SUPABASE_DB_URL, { max: 3, idleTimeoutMillis: 10000 }));
  }
  return pool;
}

let roPool: pg.Pool | null = null;

/** Read only role (quotedesk_ro) for the analyst SQL tool: SELECT on a few views, nothing else. */
export function roDb(): pg.Pool {
  if (!roPool) {
    const url = env().SUPABASE_DB_READONLY_URL;
    if (!url) throw new Error('SUPABASE_DB_READONLY_URL is not set. Run npm run db:migrate.');
    roPool = new pg.Pool(pgConfig(url, { max: 2, idleTimeoutMillis: 10000, query_timeout: 7000 }));
  }
  return roPool;
}
