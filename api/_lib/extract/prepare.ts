// Turns one vendor file into model input. Text formats become an addressed text
// rendering (cell addresses, paragraph and table indices, line numbers) so every
// value can carry a locator. PDF and images go to the model natively.
import type Anthropic from '@anthropic-ai/sdk';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { simpleParser } from 'mailparser';
import type { SourceType } from '../../../engine/types.js';
import { estimateImageTokens, estimatePdfTokens, estimateTextTokens } from '../llm/tokens.js';

export type Prepared = {
  source_type: SourceType;
  /** Addressed text for text formats; null for pdf and image. */
  text: string | null;
  /** Native block for pdf and image. */
  native: Anthropic.DocumentBlockParam | Anthropic.ImageBlockParam | null;
  /** Deterministic observations made while parsing (hidden sheets, tiny text). */
  observations: { kind: string; detail: string }[];
  estimated_tokens: number;
};

export const ACCEPTED: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.eml': 'message/rfc822',
  '.txt': 'text/plain',
};

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v && v.result != null) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('error' in v) return String(v.error);
  }
  return String(v);
}

export async function prepareXlsx(bytes: Uint8Array): Promise<Prepared> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const out: string[] = [];
  const observations: Prepared['observations'] = [];
  wb.eachSheet((ws) => {
    const hidden = ws.state !== 'visible';
    out.push(`=== Sheet '${ws.name}'${hidden ? ' [HIDDEN SHEET: not visible to a normal reader]' : ''} ===`);
    const merges: string[] = (ws.model as { merges?: string[] }).merges ?? [];
    if (merges.length) out.push(`Merged regions: ${merges.join(', ')}`);
    let cells = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const parts: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const t = cellText(cell.value).replace(/\s+/g, ' ').trim();
        if (t) {
          parts.push(`${cell.address}: ${t}`);
          cells++;
        }
      });
      if (parts.length) out.push(parts.join(' | '));
    });
    if (hidden) observations.push({ kind: 'hidden_sheet', detail: `Workbook has a hidden sheet '${ws.name}' with ${cells} filled cells.` });
  });
  const text = out.join('\n');
  return { source_type: 'xlsx', text, native: null, observations, estimated_tokens: estimateTextTokens(text) };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Mammoth HTML to addressed text: [P n] paragraphs, [T t R r C c] table cells, in document order. */
export function htmlToAddressedText(html: string): string {
  const out: string[] = [];
  let p = 0;
  let t = 0;
  let r = 0;
  let c = 0;
  let inTable = 0;
  let buf = '';
  const flushPara = () => {
    const s = decodeEntities(buf).replace(/\s+/g, ' ').trim();
    if (s) out.push(`[P${++p}] ${s}`);
    buf = '';
  };
  const flushCell = () => {
    const s = decodeEntities(buf).replace(/\s+/g, ' ').trim();
    out.push(`[T${t} R${r} C${c}] ${s}`);
    buf = '';
  };
  for (const tok of html.split(/(<[^>]+>)/)) {
    if (!tok.startsWith('<')) {
      buf += tok;
      continue;
    }
    const tag = tok.toLowerCase();
    if (/^<table/.test(tag)) {
      inTable++;
      t++;
      r = 0;
    } else if (/^<\/table/.test(tag)) inTable--;
    else if (/^<tr/.test(tag)) {
      r++;
      c = 0;
    } else if (/^<t[dh][ >]/.test(tag)) {
      c++;
      buf = '';
    } else if (/^<\/t[dh]>/.test(tag)) flushCell();
    else if (/^<\/(p|h[1-6]|li)>/.test(tag) && !inTable) flushPara();
    else if (/^<br/.test(tag)) buf += ' / ';
    else if (/^<\/p>/.test(tag) && inTable) buf += ' ';
  }
  if (buf.trim()) flushPara();
  return out.join('\n');
}

