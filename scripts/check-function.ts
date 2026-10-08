// npm run check:function: builds, then loads the BUILT function in plain Node and calls the routes.
// The env is read from .env.local here and handed to the child process; nothing is printed.
// No model calls: health, ready, usage and compare do not use the model.
import { spawnSync } from 'node:child_process';
import { loadEnvLocal } from './envfile.js';

loadEnvLocal();

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env });
  return r.status ?? 1;
}

if (Number(process.versions.node.split('.')[0]) !== 22) {
  console.error(`FAIL need Node 22 (this is ${process.versions.node}). Vercel runs 22.x.`);
  process.exit(1);
}
if (run('node', ['scripts/build-function.mjs'], process.env) !== 0) process.exit(1);
// A clean child environment would hide missing variables; keep ours, but force caps so a stray
// route can never spend: 0 turns live model calls off.
const env = { ...process.env, DAILY_SPEND_CAP_INR: '0', PER_IP_HOURLY_CALLS: '0', NODE_OPTIONS: '' };
// --no-experimental-strip-types is not needed: the child is a plain .mjs importing a plain .mjs.
process.exit(run(process.execPath, ['scripts/check-function-run.mjs'], env));
