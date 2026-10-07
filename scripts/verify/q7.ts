import ExcelJS from 'exceljs';
import fs from 'node:fs';
import { cells, inr, pool } from './common.js';

const j = JSON.parse(fs.readFileSync(process.argv[2] as string, 'utf8'));
const chip = j.exports[0];
console.log('Export chip:', chip.filename, chip.rows, 'rows', chip.url);
const res = await fetch(`http://localhost:5173${chip.url}`);
console.log('HTTP', res.status, res.headers.get('content-type'), res.headers.get('content-disposition'));
const buf = Buffer.from(await res.arrayBuffer());
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf as never);
console.log('Sheets:', wb.worksheets.map((w) => `${w.name} (${w.rowCount} rows)`).join(', '));
const about = wb.getWorksheet('About')!;
about.eachRow((r, n) => { if (n <= 6) console.log('  About:', String(r.getCell(1).value).slice(0, 160)); });
const ws = wb.worksheets[1]!;
const header = (ws.getRow(1).values as unknown[]).slice(1);
console.log('Columns:', header.join(' | '));
const rows: Record<string, unknown>[] = [];
ws.eachRow((r, n) => { if (n > 1) rows.push(Object.fromEntries(header.map((h, i) => [String(h), r.getCell(i + 1).value]))); });
const cellRows = rows.filter((r) => r['Status'] === 'Assumed');
console.log(`Exported rows ${rows.length}; Assumed cell rows ${cellRows.length}`);
// Independent: assumed cells from the tables at annual quantity
const all = await cells();
const indep = all.filter((c) => c.status === 'assumed' && c.price != null).map((c) => ({ key: `${c.vendor} ${c.line}`, v: (c.price as number) * c.qty })).sort((a, b) => b.v - a.v);
console.log(`Independent assumed cells: ${indep.length}, total ${inr(indep.reduce((s, x) => s + x.v, 0))}`);
let mismatches = 0;
cellRows.forEach((r, i) => {
  const x = indep[i]!;
  const rv = Number(r['Rupees at stake']);
  if (`${r['Vendor']} ${r['Line']}` !== x.key || Math.abs(rv - x.v) > 0.01) { mismatches++; console.log('  MISMATCH at', i, r['Vendor'], r['Line'], rv, 'vs', x.key, x.v); }
});
console.log(`Order and value mismatches among Assumed cell rows: ${mismatches}`);
const sorted = rows.every((r, i) => i === 0 || Number(rows[i - 1]!['Rupees at stake']) >= Number(r['Rupees at stake']));
console.log('Whole sheet sorted by rupees at stake descending:', sorted);
await pool.end();
