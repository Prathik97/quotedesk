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
  // Vercel parses a JSON body before the function runs; do the same for POST.
  let body;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
  }
  Object.assign(req, { query, body, cookies: {} });
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
// The decision pack route, in template mode: builds the memo PDF and the xlsx appendix in plain Node and
// makes no model call (the note comes from fixed rules). Checks the files are real and nothing is hidden.
{
  const p = 'POST /api/decision (template note)';
  let status = 0;
  let note = '';
  try {
    const r = await fetch(`${base}/api/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'cheapest_per_line', include_pending: false, apply_discounts: false, price_basis: 'confirmed_assumed', note_mode: 'template', regenerate: false }),
    });
    status = r.status;
    const j = await r.json().catch(() => null);
    if (status === 200 && j) {
      const memo = Buffer.from(j.files?.memo?.base64 ?? '', 'base64');
      const xlsx = Buffer.from(j.files?.appendix?.base64 ?? '', 'base64');
      const problems = [];
      if (memo.subarray(0, 5).toString('latin1') !== '%PDF-') problems.push('memo is not a PDF');
      if (memo.length < 10_000) problems.push('memo is too small');
      if (xlsx.subarray(0, 2).toString('latin1') !== 'PK') problems.push('appendix is not an xlsx');
      if (j.note?.source !== 'template') problems.push('note was not a template');
      if (j.needs_choice) problems.push('needs_choice is set');
      if (!/^QuoteDesk_Decision_Memo_.+\.pdf$/.test(j.files?.memo?.filename ?? '')) problems.push('memo file name');
      if (problems.length) {
        status = 500;
        note = ` ${problems.join('; ')}`;
      } else note = ` memo ${memo.length} bytes, appendix ${xlsx.length} bytes`;
    } else if (j && typeof j.error === 'string') note = ` error code: ${j.error}`;
  } catch (e) {
    note = ` request threw ${e?.name ?? 'Error'}`;
  }
  const ok = status === 200;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${p} -> ${status}${note}`);
}
server.close();
// pg pools keep the process alive otherwise.
process.exit(failed ? 1 : 0);
