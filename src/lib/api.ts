// Small fetch wrapper. Errors carry the server's plain message, never a stack trace.
export class ApiFailure extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiFailure('The server could not be reached. Check that it is running, then try again.', 'network', 0);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // fall through to the generic message
  }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; message?: string };
    throw new ApiFailure(e.message ?? 'Something went wrong on the server. Try again.', e.error ?? 'internal', res.status);
  }
  return json as T;
}
