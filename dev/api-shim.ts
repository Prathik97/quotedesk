// Local dev only: serves /api/* by loading the same handler files Vercel
// deploys, adapting Node's req/res to the small subset of the Vercel API we use.
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

type ShimRes = ServerResponse & {
  status: (code: number) => ShimRes;
  json: (body: unknown) => ShimRes;
  send: (body: unknown) => ShimRes;
};

function resolveHandler(root: string, urlPath: string): { file: string; params: Record<string, string> } | null {
  const parts = urlPath.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const base = path.join(root, 'api');
  const direct = path.join(base, ...parts) + '.ts';
  if (fs.existsSync(direct)) return { file: direct, params: {} };
  const index = path.join(base, ...parts, 'index.ts');
  if (fs.existsSync(index)) return { file: index, params: {} };
  // One level of [param].ts dynamic routes, matching Vercel's convention.
  if (parts.length > 0) {
    const dir = path.join(base, ...parts.slice(0, -1));
    if (fs.existsSync(dir)) {
      const dyn = fs.readdirSync(dir).find((f) => /^\[.+\]\.ts$/.test(f));
      if (dyn) return { file: path.join(dir, dyn), params: { [dyn.slice(1, -4)]: parts[parts.length - 1] ?? '' } };
    }
  }
  return null;
}

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
        const match = resolveHandler(server.config.root, url.pathname);
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
        if (!match) return r.status(404).json({ error: 'not_found', message: `No API route for ${url.pathname}` });
        try {
          const mod = await server.ssrLoadModule(match.file);
          const query: Record<string, string> = { ...match.params };
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
