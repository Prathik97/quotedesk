import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, validateUpload } from './uploads';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('validateUpload', () => {
  it('accepts each allowed type', () => {
    for (const [filename, mime] of [
      ['rates.xlsx', XLSX],
      ['quote.PDF', 'application/pdf'],
      ['offer.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['card.png', 'image/png'],
      ['photo.jpg', 'image/jpeg'],
      ['photo.jpeg', 'image/jpeg'],
      ['reply.eml', 'message/rfc822'],
      ['reply.eml', 'application/octet-stream'],
      ['note.txt', 'text/plain'],
    ] as const) {
      expect(validateUpload({ filename, mime, size: 1000 }).ok, filename).toBe(true);
    }
  });

  it('rejects other types, including a double extension', () => {
    for (const filename of ['run.exe', 'page.html', 'macro.xlsm', 'a.pdf.exe', 'noextension', '.pdf.']) {
      expect(validateUpload({ filename, mime: 'application/pdf', size: 1000 }).ok, filename).toBe(false);
    }
  });

  it('enforces 10 MB and rejects empty files', () => {
    expect(validateUpload({ filename: 'a.pdf', mime: 'application/pdf', size: MAX_UPLOAD_BYTES }).ok).toBe(true);
    const big = validateUpload({ filename: 'a.pdf', mime: 'application/pdf', size: MAX_UPLOAD_BYTES + 1 });
    expect(big).toMatchObject({ ok: false });
    expect(validateUpload({ filename: 'a.pdf', mime: 'application/pdf', size: 0 }).ok).toBe(false);
  });

  it('rejects a name that does not match the declared type', () => {
    expect(validateUpload({ filename: 'a.pdf', mime: 'image/png', size: 10 }).ok).toBe(false);
    expect(validateUpload({ filename: 'a.png', mime: '', size: 10 }).ok).toBe(false);
  });

  it('returns a safe storage name', () => {
    const r = validateUpload({ filename: '../../etc/My rates (final).xlsx', mime: XLSX, size: 10 });
    expect(r).toMatchObject({ ok: true, storage_name: 'My_rates_final_.xlsx' });
  });
});
