// Upload rules (FR-3.3): xlsx, pdf, docx, png, jpg, eml and txt, at most 10 MB.
// No route accepts a file yet. The upload route (phase 6) must call validateUpload before it
// issues a Supabase Storage signed upload URL, so the file goes straight to Storage and never
// through a function (Vercel caps a request body at about 4.5 MB).
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

export function validateUpload(f: { filename: string; mime: string; size: number }): UploadCheck {
  const name = f.filename.split(/[\\/]/).pop() ?? '';
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  const allowedMimes = ALLOWED[ext];
  if (!allowedMimes) return { ok: false, message: `This file type is not accepted. Upload ${ACCEPTED_TEXT}.` };
  if (!Number.isFinite(f.size) || f.size <= 0) return { ok: false, message: 'The file is empty.' };
  if (f.size > MAX_UPLOAD_BYTES) return { ok: false, message: `The file is ${(f.size / 1048576).toFixed(1)} MB. The limit is 10 MB.` };
  if (!allowedMimes.includes(f.mime)) return { ok: false, message: `The file says it is ${f.mime || 'of unknown type'}, which does not match its .${ext} name. Upload ${ACCEPTED_TEXT}.` };
  // A safe storage name: no path, no spaces or odd characters, never longer than needed.
  const base = name.slice(0, name.length - ext.length - 1).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
  return { ok: true, ext, mime: f.mime, storage_name: `${base}.${ext}` };
}
