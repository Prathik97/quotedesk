// Signed URLs and file bytes for the source view. The bucket is private; the
// browser only ever gets a short lived signed URL for one file.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'documents';
const SIGNED_SECONDS = 3600;

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  client ??= createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false } });
  return client;
}

export function isMessageBody(storagePath: string): boolean {
  return storagePath.startsWith('message:');
}

export async function signedUrl(storagePath: string): Promise<string | null> {
  if (isMessageBody(storagePath)) return null;
  const { data, error } = await sb().storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_SECONDS);
  return error || !data ? null : data.signedUrl;
}

export async function signedUrls(paths: string[]): Promise<Map<string, string>> {
  const real = [...new Set(paths.filter((p) => !isMessageBody(p)))];
  const out = new Map<string, string>();
  if (real.length === 0) return out;
  const { data } = await sb().storage.from(BUCKET).createSignedUrls(real, SIGNED_SECONDS);
  for (const d of data ?? []) if (d.path && d.signedUrl) out.set(d.path, d.signedUrl);
  return out;
}

const cache = new Map<string, Uint8Array>();

export async function downloadBytes(storagePath: string): Promise<Uint8Array> {
  const hit = cache.get(storagePath);
  if (hit) return hit;
  const { data, error } = await sb().storage.from(BUCKET).download(storagePath);
  if (error || !data) throw new Error(`Could not read the stored file: ${error?.message ?? 'empty'}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (cache.size >= 6) cache.delete(cache.keys().next().value as string);
  cache.set(storagePath, bytes);
  return bytes;
}
