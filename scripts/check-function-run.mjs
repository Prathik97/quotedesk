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

// Phase 6 routes, in no-model mode. A throwaway browser id drives a whole draft: new, save, template email,
// a blocked issue, issue, outbox, pack PDF, then discard. The inbox reveal is switched on and off again.
// The caps are 0 in this process, so the co-pilot route must refuse before any model code runs.
{
  const p = 'phase 6 routes (draft to issued RFx, outbox, inbox replay, co-pilot refusal)';
  const problems = [];
  const bid = `checkfunction${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const post = async (path, body) => {
    const r = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const get = async (path) => {
    const r = await fetch(`${base}/api/${path}`);
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? '' };
  };
  const json = (g) => { try { return JSON.parse(g.buf.toString('utf8')); } catch { return null; } };
  let draftId = null;
  try {
    // The five saved emails and the saved pack.
    const saved = json(await get('outbox'));
    if (saved?.saved?.emails?.length !== 5) problems.push(`saved outbox has ${saved?.saved?.emails?.length ?? 'no'} emails, expected 5`);
    else if (!saved.saved.emails.every((e) => e.source === 'saved' && e.status === 'sent (simulated)')) problems.push('saved emails are not labelled saved and simulated');
    const savedPack = await get('outbox?pack=saved');
    if (savedPack.status !== 200 || savedPack.buf.subarray(0, 5).toString('latin1') !== '%PDF-') problems.push('saved pack is not a PDF');

    // The co-pilot is refused before any model call.
    const cp = await post('copilot', { browser_id: bid, message: 'annual rate contract for corrugated cartons' });
    if (cp.status !== 429 || cp.json?.error !== 'capped') problems.push(`co-pilot with caps at 0 returned ${cp.status}, expected 429 capped`);

    // A draft, end to end, with no model.
    const created = await post('rfx-draft', { action: 'new', browser_id: bid });
    draftId = created.json?.draft?.id ?? null;
    if (!draftId) problems.push('could not create a draft');
    const rfx = {
      terms: { title: 'Check function RFx', scope_summary: 'A throwaway RFx made by npm run check:function.', delivery_location: 'Bengaluru plant', payment_terms_days: 45, validity_days: 90, gst_basis: 'excl_gst', currency: 'INR', clarifications_by_day: 5, quotes_due_day: 14, award_by_day: 30 },
      lines: [{ code: 'CAR-01', section: 'Cartons', description: '5 ply RSC carton 450x300x250 mm', spec: 'BF 22', uom: 'piece', pack_size: null, annual_qty: 1000 }],
      questions: [{ code: 'Q1', text: 'Do you hold a valid ISO 9001 certificate?', answer_type: 'bool', is_knockout: true, pass_rule: { op: 'eq', value: true } }],
    };
    if (draftId) {
      // Issue is blocked while an error remains.
      const bad = structuredClone(rfx);
      bad.terms.payment_terms_days = null;
      await post('rfx-draft', { action: 'save', browser_id: bid, draft_id: draftId, rfx: bad });
      const blocked = await post('rfx-draft', { action: 'issue', browser_id: bid, draft_id: draftId, subject: 'Subject', body: 'A body that is long enough to pass.' , source: 'template' });
      if (blocked.status !== 422) problems.push(`issue with an error returned ${blocked.status}, expected 422`);
      const saveOk = await post('rfx-draft', { action: 'save', browser_id: bid, draft_id: draftId, rfx });
      if (saveOk.status !== 200 || saveOk.json?.validation?.can_issue !== true) problems.push('a valid RFx did not save as issuable');
      const email = await post('rfx-draft', { action: 'email', browser_id: bid, draft_id: draftId, mode: 'template' });
      if (email.status !== 200 || email.json?.source !== 'template' || !String(email.json?.body ?? '').includes('{{vendor_name}}')) problems.push('template email failed');
      const issued = await post('rfx-draft', { action: 'issue', browser_id: bid, draft_id: draftId, subject: email.json?.subject ?? 'Subject', body: email.json?.body ?? '', source: 'template' });
      if (issued.status !== 200 || issued.json?.draft?.emails?.length !== 5) problems.push(`issue created ${issued.json?.draft?.emails?.length ?? 0} emails, expected 5`);
      else if (issued.json.draft.emails.some((e) => e.body.includes('{{vendor_name}}') || e.status !== 'sent (simulated)')) problems.push('issued emails are not personalised and simulated');
      const again = await post('rfx-draft', { action: 'issue', browser_id: bid, draft_id: draftId, subject: 'Subject', body: 'A body that is long enough to pass.', source: 'template' });
      if (again.status !== 409) problems.push(`a second issue returned ${again.status}, expected 409`);
      const box = json(await get(`outbox?browser_id=${bid}`));
      if (box?.drafts?.[0]?.emails?.length !== 5) problems.push('the outbox does not list the five draft emails');
      const pack = await get(`outbox?pack=${draftId}&browser_id=${bid}`);
      if (pack.status !== 200 || pack.buf.subarray(0, 5).toString('latin1') !== '%PDF-' || pack.buf.length < 2000) problems.push('draft pack is not a PDF');
      const other = await get(`outbox?pack=${draftId}&browser_id=${bid}zz`);
      if (other.status === 200) problems.push('another browser could download this pack');
    }

    // Inbox replay on, then off.
    const before = json(await get(`inbox?browser_id=${bid}`));
    if (before?.revealed !== false || before?.messages?.length !== 0) problems.push('the inbox was not hidden before Simulate');
    await post('inbox', { action: 'simulate', browser_id: bid });
    const on = json(await get(`inbox?browser_id=${bid}`));
    if (on?.revealed !== true || on?.messages?.length !== 5) problems.push(`inbox after Simulate shows ${on?.messages?.length ?? 0} replies, expected 5`);
    else if (JSON.stringify(on.messages.map((m) => m.arrival_day)) !== '[2,3,5,7,9]' && JSON.stringify(on.messages.map((m) => m.arrival_day).sort((a, b) => a - b)) !== '[2,3,5,7,9]') problems.push('arrival days are not 2, 3, 5, 7, 9');
  } catch (e) {
    problems.push(`threw ${e?.name ?? 'Error'}`);
  } finally {
    try {
      await post('inbox', { action: 'hide', browser_id: bid });
      if (draftId) await post('rfx-draft', { action: 'discard', browser_id: bid, draft_id: draftId });
      const gone = await get(`outbox?browser_id=${bid}`);
      if (json(gone)?.drafts?.length) problems.push('the check draft was not cleaned up');
    } catch {
      problems.push('cleanup failed');
    }
  }
  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${p}${ok ? '' : ` -> ${problems.join('; ')}`}`);
}
server.close();
// pg pools keep the process alive otherwise.
process.exit(failed ? 1 : 0);
