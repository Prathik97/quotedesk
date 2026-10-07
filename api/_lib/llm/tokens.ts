// Local token estimates for the budget guard and --dry-run. No API calls.
// Deliberately conservative: overestimating is safe, underestimating is not.

/** Text: about 3.2 characters per token for mixed English, numbers and markup. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

/** PDF: each page costs its rendered image plus extracted text. */
export function estimatePdfTokens(bytes: Uint8Array): { pages: number; tokens: number } {
  const s = Buffer.from(bytes).toString('latin1');
  const pages = Math.max(1, (s.match(/\/Type\s*\/Page\b/g) ?? []).length);
  return { pages, tokens: pages * 2000 };
}

/** Image dimensions from PNG or JPEG headers. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(bytes);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1] ?? 0;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Image tokens are roughly width x height / 750 after the API's resize; assume a high resolution ceiling. */
export function estimateImageTokens(bytes: Uint8Array): number {
  const d = imageSize(bytes);
  if (!d) return 6000;
  const longEdge = Math.max(d.width, d.height);
  const scale = Math.min(1, 2576 / longEdge);
  return Math.ceil((d.width * scale * d.height * scale) / 750) + 100;
}
