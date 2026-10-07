// Applies supabase/migrations/*.sql in order, once each, tracked in
// schema_migrations. Usage: npm run db:migrate [-- --rotate-ro]
// The read only role password is generated here and written only to .env.local.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { pgConfig } from '../api/_lib/pgconfig.js';
import { loadEnvLocal, requireEnv, setEnvLocal } from './envfile.js';

const DIR = path.resolve('supabase/migrations');
const RO_FILE = '0004_readonly_role.sql';

function readonlyUrl(serviceUrl: string, password: string): string {
  const u = new URL(serviceUrl);
  // Supabase pooler user names look like "postgres.<project ref>".
  const [, ref] = decodeURIComponent(u.username).split('.');
  u.username = ref ? `quotedesk_ro.${ref}` : 'quotedesk_ro';
  u.password = password;
  return u.toString();
}

async function verifyReadonly(url: string): Promise<{ ok: boolean; detail: string }> {
  const c = new pg.Client(pgConfig(url));
  try {
    await c.connect();
  } catch (e) {
    return { ok: false, detail: `cannot connect as read only role (${(e as Error).message.split('\n')[0]})` };
  }
  try {
    await c.query('select count(*) from comparison_view');
    const tableDenied = await c.query('select 1 from rfx limit 1').then(
      () => false,
      () => true,
    );
    const writeDenied = await c.query('create temp table _probe (x int)').then(
      () => false,
      () => true,
    );
    if (!tableDenied) return { ok: false, detail: 'role can read base tables' };
    if (!writeDenied) return { ok: false, detail: 'role can write' };
    return { ok: true, detail: 'reads views, base tables denied, writes denied' };
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const serviceUrl = requireEnv('SUPABASE_DB_URL');
  const rotate = process.argv.includes('--rotate-ro');
  const client = new pg.Client(pgConfig(serviceUrl));
  await client.connect();
  await client.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );
  await client.query('alter table schema_migrations enable row level security');
  const applied = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let roPassword: string | null = null;

  for (const f of files) {
    const again = rotate && f === RO_FILE;
    if (applied.has(f) && !again) continue;
    let sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (sql.includes('__RO_PASSWORD__')) {
      roPassword = randomBytes(24).toString('hex');
      sql = sql.replaceAll('__RO_PASSWORD__', roPassword);
    }
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1) on conflict (name) do update set applied_at = now()', [f]);
      await client.query('commit');
      console.log(`applied ${f}`);
    } catch (e) {
      await client.query('rollback');
      // Postgres error text can echo the statement; print only the first line.
      throw new Error(`${f} failed: ${(e as Error).message.split('\n')[0]?.replace(/password '[^']*'/g, "password '***'")}`);
    }
  }
  await client.end();

  if (roPassword) {
    const url = readonlyUrl(serviceUrl, roPassword);
    const check = await verifyReadonly(url);
    if (check.ok) {
      setEnvLocal('SUPABASE_DB_READONLY_URL', url);
      console.log(`read only role: verified (${check.detail}); SUPABASE_DB_READONLY_URL written to .env.local`);
    } else {
      setEnvLocal('SUPABASE_DB_READONLY_URL', '');
      console.log(`read only role: FALLBACK needed (${check.detail})`);
    }
  } else {
    console.log('no new migrations');
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
