// GET /api/documents?vendor_id=X lists a vendor's documents with signed URLs.
// GET /api/documents?id=X returns one document with a preview and the lines read from it.
import { z } from 'zod';
import { storedRun } from './_lib/compare/data.js';
import { loadDocuments, loadExtractedLines } from './_lib/compare/docs.js';
import { documentPreview } from './_lib/compare/source.js';
import { db } from './_lib/db.js';
import { ApiError, route } from './_lib/http.js';

const Query = z.object({ vendor_id: z.string().uuid().optional(), id: z.string().uuid().optional() });

export default route(['GET'], async (req) => {
  const q = Query.safeParse(req.query);
  if (!q.success || (!q.data.vendor_id && !q.data.id)) throw new ApiError(400, 'bad_request', 'Pass vendor_id or id.');
  const pool = db();
  const docs = await loadDocuments(pool, q.data);
  const usage = (await pool.query(`select max(created_at) as mx, count(*) as n from usage_log where not cache_hit and stage = 'extract'`)).rows[0];
  const stored = storedRun(usage);
  if (q.data.id) {
    const doc = docs[0];
    if (!doc) throw new ApiError(404, 'not_found', 'That document does not exist. Reload the page.');
    const [preview, extracted] = await Promise.all([
      documentPreview({ id: doc.id, filename: doc.filename, mime: doc.mime, storage_path: doc.storage_path, message: doc.message }).catch((e: Error) => ({ kind: 'lines' as const, lines: [{ label: '', text: `The stored file could not be read (${e.message}).` }] })),
      loadExtractedLines(pool, doc.id),
    ]);
    const { storage_path: _p, message: _m, ...document } = doc;
    void _p;
    void _m;
    return { stored, document, preview, extracted };
  }
  return { stored, documents: docs.map(({ storage_path: _p, message: _m, ...d }) => d) };
});
