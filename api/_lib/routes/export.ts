// GET /api/export?session=X&result=rN&format=xlsx|csv  builds the download from a stored analyst result.
import { z } from 'zod';
import { toCsv, toXlsx } from '../analyst/exports.js';
import { loadResults } from '../analyst/session.js';
import { db } from '../db.js';
import { ApiError, route } from '../http.js';

const Q = z.object({ session: z.string().uuid(), result: z.string().min(1).max(20), format: z.enum(['xlsx', 'csv']) });

export default route(['GET'], async (req, res) => {
  const q = Q.safeParse(req.query);
  if (!q.success) throw new ApiError(400, 'bad_request', 'Pass session, result and format (xlsx or csv).');
  const results = await loadResults(db(), q.data.session);
  const r = results.get(q.data.result);
  if (!r) throw new ApiError(404, 'not_found', 'That result is not stored. Ask the analyst again and export the new answer.');
  const name = (r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export').slice(0, 50);
  if (q.data.format === 'csv') {
    const t = r.tables[0];
    if (!t) throw new ApiError(404, 'not_found', 'That result has no table to export.');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${name}.csv"`);
    res.status(200).send(toCsv(t));
    return undefined;
  }
  const buf = await toXlsx(r);
  res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('content-disposition', `attachment; filename="${name}.xlsx"`);
  res.status(200).send(buf);
  return undefined;
});
