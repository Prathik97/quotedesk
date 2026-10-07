// Brings the seeded vendor replies into vendor_messages and documents, the same
// rows the "Simulate vendor replies" control will create. Idempotent by sha256.
// Message bodies become documents too (they can carry prices or answers), except
// when the reply already includes the email itself as an .eml attachment.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';

type SeedMessage = {
  vendor_key: string;
  subject: string;
  body_text: string;
  arrival_day: number;
  received_on: string;
  attachments: { path: string; sha256: string }[];
};

const MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.eml': 'message/rfc822',
};

export function storageKey(rel: string): string {
  return `seed/${rel.replace(/[^A-Za-z0-9._/-]/g, '_')}`;
}

export async function ingestSeed(pool: pg.Pool, outDir = path.resolve('seed/out')): Promise<{ documents: string[] }> {
  const messages = JSON.parse(fs.readFileSync(path.join(outDir, 'messages.json'), 'utf8')) as SeedMessage[];
  const ids: string[] = [];
  for (const m of messages) {
    const v = (await pool.query<{ id: string }>(`select v.id from vendors v join rfx r on r.id = v.rfx_id and r.is_saved_demo where v.vendor_key = $1`, [m.vendor_key])).rows[0];
    if (!v) throw new Error(`Vendor ${m.vendor_key} not seeded. Run npm run seed:db first.`);
    let msg = (await pool.query<{ id: string }>('select id from vendor_messages where vendor_id = $1 and subject = $2', [v.id, m.subject])).rows[0];
    if (!msg) {
      msg = (await pool.query<{ id: string }>(
        `insert into vendor_messages (vendor_id, received_at, subject, body_text, arrival_day) values ($1, $2::date + time '10:00', $3, $4, $5) returning id`,
        [v.id, m.received_on, m.subject, m.body_text, m.arrival_day])).rows[0];
    }
    if (!msg) throw new Error('Message insert failed.');
    const files = m.attachments.map((a) => ({
      filename: path.basename(a.path), mime: MIME[path.extname(a.path).toLowerCase()] ?? 'application/octet-stream',
      storage_path: storageKey(a.path), sha256: a.sha256, size: fs.statSync(path.join(outDir, a.path)).size,
    }));
    if (!files.some((f) => f.mime === 'message/rfc822')) {
      files.unshift({
        filename: 'Email message body', mime: 'text/plain', storage_path: `message:${msg.id}`,
        sha256: createHash('sha256').update(m.body_text).digest('hex'), size: Buffer.byteLength(m.body_text),
      });
    }
    for (const f of files) {
      const r = await pool.query<{ id: string }>(
        `insert into documents (vendor_id, message_id, filename, mime, size_bytes, storage_path, sha256)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (vendor_id, sha256) do update set message_id = excluded.message_id returning id`,
        [v.id, msg.id, f.filename, f.mime, f.size, f.storage_path, f.sha256]);
      if (r.rows[0]) ids.push(r.rows[0].id);
    }
  }
  return { documents: ids };
}
