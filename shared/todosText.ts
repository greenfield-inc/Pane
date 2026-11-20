/**
 * To-dos text in agent instructions and skills (T-39). Instructions Pane writes for agents mark their
 * To-dos parts with `<!-- pane:todos -->` … `<!-- /pane:todos -->`, either as lines of their own around
 * a block or inline around part of a line. `withTodosText` drops the marked parts while To-dos is off
 * and only the markers while it is on, so the text with To-dos on is the text as written.
 */
export const TODOS_TEXT_START = '<!-- pane:todos -->';
export const TODOS_TEXT_END = '<!-- /pane:todos -->';

const BLOCK = /^[ \t]*<!-- pane:todos -->[ \t]*\r?\n([\s\S]*?)^[ \t]*<!-- \/pane:todos -->[ \t]*(?:\r?\n|$)/gm;
const INLINE = /<!-- pane:todos -->([\s\S]*?)<!-- \/pane:todos -->/g;

export function withTodosText(text: string, todosOn: boolean): string {
  if (!text.includes(TODOS_TEXT_START)) return text;
  if (todosOn) return text.replace(BLOCK, '$1').replace(INLINE, '$1');
  return text.replace(BLOCK, '').replace(INLINE, '').replace(/\n{3,}/g, '\n\n');
}
