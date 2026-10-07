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