/** Header and footer text (mammoth ignores both). Very small or very light runs are marked. */
export async function docxHeadersFooters(bytes: Uint8Array): Promise<{ text: string; observations: Prepared['observations'] }> {
  const zip = await JSZip.loadAsync(bytes);
  const out: string[] = [];
  const observations: Prepared['observations'] = [];
  const names = Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort();
  for (const name of names) {
    const xml = (await zip.file(name)?.async('string')) ?? '';
    const part = name.includes('footer') ? 'Footer' : 'Header';
    let line = 0;
    for (const para of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
      const runs: string[] = [];
      for (const run of para.match(/<w:r[ >][\s\S]*?<\/w:r>/g) ?? []) {
        const text = decodeEntities((run.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? []).map((m) => m.replace(/<[^>]+>/g, '')).join(''));
        if (!text.trim()) continue;
        const sz = Number(run.match(/<w:sz w:val="(\d+)"/)?.[1] ?? 0); // half points
        const color = run.match(/<w:color w:val="([0-9A-Fa-f]{6})"/)?.[1];
        const light = color ? [0, 2, 4].every((i) => parseInt(color.slice(i, i + 2), 16) >= 0xc8) : false;
        const marks = [sz > 0 && sz < 12 ? `very small text, ${sz / 2} pt` : null, light ? `very light text, colour #${color}` : null].filter(Boolean);
        runs.push(marks.length ? `[${marks.join('; ')}] ${text}` : text);
        if (marks.length) observations.push({ kind: 'low_visibility_text', detail: `${part} contains ${marks.join(' and ')}.` });
      }
      if (runs.length) out.push(`[${part} ${name.match(/\d+/)?.[0] ?? '1'} line ${++line}] ${runs.join(' ')}`);
    }
  }
  return { text: out.join('\n'), observations };
}

export async function prepareDocx(bytes: Uint8Array): Promise<Prepared> {
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const body = htmlToAddressedText(html);
  const hf = await docxHeadersFooters(bytes);
  const text = hf.text ? `${body}\n=== Headers and footers ===\n${hf.text}` : body;
  return { source_type: 'docx', text, native: null, observations: hf.observations, estimated_tokens: estimateTextTokens(text) };
}

function numberLines(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l, i) => `[L${i + 1}] ${l}`)
    .join('\n');
}

export async function prepareEml(bytes: Uint8Array): Promise<Prepared> {
  const mail = await simpleParser(Buffer.from(bytes));
  const head = [
    `From: ${mail.from?.text ?? ''}`,
    `To: ${Array.isArray(mail.to) ? mail.to.map((t) => t.text).join(', ') : (mail.to?.text ?? '')}`,
    `Subject: ${mail.subject ?? ''}`,
    `Date: ${mail.date?.toISOString() ?? ''}`,
    `Attachments: ${mail.attachments.map((a) => a.filename ?? 'unnamed').join(', ') || 'none'}`,
  ].join('\n');
  const text = `${head}\n--- body ---\n${numberLines(mail.text ?? '')}`;
  return { source_type: 'email', text, native: null, observations: [], estimated_tokens: estimateTextTokens(text) };
}

export function prepareMessageBody(meta: { from: string; subject: string; received: string }, body: string): Prepared {
  const text = `From: ${meta.from}\nSubject: ${meta.subject}\nReceived: ${meta.received}\n--- body ---\n${numberLines(body)}`;
  return { source_type: 'email', text, native: null, observations: [], estimated_tokens: estimateTextTokens(text) };
}

export function preparePdf(bytes: Uint8Array): Prepared {
  const { tokens } = estimatePdfTokens(bytes);
  return {
    source_type: 'pdf',
    text: null,
    native: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } },
    observations: [],
    estimated_tokens: tokens,
  };
}

export function prepareImage(bytes: Uint8Array, mime: string): Prepared {
  const media = mime === 'image/png' ? 'image/png' : 'image/jpeg';
  return {
    source_type: 'image',
    text: null,
    native: { type: 'image', source: { type: 'base64', media_type: media, data: Buffer.from(bytes).toString('base64') } },
    observations: [],
    estimated_tokens: estimateImageTokens(bytes),
  };
}

export async function prepare(mime: string, bytes: Uint8Array): Promise<Prepared> {
  switch (mime) {
    case ACCEPTED['.xlsx']:
      return prepareXlsx(bytes);
    case ACCEPTED['.docx']:
      return prepareDocx(bytes);
    case 'message/rfc822':
      return prepareEml(bytes);
    case 'application/pdf':
      return preparePdf(bytes);
    case 'image/png':
    case 'image/jpeg':
      return prepareImage(bytes, mime);
    case 'text/plain': {
      const text = numberLines(Buffer.from(bytes).toString('utf8'));
      return { source_type: 'email', text, native: null, observations: [], estimated_tokens: estimateTextTokens(text) };
    }
    default:
      throw new Error(`Unsupported file type ${mime}. Accepted: xlsx, pdf, docx, png, jpg, eml, txt.`);
  }
}

/** Vendor text is data. It may not close our delimiter early. */
export function fenceVendorText(text: string): string {
  return text.replace(/<\/?\s*vendor_document/gi, (m) => m.replace('<', '&lt;'));
}
