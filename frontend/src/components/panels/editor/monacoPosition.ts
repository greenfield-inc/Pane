/**
 * Cursor/scroll persistence for a Monaco editor tab: debounced saves while
 * the user moves, and a restore once the editor has laid out.
 */
import type * as monaco from 'monaco-editor';
import type { EditorPanelState } from '../../../../../shared/types/panels';
import { debounce } from '../../../utils/debounce';

export interface PositionTracker {
  /** Drop any queued save — used when the tab is re-targeted to another file. */
  cancel: () => void;
  dispose: () => void;
}

export function trackEditorPosition(
  editor: monaco.editor.IStandaloneCodeEditor,
  onStateChange: (state: Partial<EditorPanelState>) => void,
): PositionTracker {
  const saveCursor = debounce((position: monaco.IPosition) => {
    onStateChange({ cursorPosition: { line: position.lineNumber, column: position.column } });
  }, 500);
  const saveScroll = debounce((scrollTop: number) => {
    onStateChange({ scrollPosition: scrollTop });
  }, 500);

  const cursorListener = editor.onDidChangeCursorPosition((e) => saveCursor(e.position));
  const scrollListener = editor.onDidScrollChange((e) => {
    if (e.scrollTop !== undefined) saveScroll(e.scrollTop);
  });

  return {
    cancel: () => {
      saveCursor.cancel();
      saveScroll.cancel();
    },
    dispose: () => {
      cursorListener.dispose();
      scrollListener.dispose();
      saveCursor.flush();
      saveScroll.flush();
    },
  };
}

export function restoreEditorPosition(
  editor: monaco.editor.IStandaloneCodeEditor,
  state: EditorPanelState | undefined,
): void {
  if (state?.cursorPosition) {
    const { line, column } = state.cursorPosition;
    editor.setPosition({ lineNumber: line, column });
    editor.revealPositionInCenter({ lineNumber: line, column });
  }
  if (state?.scrollPosition !== undefined) {
    editor.setScrollTop(state.scrollPosition);
  }
}
