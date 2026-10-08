import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DailyCapError } from '../llm/call';

const order: string[] = [];

vi.mock('./model', () => ({
  loadPrompt: () => ({ version: 'extract.v3@test' }),
  classify: async () => ({ ok: true, data: { kind: 'quote', confidence: 0.95, reason: 'test' }, calls: [], repaired: false, raw: '' }),
  extract: vi.fn(),
  certificateFacts: vi.fn(),
}));
vi.mock('./persist', async (orig) => ({
  ...(await orig<typeof import('./persist')>()),
  persistObservations: async () => undefined,
  persistExtraction: async () => ({ lines: 0, statuses: {} }),
  persistCertificate: async () => undefined,
}));
vi.mock('./reconcile', () => ({ reconcileVendor: async () => undefined }));

import { extract } from './model';
import { processDocument } from './pipeline';

const DOC = { id: 'd1', vendor_id: 'v1', vendor_name: 'Vendor', rfx_id: 'r1', filename: 'reply.txt', mime: 'text/plain', storage_path: 'message:m1', sha256: 'abc', message_from: 'a@b.c', message_subject: 's', message_body: 'Price 10', received_at: null };

function fakePool() {
  const run = (sql: string) => {
    order.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
    if (/from documents d join vendors/.test(sql)) return { rows: [DOC], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query: async (sql: string) => run(sql), release: () => undefined };
  return { query: async (sql: string) => run(sql), connect: async () => client } as never;
}

const opts = (pool: never) => ({ deps: { client: {} as never, store: {} as never }, pool, fresh: false, run_id: null, session_id: 's', route: 'test' });
const writes = () => order.filter((q) => /^(delete|update|insert|begin|commit)/i.test(q));

describe('processDocument leaves stored results alone until the model has answered', () => {
  beforeEach(() => {
    order.length = 0;
    vi.mocked(extract).mockReset();
  });

  it('a spend cap hit during extraction writes nothing at all', async () => {
    vi.mocked(extract).mockRejectedValue(new DailyCapError(500, 5, 500));
    await expect(processDocument('d1', opts(fakePool()))).rejects.toBeInstanceOf(DailyCapError);
    expect(writes()).toEqual([]);
  });

  it('an outage during extraction writes nothing but the failure note on the document', async () => {
    vi.mocked(extract).mockRejectedValue(new Error('connection reset'));
    const res = await processDocument('d1', opts(fakePool()));
    expect(res.ok).toBe(false);
    expect(writes().filter((q) => /delete/i.test(q))).toEqual([]);
    expect(writes().filter((q) => /^update documents set status = 'failed'/i.test(q)).length).toBe(1);
  });

  it('clears the old rows only after the model returned', async () => {
    vi.mocked(extract).mockImplementation(async () => {
      order.push('MODEL extract');
      return { ok: true, data: {} as never, calls: [], repaired: false, raw: '' };
    });
    await processDocument('d1', opts(fakePool()));
    const model = order.indexOf('MODEL extract');
    const firstDelete = order.findIndex((q) => /^delete from review_items/i.test(q));
    expect(model).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(model);
  });
});
