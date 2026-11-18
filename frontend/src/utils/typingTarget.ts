/**
 * Whether keys pressed in `target` belong to it: a text field, an editor, a
 * terminal or an embedded page, where single keys type and Pane's own
 * single-key handling stands back. One helper for every keyboard handler that
 * asks (the approvals keys, the Approvals screen's Esc, the column's pager and
 * find's routing), so the answer can't drift between them.
 */
export interface TypingTargetOptions {
  /** A focused <select> counts (default true). */
  selects?: boolean;
  /** Focus in a terminal (inside `.xterm`) counts (default true). */
  terminals?: boolean;
  /** A focused <iframe> counts (default false): its page has the keys. */
  frames?: boolean;
}

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'WEBVIEW']);

export function isTypingTarget(target: EventTarget | null, options: TypingTargetOptions = {}): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const { selects = true, terminals = true, frames = false } = options;
  if (target.isContentEditable || TEXT_TAGS.has(target.tagName)) return true;
  if (selects && target.tagName === 'SELECT') return true;
  if (frames && target.tagName === 'IFRAME') return true;
  return terminals && target.closest('.xterm') !== null;
}
