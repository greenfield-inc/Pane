import { useCallback, useState } from 'react';
import type { TodoAction } from '../../../../../../shared/types/todos';
import { useTodosStore } from '../../../../stores/todosStore';
import { showActionError } from '../../../../stores/errorStore';
import { ipcErrorMessage } from '../../../../utils/ipcErrorMessage';
import { fileName, type ComposerFile } from './threadInputs';

/** What sending a comment or reply came to: sent, or the backend's reason it was refused. */
export interface ThreadSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Sends a comment or reply on the page's action channel (`todos:act`) and keeps the backend's words
 * when it refuses one (a reply whose card can't be answered says why), so the card shows them.
 */
export async function sendThreadComment(action: TodoAction): Promise<ThreadSendResult> {
  try {
    const response = await window.electronAPI.todos.act(action);
    if (!response.success || !response.data) return { ok: false, error: ipcErrorMessage(response.error, 'Pane did not say why. Nothing was sent.') };
    await useTodosStore.getState().refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: ipcErrorMessage(error, 'Pane did not say why. Nothing was sent.') };
  }
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result === null || result instanceof ArrayBuffer) reject(new Error(`${file.name || 'The file'} could not be read.`));
      else resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name || 'The file'} could not be read.`));
    reader.readAsDataURL(file);
  });
}

export interface ComposerAttach {
  files: ComposerFile[];
  busy: boolean;
  /** 📎: pick a file on this machine. */
  pick: () => Promise<void>;
  /** A pasted or dropped file: saved on this machine, then attached by its path. */
  addFiles: (files: readonly File[]) => Promise<void>;
  remove: (path: string) => void;
  clear: () => void;
}

/**
 * The composer's 📎: each file becomes a to-do attachment at once (the existing attach action,
 * source "attached", by you), and the comment then names it and its path.
 */
export function useComposerAttach(number: number): ComposerAttach {
  const act = useTodosStore((state) => state.act);
  const [files, setFiles] = useState<ComposerFile[]>([]);
  const [busy, setBusy] = useState(false);

  const attach = useCallback(async (path: string, name: string) => {
    const result = await act({ kind: 'attach', number, target: path, label: name });
    if (result) setFiles((current) => (current.some((file) => file.path === path) ? current : [...current, { name, path }]));
  }, [act, number]);

  const pick = useCallback(async () => {
    const response = await window.electronAPI.dialog.openFile().catch(() => null);
    const path = response?.success ? response.data : null;
    if (!path) return;
    setBusy(true);
    await attach(path, fileName(path));
    setBusy(false);
  }, [attach]);

  const addFiles = useCallback(async (dropped: readonly File[]) => {
    if (dropped.length === 0) return;
    setBusy(true);
    try {
      const payload = await Promise.all(dropped.map(async (file, index) => ({
        name: file.name || `file-${index + 1}`,
        dataUrl: await readDataUrl(file),
        type: file.type || 'application/octet-stream',
      })));
      // Saved as files on this machine the way the chat composer saves pasted images.
      const paths = await window.electronAPI.sessions.saveImages(`pending_todo-${number}`, payload);
      for (const [index, path] of paths.entries()) await attach(path, payload[index]?.name ?? fileName(path));
    } catch (error) {
      showActionError('Could not attach the file', error);
    } finally {
      setBusy(false);
    }
  }, [attach, number]);

  const remove = useCallback((path: string) => setFiles((current) => current.filter((file) => file.path !== path)), []);
  const clear = useCallback(() => setFiles([]), []);
  return { files, busy, pick, addFiles, remove, clear };
}
