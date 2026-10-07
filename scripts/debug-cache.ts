// Dev tool, no API calls: re-validate stored model replies for a document.
// npm run debug:cache -- <file name fragment>
import pg from 'pg';
import { pgConfig } from '../api/_lib/pgconfig.js';
import { ExtractionSchema, parseJsonLoose, zodErrors } from '../src/lib/schemas/extraction.js';
import { loadEnvLocal, requireEnv } from './envfile.js';

async function main(): Promise<void> {
  loadEnvLocal();
  const frag = process.argv[2] ?? '';
  const c = new pg.Client(pgConfig(requireEnv('SUPABASE_DB_URL')));
  await c.connect();
  const r = await c.query<{ stage: string; prompt_version: string; response_text: string; created_at: Date }>(
    `select k.stage, k.prompt_version, k.response_text, k.created_at from llm_cache k
     where k.document_sha256 in (select sha256 from documents where filename ilike $1) and k.stage in ('extract','repair')
     order by k.created_at`, [`%${frag}%`]);
  for (const row of r.rows) {
    let verdict = 'valid';
    try {
      const p = ExtractionSchema.safeParse(parseJsonLoose(row.response_text));
      if (!p.success) verdict = `INVALID\n${zodErrors(p.error)}`;
    } catch (e) {
      verdict = `NOT JSON: ${(e as Error).message}`;
    }
    console.log(`${row.created_at.toISOString()} ${row.stage} ${row.prompt_version} (${row.response_text.length} chars): ${verdict}`);
  }
  await c.end();
}

void main();
