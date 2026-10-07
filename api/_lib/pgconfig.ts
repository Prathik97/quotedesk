import type pg from 'pg';

/**
 * Supabase pooler connections need TLS, but node-postgres treats sslmode in the
 * URL as full verification against a CA we do not ship. Strip it and set TLS here.
 */
export function pgConfig(url: string, extra: Partial<pg.PoolConfig> = {}): pg.PoolConfig {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  return {
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    ...extra,
  };
}
