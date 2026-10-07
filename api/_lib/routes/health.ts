import { db } from '../db.js';
import { envStatus } from '../env.js';
import { route } from '../http.js';

export default route(['GET'], async () => {
  const cfg = envStatus();
  let database: 'ok' | 'unreachable' | 'not_configured' = 'not_configured';
  if (cfg.complete) {
    try {
      await db().query('select 1');
      database = 'ok';
    } catch {
      database = 'unreachable';
    }
  }
  return {
    ok: cfg.complete && database === 'ok',
    config: cfg.complete ? 'complete' : `missing ${cfg.missing.length} setting(s)`,
    database,
    time: new Date().toISOString(),
  };
});
