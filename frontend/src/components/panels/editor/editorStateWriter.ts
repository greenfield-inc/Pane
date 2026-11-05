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
 * pending dirty flag. A tab that just became dirty is written at once, since
 * archive reads that flag to keep a Pane with unsaved edits; while it stays
 * dirty, its writes are debounced like any other.
 */
export function createEditorStateWriter(write: WriteEditorState, waitMs: number): EditorStateWriter {
  let pending: { panelId: string; sessionId: string; state: Partial<EditorPanelState> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writtenDirty: boolean | undefined;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (!next) return;
    if (next.state.isDirty !== undefined) writtenDirty = next.state.isDirty;
    write(next.panelId, next.sessionId, next.state);
  };

  return {
    update(panelId, sessionId, state) {
      if (pending && pending.panelId !== panelId) {
        flush();
        writtenDirty = undefined;
      }
      pending = { panelId, sessionId, state: { ...pending?.state, ...state } };
      if (state.isDirty === true && writtenDirty !== true) {
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
      writtenDirty = undefined;
    },
  };
}
