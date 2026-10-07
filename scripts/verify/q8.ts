import fs from 'node:fs';
import { cells, pool } from './common.js';

const j = JSON.parse(fs.readFileSync(process.argv[2] as string, 'utf8'));
const body: string = j.final.body;
const note = body.split('**Draft approval note**')[1]!.split('Before a PO goes out')[0]!.trim();
console.log(`Approval note word count: ${note.split(/\s+/).filter(Boolean).length} (limit 150)`);
const all = await cells();
const v5 = all.filter((c) => c.vendor === 'V5');
console.log(`V5 cells: confirmed ${v5.filter((c) => c.status === 'confirmed').length}, assumed ${v5.filter((c) => c.status === 'assumed').length}  -> the claim "every cell the V4 and V5 quotes would rely on is Assumed" is ${v5.some((c) => c.status === 'confirmed') ? 'NOT strictly true for V5' : 'true'}`);
const r = await pool.query(`select v.vendor_key, i.kind from review_items i join vendors v on v.id=i.vendor_id where i.state='open' and v.vendor_key in ('V2','V3') order by 1,2`);
console.log('Open items on V2 and V3:', r.rows.map((x) => `${x.vendor_key}:${x.kind}`).join(', '));
await pool.end();
