// An anonymous id this browser makes for itself, so drafts and the inbox reveal belong to one visitor on a
// shared demo. It is random, holds no personal data and is sent only to this app's own API.
const KEY = 'quotedesk.browser';
let memory: string | null = null;

function make(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
}

export function browserId(): string {
  if (memory) return memory;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return (memory = saved);
    memory = make();
    localStorage.setItem(KEY, memory);
  } catch {
    memory ??= make(); // storage blocked: the id lives for this tab only
  }
  return memory;
}
