import { useState, useSyncExternalStore, type SetStateAction } from 'react';

import { composerDraftStore } from './composerDrafts';
import { ComposerCursor } from './composerCursor';
import type { Selection } from './insertText';

/** Text belongs to a durable key; cursor position belongs to the current view. */
export function useComposerDraft(key: string | null) {
  const draft = useSyncExternalStore(listener => composerDraftStore.subscribe(key, listener), () => composerDraftStore.read(key));
  const [selection, setSelection] = useState<{ key: string | null; cursor: ComposerCursor; moveTo?: Selection }>(() => ({ key, cursor: new ComposerCursor() }));
  if (selection.key !== key) setSelection({ key, cursor: new ComposerCursor() });
  return {
    draft: draft.text,
    selection: selection.key === key ? selection.moveTo : undefined,
    /** The draft is on its way; Send waits until the host confirms it. */
    sending: draft.sending === true,
    /** Delivers the draft once; the text stays until `deliver` resolves. See DraftStore.send. */
    send: (deliver: (text: string) => Promise<void>) => composerDraftStore.send(key, deliver),
    setDraft: (next: SetStateAction<string>) => {
      composerDraftStore.update(key, next);
      if (composerDraftStore.read(key).text === '') selection.cursor.select(null);
      setSelection(current => current.cursor === selection.cursor ? { key, cursor: current.cursor } : current);
    },
    onSelectionChange: (cursor: Selection) => {
      selection.cursor.select(cursor);
      setSelection(current => current.cursor === selection.cursor ? { key, cursor: current.cursor } : current);
    },
    insert: (insert: string) => {
      const result = selection.cursor.insert(composerDraftStore.read(key).text, insert);
      composerDraftStore.update(key, result.text);
      setSelection(current => current.cursor === selection.cursor ? { key, cursor: current.cursor, moveTo: result.selection } : current);
    },
  };
}
