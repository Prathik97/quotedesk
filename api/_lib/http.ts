import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (req: VercelRequest, res: VercelResponse, ctx: { requestId: string }) => Promise<unknown>;

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  // Structured, one line per event. Callers must not pass document contents or secrets.
  console[level](JSON.stringify({ level, msg, ts: new Date().toISOString(), ...fields }));
}

/** Wraps a route: request id, method check, friendly errors, no stack traces to clients. */
export function route(methods: string[], handler: Handler) {
  return async (req: VercelRequest, res: VercelResponse) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    const started = Date.now();
    try {
      if (!methods.includes(req.method ?? 'GET')) {
        throw new ApiError(405, 'method_not_allowed', `Use ${methods.join(' or ')} for this endpoint.`);
      }
      const out = await handler(req, res, { requestId });
      if (!res.headersSent) res.status(200).json(out ?? { ok: true });
      log('info', 'request', { requestId, path: req.url, ms: Date.now() - started });
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      log(e ? 'warn' : 'error', 'request_failed', {
        requestId,
        path: req.url,
        code: e?.code ?? 'internal',
        message: (err as Error).message,
      });
      if (!res.headersSent) {
        res.status(e?.status ?? 500).json({
          error: e?.code ?? 'internal',
          message: e?.message ?? 'Something went wrong on the server. Try again, and if it repeats, reset the demo.',
          requestId,
        });
      }
    }
  };
}

export function notImplemented(feature: string) {
  return route(['GET', 'POST'], async () => {
    throw new ApiError(501, 'not_implemented', `${feature} arrives in a later phase.`);
  });
}
