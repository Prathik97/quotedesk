// Upload rules (FR-3.3): xlsx, pdf, docx, png, jpg, eml and txt, at most 10 MB.
// The only route that accepts a file is Try your file (api/_lib/routes/sandbox.ts): it validates here with a
// 4 MB limit so the file fits through a function (Vercel caps a request body at about 4.5 MB), reads it in
// memory and never stores it. A future upload into the real inbox would use a Supabase Storage signed URL.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ALLOWED: Record<string, string[]> = {
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  eml: ['message/rfc822', 'application/octet-stream'],
  txt: ['text/plain'],
};

export const ACCEPTED_TEXT = 'xlsx, pdf, docx, png, jpg, eml or txt, up to 10 MB';

export type UploadCheck = { ok: true; ext: string; mime: string; storage_name: string } | { ok: false; message: string };

/** The Try your file route passes its own, smaller limit: a function request body is capped at about 4.5 MB. */
export function validateUpload(f: { filename: string; mime: string; size: number }, maxBytes: number = MAX_UPLOAD_BYTES): UploadCheck {
  const name = f.filename.split(/[\\/]/).pop() ?? '';
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  const allowedMimes = ALLOWED[ext];
  if (!allowedMimes) return { ok: false, message: `This file type is not accepted. Upload ${ACCEPTED_TEXT}.` };
  if (!Number.isFinite(f.size) || f.size <= 0) return { ok: false, message: 'The file is empty.' };
  if (f.size > maxBytes) return { ok: false, message: `The file is ${(f.size / 1048576).toFixed(1)} MB. The limit is ${Math.round(maxBytes / 1048576)} MB.` };
  if (!allowedMimes.includes(f.mime)) return { ok: false, message: `The file says it is ${f.mime || 'of unknown type'}, which does not match its .${ext} name. Upload ${ACCEPTED_TEXT}.` };
  // A safe storage name: no path, no spaces or odd characters, never longer than needed.
  const base = name.slice(0, name.length - ext.length - 1).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
  return { ok: true, ext, mime: f.mime, storage_name: `${base}.${ext}` };
}
