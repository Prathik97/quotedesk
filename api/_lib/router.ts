// The router for the whole API. api/[[...path]].ts re-exports the bundled build of this file
// (scripts/build-function.mjs); dev and tests import this source file directly.
// An internal router maps /api/<name> to a handler in routes/.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import analyst from './routes/analyst.js';
import assumptions from './routes/assumptions.js';
import compare from './routes/compare.js';
import documents from './routes/documents.js';
import exportRoute from './routes/export.js';
import evidence from './routes/evidence.js';
import extract from './routes/extract.js';
import health from './routes/health.js';
import inbox from './routes/inbox.js';
import normalize from './routes/normalize.js';
import review from './routes/review.js';
import ready from './routes/ready.js';
import resetDemo from './routes/reset-demo.js';
import rfx from './routes/rfx.js';
import usage from './routes/usage.js';
import vendor from './routes/vendor.js';

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

const routes: Record<string, Handler> = {
  analyst, assumptions, compare, documents, evidence, export: exportRoute, extract, health, inbox, normalize, ready, review, 'reset-demo': resetDemo, rfx, usage, vendor,
};

const known = (name: string | undefined): name is string => !!name && Object.prototype.hasOwnProperty.call(routes, name);

/** The route name from the URL, or from the catch all's path parameter if the platform rewrote the URL. */
function routeName(req: VercelRequest): string {
  const fromUrl = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)[0];
  if (known(fromUrl)) return fromUrl;
  const q = req.query?.path;
  const fromQuery = (Array.isArray(q) ? q[0] : q)?.split('/')[0];
  return known(fromQuery) ? fromQuery : (fromUrl ?? '');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const name = routeName(req);
  const fn = known(name) ? routes[name] : undefined;
  if (!fn) {
    res.status(404).json({ error: 'not_found', message: 'There is no API route at that address.' });
    return;
  }
  try {
    await fn(req, res);
  } catch {
    // Every route wraps its own errors. This is the last line of defence: no stack, no detail.
    if (!res.headersSent) res.status(500).json({ error: 'internal', message: 'Something went wrong on the server. Try again, and if it repeats, use Reset demo.' });
    else res.end();
  }
}
