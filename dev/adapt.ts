// Adapts Node's req/res to the small subset of the Vercel API that our handlers use
// (status, json, send, query, body). Shared by the dev shim and the local production server.
import type { IncomingMessage, ServerResponse } from 'node:http';

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

export async function callHandler(
  handler: (req: never, res: never) => Promise<unknown>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
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
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  Object.assign(req, { query, body: await readBody(req), cookies: {} });
  await handler(req as never, r as never);
}
