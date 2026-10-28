// Adapted from GlanceCode (https://github.com/sousyllc/glancecode), MIT License, Copyright (c) 2026 Sousy LLC. See LICENSE.
// Pixel-accurate text layout for the G2 firmware font, measured with @evenrealities/pretext.
// Every line is wrapped here, so the firmware never re-wraps or scrolls a container.
import { getAdvW, getTextWidth, pxTruncate } from '@evenrealities/pretext';

export const SCREEN_W = 576;
export const SCREEN_H = 288;
export const LINE_H = 27;

/** Characters the firmware font can't draw, mapped to ones it can. Anything else it can't draw is dropped. */
const GLYPH_FALLBACKS = new Map<string, string>([
  ['⏺', '●'], ['❯', '>'], ['▸', '▶'], ['◦', '·'], ['‣', '•'], ['✓', '√'], ['✔', '√'], ['✗', '×'], ['✕', '×'],
  ['⎿', ' '], ['⚠', '!'], ['✻', '*'], ['✳', '*'], ['⋯', '…'], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
]);

/** Text the firmware can draw: tabs become spaces, control characters and missing glyphs go. */
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n') out += ch;
    else if (ch === '\t') out += '  ';
    else {
      const mapped = GLYPH_FALLBACKS.get(ch) ?? ch;
      const cp = mapped.codePointAt(0) ?? 0;
      if (cp >= 32 && getAdvW(cp) > 0) out += mapped;
    }
  }
  return out;
}

export function textWidth(text: string): number {
  return getTextWidth(text);
}

/** One line cut to `maxPx` with an ellipsis. */
export function fitLine(text: string, maxPx: number): string {
  const clean = sanitize(text).replace(/\n/g, ' ');
  return getTextWidth(clean) <= maxPx ? clean : pxTruncate(clean, maxPx).replace(/\.\.\.$/, '…');
}

/** Greedy word wrap to `maxPx`. Words wider than a line are split by character; leading spaces are kept. */
export function wrap(text: string, maxPx: number): string[] {
  const out: string[] = [];
  for (const paragraph of sanitize(text).split('\n')) {
    const indent = /^\s*/.exec(paragraph)?.[0] ?? '';
    const words = paragraph.slice(indent.length).split(/\s+/).filter(Boolean);
    let line = indent;
    let hasWord = false;
    if (!words.length) {
      out.push('');
      continue;
    }
    for (const word of words) {
      const candidate = hasWord ? `${line} ${word}` : `${line}${word}`;
      if (getTextWidth(candidate) <= maxPx) {
        line = candidate;
        hasWord = true;
        continue;
      }
      if (hasWord) {
        out.push(line);
        line = '';
      }
      let rest = word;
      while (getTextWidth(line + rest) > maxPx && rest.length > 1) {
        let n = rest.length - 1;
        while (n > 1 && getTextWidth(line + rest.slice(0, n)) > maxPx) n -= 1;
        out.push(line + rest.slice(0, n));
        line = '';
        rest = rest.slice(n);
      }
      line += rest;
      hasWord = true;
    }
    out.push(line);
  }
  return out;
}

/** Wraps to at most `maxLines`; a cut ends its last line with "…". */
export function wrapClamped(text: string, maxPx: number, maxLines: number) {
  const lines = wrap(text, maxPx);
  if (lines.length <= maxLines) return { lines, cut: false };
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = fitLine(`${last.replace(/[\s,;:.]+$/, '')}…`, maxPx);
  return { lines: kept, cut: true };
}

/** UTF-8 byte length; the simulator caps text containers at 999 bytes and list items at 63. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes, keeping whole characters. */
export function clampBytes(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const size = utf8Length(ch);
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-_]`, 'g');

/** Terminal text without escape sequences (colours, cursor moves, titles). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}
