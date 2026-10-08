// Budget session identity. The spend is always summed from usage_log, never from a file.
//
// On Vercel there is no writable disk and many function instances, so the session id must be
// the same everywhere and must not depend on a file: one id per Indian calendar day, derived
// from the date. All instances then share one Rs 300 ceiling per day through usage_log.
//
// Locally, one id is kept in .qd-session (gitignored) so the cap accumulates across every
// script and dev server run until the file is deliberately removed.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(process.cwd(), '.qd-session');
let cached: string | null = null;

/** The Indian calendar date, which is the day the daily cap and the usage meter count. */
export function istDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** A stable uuid for a name, so every function instance computes the same id. */
export function uuidFromName(name: string): string {
  const h = createHash('sha256').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function dailySessionId(now: Date = new Date()): string {
  return uuidFromName(`quotedesk-budget-${istDate(now)}`);
}

export function budgetSessionId(): string {
  if (process.env.QD_BUDGET_SESSION) return process.env.QD_BUDGET_SESSION;
  // Not cached: on a long lived instance the day can change.
  if (process.env.VERCEL) return dailySessionId();
  if (cached) return cached;
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
    // read only filesystem: the id lives for this process only
  }
  return (cached = id);
}
