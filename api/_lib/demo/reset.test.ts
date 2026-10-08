// What Reset demo deletes and keeps for the Phase 6 tables. A fake client records the SQL: no database is used.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../compare/recompute.js', () => ({ recompute: async () => ({ changed: [] }) }));

import { resetDemo } from './reset.js';

function fakePool(counts: Record<string, number> = {}) {
  const sql: string[] = [];
  const client = {
    query: async (q: string) => {
      const s = q.replace(/\s+/g, ' ').trim();
      sql.push(s);
      const key = Object.keys(counts).find((k) => s.startsWith(k));
      return { rows: [], rowCount: key ? counts[key] : 0 };
    },
    release: () => undefined,
  };
  return { sql, pool: { connect: async () => client, query: client.query } as never };
}

describe('resetDemo and the co-pilot, outbox, inbox and sandbox rows', () => {
  it('deletes drafts, issued emails, inbox reveals and sandbox results, and reports how many', async () => {
    const { sql, pool } = fakePool({ 'delete from rfx_drafts': 3, 'delete from outbox_emails': 15, 'delete from inbox_reveals': 2, 'delete from sandbox_results': 4 });
    const out = await resetDemo(pool);
    expect(sql).toContain('delete from rfx_drafts');
    expect(sql).toContain('delete from outbox_emails where not is_saved');
    expect(sql).toContain('delete from inbox_reveals');
    expect(sql).toContain('delete from sandbox_results');
    expect(out).toMatchObject({ drafts_cleared: 3, outbox_cleared: 15, inbox_reveals_cleared: 2, sandbox_cleared: 4 });
  });

  it('keeps the five saved FY27 emails and never writes to the seeded RFx or extraction tables', async () => {
    const { sql, pool } = fakePool();
    await resetDemo(pool);
    const writes = sql.filter((s) => /^(delete|update|insert)/i.test(s));
    // Every outbox delete is restricted to rows that are not saved.
    expect(writes.filter((s) => /outbox_emails/.test(s))).toEqual(['delete from outbox_emails where not is_saved']);
    // The only tables reset touches: buyer overlays, assumptions, review state, chats, request log and the Phase 6 tables.
    const touched = new Set(writes.map((s) => /^(?:delete from|update|insert into)\s+(\w+)/i.exec(s)?.[1]));
    for (const never of ['rfx', 'rfx_lines', 'vendors', 'vendor_messages', 'documents', 'extractions', 'questionnaire_questions', 'questionnaire_answers', 'vendor_terms']) {
      expect(touched.has(never)).toBe(false);
    }
    // quote_lines is only touched to clear buyer overrides, never deleted.
    expect(writes.filter((s) => /quote_lines/.test(s)).every((s) => /^update quote_lines set overrides/.test(s))).toBe(true);
  });

  it('clears the Phase 6 rows inside the same transaction as the rest of the reset', async () => {
    const { sql, pool } = fakePool();
    await resetDemo(pool);
    const begin = sql.indexOf('begin');
    const commit = sql.indexOf('commit');
    for (const t of ['delete from rfx_drafts', 'delete from inbox_reveals', 'delete from sandbox_results']) {
      const i = sql.indexOf(t);
      expect(i).toBeGreaterThan(begin);
      expect(i).toBeLessThan(commit);
    }
  });
});
