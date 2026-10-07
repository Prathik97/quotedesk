// Local dev only: serves /api/* by loading the same catch-all function Vercel
// deploys (api/[[...path]].ts), adapting Node's req/res to the small subset of the Vercel API we use.
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

type ShimRes = ServerResponse & {
  status: (code: number) => ShimRes;
  json: (body: unknown) => ShimRes;
  send: (body: unknown) => ShimRes;
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks);
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return raw.toString('utf8');
    }
  }
  return raw;
}

export function apiShim(): Plugin {
  return {
    name: 'quotedesk-api-shim',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api')) return next();
        const url = new URL(req.url, 'http://localhost');
        const file = path.join(server.config.root, 'api', '[[...path]].ts');
        const r = res as ShimRes;
        r.status = (code) => {
          r.statusCode = code;
          return r;
        };
        r.json = (body) => {
          r.setHeader('content-type', 'application/json');
          r.end(JSON.stringify(body));
          return r;
        };
        r.send = (body) => {
          r.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
          return r;
        };
        try {
          const mod = await server.ssrLoadModule(file);
          const query: Record<string, string> = {};
          url.searchParams.forEach((v, k) => (query[k] = v));
          Object.assign(req, { query, body: await readBody(req), cookies: {} });
          await mod.default(req, r);
        } catch (err) {
          server.config.logger.error(`[api-shim] ${url.pathname}: ${(err as Error).message}`);
          if (!r.headersSent) r.status(500).json({ error: 'internal', message: 'Something went wrong on the server.' });
        }
      });
    },
  };
}
