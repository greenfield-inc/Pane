/**
 * Bullet lists in the chat input (T-137). The text stays plain markdown: a line that starts
 * with "- " (or "* "), after any indent, is a bullet. Enter continues the list, Enter on an
 * empty bullet ends it, and Tab / Shift-Tab indent and outdent by two spaces. Keys off a
 * bullet return undefined, so Enter still sends and Tab still moves focus.
 */

/** Replace text[start, end) with insert, then select [selectionStart, selectionEnd) in the new text. */
export interface BulletEdit {
  start: number;
  end: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
}

const INDENT = '  ';
const BULLET = /^( *)([-*]) /;

function lineStart(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

function lineEnd(text: string, index: number): number {
  const end = text.indexOf('\n', index);
  return end < 0 ? text.length : end;
}

function enter(text: string, caret: number): BulletEdit | undefined {
  const start = lineStart(text, caret);
  const end = lineEnd(text, caret);
  const line = text.slice(start, end);
  const bullet = BULLET.exec(line);
  if (!bullet) return undefined;
  const prefix = bullet[0].length;
  if (caret - start < prefix) return { start: caret, end: caret, insert: '\n', selectionStart: caret + 1, selectionEnd: caret + 1 };
  if (!line.slice(prefix).trim()) return { start, end, insert: '', selectionStart: start, selectionEnd: start };
  const insert = `\n${bullet[1]}${bullet[2]} `;
  // Spaces after the caret would follow the new marker; drop them.
  const rest = caret + (/^ */.exec(text.slice(caret, end))?.[0].length ?? 0);
  return { start: caret, end: rest, insert, selectionStart: caret + insert.length, selectionEnd: caret + insert.length };
}

function indent(text: string, from: number, to: number, outdent: boolean): BulletEdit | undefined {
  const start = lineStart(text, from);
  const end = lineEnd(text, Math.max(from, to));
  const lines = text.slice(start, end).split('\n');
  if (!lines.every(line => BULLET.test(line))) return undefined;
  // Each line's change in length, so the selection stays on the same characters.
  const shifts = lines.map(line => outdent ? -Math.min(INDENT.length, BULLET.exec(line)![1].length) : INDENT.length);
  const insert = lines.map((line, index) => shifts[index] > 0 ? INDENT + line : line.slice(-shifts[index])).join('\n');
  const moved = (position: number) => {
    let offset = 0;
    let at = start;
    for (const [index, line] of lines.entries()) {
      if (position < at) break;
      offset += Math.max(shifts[index], -(position - at));
      at += line.length + 1;
    }
    return position + offset;
  };
  return { start, end, insert, selectionStart: moved(from), selectionEnd: moved(to) };
}

/** The edit a key makes on a bullet line, or undefined when the key keeps its usual meaning. */
export function bulletKey(text: string, selectionStart: number, selectionEnd: number, key: string, shift: boolean): BulletEdit | undefined {
  if (key === 'Enter') return !shift && selectionStart === selectionEnd ? enter(text, selectionStart) : undefined;
  if (key === 'Tab') return indent(text, selectionStart, selectionEnd, shift);
  return undefined;
}

export function applyBulletEdit(text: string, edit: BulletEdit): string {
  return text.slice(0, edit.start) + edit.insert + text.slice(edit.end);
}

/**
 * Applies an edit to the input as typing would, so undo takes it back and the input's
 * change handler sees the new text.
 */
export function typeBulletEdit(box: HTMLTextAreaElement, edit: BulletEdit) {
  if (box.value.slice(edit.start, edit.end) !== edit.insert) {
    box.setSelectionRange(edit.start, edit.end);
    // execCommand is deprecated but still the only way to edit a textarea with undo history.
    const typed = edit.insert
      ? box.ownerDocument.execCommand('insertText', false, edit.insert)
      : box.ownerDocument.execCommand('delete');
    if (!typed) {
      box.setRangeText(edit.insert, edit.start, edit.end);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: edit.insert }));
    }
  }
  box.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}
