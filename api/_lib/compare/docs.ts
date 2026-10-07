// Documents for the inbox, attachments and source view, with signed URLs.
import type pg from 'pg';
import type { CellStatus, DocumentRow } from '../../../src/lib/api-types.js';
import { toCellStatus } from '../../../engine/certainty.js';
import { signedUrls } from './storage.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type DocRecord = DocumentRow & {
  storage_path: string;
  message: { from: string | null; subject: string | null; received: string | null; body: string | null } | null;
};

export async function loadDocuments(pool: pg.Pool, where: { vendor_id?: string; id?: string } = {}): Promise<DocRecord[]> {
  const r = await pool.query<Json>(
    `select d.id, d.vendor_id, d.filename, d.mime, d.kind, d.kind_confidence::float8 as kind_confidence, d.status, d.error, d.size_bytes, d.flags, d.facts, d.storage_path,
            (select count(*) from quote_lines q where q.source_document_id = d.id)::int as lines,
            v.contact_email as m_from, m.subject as m_subject, m.received_at::text as m_received, m.body_text as m_body
     from documents d join vendors v on v.id = d.vendor_id left join vendor_messages m on m.id = d.message_id
     where ($1::uuid is null or d.vendor_id = $1) and ($2::uuid is null or d.id = $2)
     order by v.vendor_key, d.created_at`,
    [where.vendor_id ?? null, where.id ?? null],
  );
  const urls = await signedUrls(r.rows.map((x) => x.storage_path as string));
  return r.rows.map((x) => ({
    id: x.id,
    vendor_id: x.vendor_id,
    filename: x.filename,
    mime: x.mime,
    kind: x.kind ?? null,
    kind_confidence: x.kind_confidence ?? null,
    status: x.status,
    error: x.error ?? null,
    size_bytes: x.size_bytes ?? null,
    is_message_body: String(x.storage_path).startsWith('message:'),
    signed_url: urls.get(x.storage_path) ?? null,
    flags: x.flags ?? [],
    facts: x.facts ?? null,
    lines: Number(x.lines ?? 0),
    storage_path: x.storage_path,
    message: { from: x.m_from ?? null, subject: x.m_subject ?? null, received: x.m_received ?? null, body: x.m_body ?? null },
  }));
}

export type ExtractedLine = {
  quote_line_id: string;
  code: string | null;
  vendor_description: string | null;
  quoted: string;
  price: number | null;
  status: CellStatus;
  locator: string | null;
  region: { x: number; y: number; w: number; h: number } | null;
  page: number | null;
};

export async function loadExtractedLines(pool: pg.Pool, documentId: string): Promise<ExtractedLine[]> {
  const r = await pool.query<Json>(
    `select q.id, l.code, q.vendor_description, q.quoted_price::float8 as quoted_price, q.quoted_uom_text, q.quoted_currency, q.price_basis,
            q.normalized_price_inr::float8 as price, q.status, q.evidence, l.sort
     from quote_lines q left join rfx_lines l on l.id = q.rfx_line_id where q.source_document_id = $1 order by l.sort nulls last, q.created_at`,
    [documentId],
  );
  return r.rows.map((x) => ({
    quote_line_id: x.id,
    code: x.code ?? null,
    vendor_description: x.vendor_description ?? null,
    quoted:
      x.price_basis?.inherits_last_year === true
        ? 'Same as last year'
        : `${x.quoted_currency && x.quoted_currency !== 'INR' ? `${x.quoted_currency} ` : ''}${x.quoted_price ?? ''} ${x.quoted_uom_text ?? ''}`.trim(),
    price: x.price ?? null,
    status: x.status === 'rejected' ? 'missing' : toCellStatus(x.status),
    locator: x.evidence?.locator ?? null,
    region: x.evidence?.region ?? null,
    page: x.evidence?.page ?? null,
  }));
}
