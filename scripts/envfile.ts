// Helpers for local scripts. Loads .env.local into process.env and can set one
// key in place. Never prints values.
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

export const ENV_FILE = path.resolve(process.cwd(), '.env.local');

export function loadEnvLocal(): void {
  config({ path: ENV_FILE, quiet: true });
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set in .env.local`);
  return v;
}

export function setEnvLocal(key: string, value: string): void {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 });
  process.env[key] = value;
}
