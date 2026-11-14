/** A code fence opener or closer. A backtick fence's info string has no backtick, or the line is a paragraph. */
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
/** A line that, after a blank line, can still belong to the block before it: indented, or a list item. */
const CONTINUES = /^(\s|[-*+](\s|$)|\d{1,9}[.)](\s|$))/;
/**
 * Keeps a message whole: link reference definitions and footnotes resolve across it, and
 * these raw HTML blocks (comments, <pre>, <script>, <style>, <textarea>, <?, <!) can span blank lines.
 */
const WHOLE = /^ {0,3}(\[[^\]]+\]:|<([!?]|(pre|script|style|textarea)\b))/im;

/**
 * Splits a message into top-level markdown blocks that render the same alone as together,
 * so a streaming reply re-parses only its last block. A cut goes only at a blank line,
 * outside fenced code, before a line that starts a new block at the left margin.
 */
export function markdownBlocks(text: string): string[] {
  if (WHOLE.test(text)) return [text];
  const blocks: string[] = [];
  const lines = text.split('\n');
  let start = 0;
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    fence = marker;
    if (index === 0 || line === '' || CONTINUES.test(line) || lines[index - 1].trim() !== '') continue;
    blocks.push(`${lines.slice(start, index).join('\n')}\n`);
    start = index;
  }
  blocks.push(lines.slice(start).join('\n'));
  return blocks;
}
