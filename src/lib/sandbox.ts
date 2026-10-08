// Client side for Try your file: one raw upload, 4 MB at most, never stored as a file.
import type { SandboxResult } from '../../api/_lib/sandbox/run';
import { browserId } from './browser';

export type { SandboxResult };
export type SandboxResponse = { label: string; result: SandboxResult | null; expires_at?: string | null; uploads_left: number; uploads_per_hour: number; max_mb: number };

export const MAX_MB = 4;
export const ACCEPT = '.xlsx,.pdf,.docx,.png,.jpg,.jpeg,.eml,.txt';

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', eml: 'message/rfc822', txt: 'text/plain',
};

export class SandboxRefusal extends Error {
  constructor(message: string, public readonly status: number, public readonly uploadsLeft: number | null) {
    super(message);
  }
}

export async function uploadFile(file: File): Promise<SandboxResponse> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const res = await fetch('/api/sandbox', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-file-mime': file.type || MIME[ext] || '', 'x-browser-id': browserId() },
    body: file,
  });
  const j = (await res.json().catch(() => null)) as (SandboxResponse & { error?: string; message?: string; uploads_left?: number }) | null;
  if (!res.ok) throw new SandboxRefusal(j?.message ?? 'The file could not be read. Try again.', res.status, typeof j?.uploads_left === 'number' ? j.uploads_left : null);
  return j as SandboxResponse;
}
