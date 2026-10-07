// Temporarily marks one cell Needs review (low read confidence) to exercise the analyst's "unresolved cell changes
// the answer" behaviour on live data, then restores it exactly. Usage: unresolved-toggle.ts on|off <state-file>
import fs from 'node:fs';
import { pool } from './common.js';

const [mode, file] = [process.argv[2], process.argv[3] as string];
const VENDOR = 'V1';
const LINE = 'CRT-5P-02';
if (mode === 'on') {
  const r = await pool.query(`select q.id, q.status, q.conversion, q.confidence from quote_lines q join vendors v on v.id=q.vendor_id join rfx_lines l on l.id=q.rfx_line_id where v.vendor_key=$1 and l.code=$2 and q.status<>'rejected'`, [VENDOR, LINE]);
  const row = r.rows[0];
  fs.writeFileSync(file, JSON.stringify(row));
  await pool.query(`update quote_lines set status='needs_review', conversion = jsonb_set(coalesce(conversion,'{}'::jsonb), '{read_confidence}', '"low"') where id=$1`, [row.id]);
  console.log(`marked ${VENDOR} ${LINE} Needs review (was ${row.status})`);
} else {
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  await pool.query('update quote_lines set status=$2, conversion=$3 where id=$1', [row.id, row.status, row.conversion == null ? null : JSON.stringify(row.conversion)]);
  const chk = await pool.query('select status, conversion from quote_lines where id=$1', [row.id]);
  console.log(`restored ${VENDOR} ${LINE} to ${chk.rows[0].status}; conversion identical: ${JSON.stringify(chk.rows[0].conversion) === JSON.stringify(row.conversion)}`);
}
await pool.end();
