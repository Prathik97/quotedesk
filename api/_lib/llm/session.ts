// Budget session identity. Local runs share one session id stored in
// .qd-session (gitignored) so the spend cap accumulates across every script
// and dev server run until the file is deliberately removed.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(process.cwd(), '.qd-session');
let cached: string | null = null;

export function budgetSessionId(): string {
  if (cached) return cached;
  if (process.env.QD_BUDGET_SESSION) return (cached = process.env.QD_BUDGET_SESSION);
  try {
    const v = fs.readFileSync(FILE, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(v)) return (cached = v);
  } catch {
    // no file yet
  }
  const id = randomUUID();
  try {
    fs.writeFileSync(FILE, id + '\n');
  } catch {
    // read only filesystem (serverless): the id lives for this process only
  }
  return (cached = id);
}
