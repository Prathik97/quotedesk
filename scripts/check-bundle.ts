// Verifies that no secret can reach the browser: scans everything in dist/ (the client build)
// for key patterns, for every variable NAME in .env.local, and for every variable VALUE in
// .env.local. It prints only PASS or FAIL per check and, on a failure, the variable name or the
// file path. It never prints a value. Run after `npm run build`.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { ENV_FILE } from './envfile.js';

const DIST = path.resolve('dist');
if (!fs.existsSync(DIST)) {
  console.error('dist/ not found. Run npm run build first.');
  process.exit(2);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const files = walk(DIST);
const rel = (f: string) => path.relative(DIST, f);
const texts = files.map((f) => ({ file: rel(f), text: /\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|webp)$/i.test(f) ? '' : fs.readFileSync(f, 'utf8') }));

const env = fs.existsSync(ENV_FILE) ? parse(fs.readFileSync(ENV_FILE)) : {};
const names = [...new Set([...Object.keys(env), 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_DB_URL', 'SUPABASE_DB_READONLY_URL', 'DEMO_ADMIN_TOKEN', 'IP_HASH_SALT'])];

const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, bad: string[]) => results.push({ check: name, ok: bad.length === 0, ...(bad.length ? { detail: bad.join(', ') } : {}) });

const hits = (re: RegExp) => texts.filter((t) => re.test(t.text)).map((t) => t.file);

check('Anthropic key pattern (sk-ant-...)', hits(/sk-ant-[A-Za-z0-9_-]{16,}/));
check('Supabase key patterns (JWT, sb_secret_, sb_publishable_, service_role)', [...hits(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/), ...hits(/sb_(secret|publishable)_[A-Za-z0-9_-]{8,}/), ...hits(/service_role/)]);
check('Database connection strings with a password', hits(/postgres(ql)?:\/\/[^\s"'`/]+:[^\s"'`@]+@/));
check(`Every variable name from .env.local and the server list (${names.length} names)`, names.filter((n) => texts.some((t) => t.text.includes(n))));
check(
  'Every variable value from .env.local (values of 8 or more characters)',
  Object.entries(env).filter(([, v]) => v && v.length >= 8).filter(([, v]) => texts.some((t) => t.text.includes(v))).map(([k]) => k),
);
check('No answer key, env file, seed data or source map shipped in dist/', files.map(rel).filter((f) => /truth\.json|(^|\/)\.env|(^|\/)seed\/|\.map$/.test(f)));

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? `  [${r.detail}]` : ''}`);
console.log(`Scanned ${files.length} files in dist/.`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
