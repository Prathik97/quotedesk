// Runs in PLAIN Node (no tsx, no Vite, no TypeScript loader). Loads the built function, serves it on
// a local port through a minimal req/res adapter, and calls the routes. Prints route, status and
// the names of failing layers only, never a value. Env comes from the parent process.
import http from 'node:http';

const { default: handler } = await import(new URL('../.build/handler.mjs', import.meta.url));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(b)), res);
  res.send = (b) => (res.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b)), res);
  const query = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  Object.assign(req, { query, body: undefined, cookies: {} });
  await handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
for (const p of ['/api/health', '/api/ready', '/api/usage', '/api/compare']) {
  let status = 0;
  let note = '';
  try {
    const r = await fetch(base + p);
    status = r.status;
    const body = await r.json().catch(() => null);
    if (status !== 200 && body && typeof body === 'object') {
      if (Array.isArray(body.failed)) note = ` failing layers: ${body.failed.join(', ')}`;
      if (Array.isArray(body.missing_settings) && body.missing_settings.length) note += ` missing settings: ${body.missing_settings.join(', ')}`;
      if (typeof body.error === 'string') note += ` error code: ${body.error}`;
    }
  } catch (e) {
    note = ` request threw ${e?.name ?? 'Error'}`;
  }
  const ok = status === 200;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} GET ${p} -> ${status}${note}`);
}
server.close();
// pg pools keep the process alive otherwise.
process.exit(failed ? 1 : 0);
