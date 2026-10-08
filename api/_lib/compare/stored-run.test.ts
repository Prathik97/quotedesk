// G3: the "Stored results from a live run on <date>, <n> live calls" label describes only the extractions behind the
// stored comparison. A Try your file read logs an extract call too and must never move the label.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { storedRun } from './data.js';
import { STORED_RUN_ROW_SQL, STORED_RUN_USAGE_SQL } from './stored-run.js';

describe('stored run label', () => {
  it('counts only extract calls whose document is one of the stored documents, and never a sandbox route', () => {
    for (const sql of [STORED_RUN_ROW_SQL, STORED_RUN_USAGE_SQL]) {
      expect(sql).toContain("u.stage = 'extract'");
      expect(sql).toContain('not u.cache_hit');
      expect(sql).toContain('exists (select 1 from documents d where d.id = u.document_id)');
      expect(sql).toContain("u.route not like '%sandbox%'");
    }
  });
  it('every route that prints the label uses the one definition, none has its own copy of the count', () => {
    const files = ['compare/data.ts', 'routes/documents.ts', 'routes/evidence.ts', 'routes/inbox.ts', 'routes/review.ts', 'routes/rfx.ts'];
    for (const f of files) {
      const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      expect(text, f).not.toMatch(/from usage_log where not cache_hit/);
      expect(text, f).toMatch(/STORED_RUN_(USAGE|ROW)_SQL/);
    }
    const all = readdirSync(new URL('../routes/', import.meta.url)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of all) expect(readFileSync(new URL(`../routes/${f}`, import.meta.url), 'utf8'), f).not.toMatch(/stage = 'extract'/);
  });
  it('the label text reads the date and the call count it is given', () => {
    expect(storedRun({ mx: '2026-10-07T17:02:25.489Z', n: '24' })).toMatchObject({ date: '7 Oct 2026', live_calls: 24, label: 'Stored results from a live run on 7 Oct 2026' });
  });
});
