// Serves the production build the way Vercel does, on this machine: files from dist/ with the
// same SPA fallback as vercel.json, and /api/* through the single catch-all function.
// Usage: npm run build && npm run serve:prod [-- --port 4173]
// Set the caps for a test with environment variables, for example:
//   DAILY_SPEND_CAP_INR=0 PER_IP_HOURLY_CALLS=0 npm run serve:prod
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import handler from '../api/[[...path]].js';
import { callHandler } from '../dev/adapt.js';
import { loadEnvLocal, requireEnv } from './envfile.js';

// Variables already in the environment win over .env.local (dotenv does not overwrite).
loadEnvLocal();
requireEnv('SUPABASE_DB_URL');

const DIST = path.resolve('dist');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 4173;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        await callHandler(handler as never, req, res);
        return;
      }
      const file = path.join(DIST, path.normalize(url.pathname));
      const inside = file.startsWith(DIST + path.sep);
      const exists = inside && fs.existsSync(file) && fs.statSync(file).isFile();
      // Same rule as the rewrite in vercel.json: anything that is not a file and not /api is index.html.
      const send = exists ? file : path.join(DIST, 'index.html');
      res.statusCode = 200;
      res.setHeader('content-type', TYPES[path.extname(send)] ?? 'application/octet-stream');
      fs.createReadStream(send).pipe(res);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'internal', message: 'Something went wrong on the server.' }));
      }
    }
  })
  .listen(port, () => console.log(`Production build on http://localhost:${port} (caps: daily Rs ${process.env.DAILY_SPEND_CAP_INR}, per IP ${process.env.PER_IP_HOURLY_CALLS} per hour)`));
