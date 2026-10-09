export interface Selection {
  start: number;
  end: number;
}

/**
 * Puts `insert` at the cursor (or over the selection) the way a path or a
 * snippet should land in a sentence: a space before it unless the draft is
 * empty or already has one, a space after it, and the cursor past that space
 * so typing or dictation carries on. A null selection means the end.
 */
export function insertAtSelection(draft: string, selection: Selection | null, insert: string): { text: string; cursor: number } {
  const start = Math.min(selection?.start ?? draft.length, draft.length);
  const end = Math.min(Math.max(selection?.end ?? draft.length, start), draft.length);
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const trail = /^\s/.test(after) ? '' : ' ';
  const text = `${before}${lead}${insert}${trail}${after}`;
  return { text, cursor: before.length + lead.length + insert.length + 1 };
}
