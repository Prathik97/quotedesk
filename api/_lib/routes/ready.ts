// GET /api/ready: layer by layer readiness. Reports which layer fails, never a value.
// Layers: config (required names present and valid), prompts (files readable), database
// (a trivial query), readonly_database (the analyst's role). Status 200 only if all pass.
import fs from 'node:fs';
import { db, roDb } from '../db.js';
import { envStatus } from '../env.js';
import { route } from '../http.js';
import { promptsDir } from '../extract/model.js';

type Layer = 'ok' | 'failed' | 'skipped';

export default route(['GET'], async (_req, res) => {
  const cfg = envStatus();
  const layers: Record<string, Layer> = { config: cfg.complete ? 'ok' : 'failed', prompts: 'failed', database: 'skipped', readonly_database: 'skipped' };
  try {
    layers.prompts = fs.readdirSync(promptsDir()).some((f) => f.endsWith('.md')) ? 'ok' : 'failed';
  } catch {
    layers.prompts = 'failed';
  }
  if (cfg.complete) {
    try {
      await db().query('select 1');
      layers.database = 'ok';
    } catch {
      layers.database = 'failed';
    }
    try {
      await roDb().query('select 1');
      layers.readonly_database = 'ok';
    } catch {
      layers.readonly_database = 'failed';
    }
  }
  const ok = Object.values(layers).every((v) => v === 'ok');
  const failed = Object.entries(layers).filter(([, v]) => v !== 'ok').map(([k]) => k);
  res.status(ok ? 200 : 503).json({
    ok,
    layers,
    failed,
    // Names only, so the owner knows what to add in Vercel.
    missing_settings: cfg.missing,
    time: new Date().toISOString(),
  });
});
