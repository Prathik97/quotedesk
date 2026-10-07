// The single Vercel function for the whole API (the Hobby plan allows 12).
// An internal router maps /api/<name> to a handler in _lib/routes.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import analyst from './_lib/routes/analyst.js';
import assumptions from './_lib/routes/assumptions.js';
import compare from './_lib/routes/compare.js';
import documents from './_lib/routes/documents.js';
import evidence from './_lib/routes/evidence.js';
import extract from './_lib/routes/extract.js';
import health from './_lib/routes/health.js';
import inbox from './_lib/routes/inbox.js';
import normalize from './_lib/routes/normalize.js';
import review from './_lib/routes/review.js';
import rfx from './_lib/routes/rfx.js';
import usage from './_lib/routes/usage.js';
import vendor from './_lib/routes/vendor.js';

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

const routes: Record<string, Handler> = {
  analyst, assumptions, compare, documents, evidence, extract, health, inbox, normalize, review, rfx, usage, vendor,
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const name = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)[0] ?? '';
  const fn = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : undefined;
  if (!fn) {
    res.status(404).json({ error: 'not_found', message: `No API route for /api/${name}.` });
    return;
  }
  await fn(req, res);
}
