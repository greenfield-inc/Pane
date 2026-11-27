const TAB_WIDTH = 4;

/**
 * Turns multi-line pasted text into keystrokes an agent CLI types into its prompt instead of submitting: each
 * newline becomes Alt+Enter (`ESC CR`). Tabs become spaces up to the next tab stop, because a CLI drawing its own
 * prompt counts a tab as one column while the terminal advances to the tab stop, which garbles the prompt.
 */
export function toAgentPasteInput(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map(expandTabs)
    .join('\x1b\r');
}

function expandTabs(line: string): string {
  let expanded = '';
  for (const character of line) {
    if (character === '\t') {
      expanded += ' '.repeat(TAB_WIDTH - (expanded.length % TAB_WIDTH));
    } else {
      expanded += character;
    }
  }
  return expanded;
}
