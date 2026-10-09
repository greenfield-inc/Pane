export interface DelimitedPreview {
  rows: string[][];
  truncated: boolean;
}

/** RFC 4180 quotes, embedded newlines and escaped quotes; bound rendered cells. */
export function parseDelimitedPreview(text: string, delimiter: ',' | '\t', partial = false): DelimitedPreview {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  const pushCell = () => {
    if (row.length >= 100) throw new Error('This table has more than 100 columns.');
    row.push(cell); cell = ''; closedQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
    } else if (char === delimiter) {
      pushCell();
    } else if (char === '\r' || char === '\n') {
      pushCell(); rows.push(row); row = [];
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (rows.length >= 501) return { rows, truncated: i < text.length - 1 || partial };
    } else if (char === '"' && !cell && !closedQuote) {
      quoted = true;
    } else {
      if (closedQuote || char === '"') throw new Error('Invalid quoted table cell.');
      cell += char;
    }
  }
  if (quoted && !partial) throw new Error('Unclosed quoted table cell.');
  if (!partial && (cell || row.length || closedQuote)) { pushCell(); rows.push(row); }
  return { rows, truncated: partial };
}

export async function readPreviewText(url: string, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const limit = 1024 * 1024;
  const response = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` }, signal });
  const range = response.headers.get('Content-Range');
  if (response.status === 416 && range === 'bytes */0') return { text: '', truncated: false };
  if (!response.ok) throw new Error('Cannot read this preview.');
  const total = Number(range?.split('/')[1] ?? response.headers.get('Content-Length'));
  const truncated = total > limit;
  const bytes = await response.arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
  if (text.includes('\0')) throw new Error('This file contains binary data.');
  return { text: text.replace(/^\uFEFF/, ''), truncated };
}
