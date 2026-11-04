import type { EditorPanelState } from '../../../../../shared/types/panels';

type WriteEditorState = (panelId: string, sessionId: string, state: Partial<EditorPanelState>) => void;

export interface EditorStateWriter {
  update: (panelId: string, sessionId: string, state: Partial<EditorPanelState>) => void;
  flush: () => void;
  cancel: () => void;
}

/**
 * Batches an editor tab's state writes (cursor, scroll, dirty flag) into one
 * write per `waitMs`, merging fields so a later cursor update never drops a
 * pending dirty flag. A tab that just became dirty is written at once:
 * `runpane panels close` reads that flag to refuse closing unsaved edits.
 */
export function createEditorStateWriter(write: WriteEditorState, waitMs: number): EditorStateWriter {
  let pending: { panelId: string; sessionId: string; state: Partial<EditorPanelState> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (next) write(next.panelId, next.sessionId, next.state);
  };

  return {
    update(panelId, sessionId, state) {
      if (pending && pending.panelId !== panelId) flush();
      pending = { panelId, sessionId, state: { ...pending?.state, ...state } };
      if (state.isDirty === true) {
        flush();
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, waitMs);
    },
    flush,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
