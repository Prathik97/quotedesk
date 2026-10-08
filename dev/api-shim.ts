// Local dev only: serves /api/* by loading the same catch-all function Vercel
// deploys (api/[[...path]].ts), through the shared req/res adapter.
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { callHandler } from './adapt';

export function apiShim(): Plugin {
  return {
    name: 'quotedesk-api-shim',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api')) return next();
        const file = path.join(server.config.root, 'api', '[[...path]].ts');
        try {
          const mod = await server.ssrLoadModule(file);
          await callHandler(mod.default, req, res);
        } catch (err) {
          server.config.logger.error(`[api-shim] ${req.url}: ${(err as Error).message}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'internal', message: 'Something went wrong on the server.' }));
          }
        }
      });
    },
  };
}
