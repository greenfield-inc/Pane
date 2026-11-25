import { isReadOnlyHost } from '../../../../stores/readOnlyHostStore';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { TodoAction } from '../../../../../../shared/types/todos';
import { todosApi, useTodosStore } from '../../../../stores/todosStore';
import { showActionError } from '../../../../stores/errorStore';
import { ipcErrorMessage } from '../../../../utils/ipcErrorMessage';
import { eventFiles, fileName, type ComposerFile } from './threadInputs';

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
    const api = todosApi();
    if (!api) return { ok: false, error: 'To-dos are not available here. Nothing was sent.' };
    if (isReadOnlyHost()) return { ok: false, error: 'This computer gives you read-only access. Nothing was sent.' };
    const response = await api.act(action);
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

type TodoAct = ReturnType<typeof useTodosStore.getState>['act'];

/**
 * Pasted or dropped files, saved as files on this machine the way the chat composer saves pasted
 * images, then each attached to the to-do (the attach action, source "attached", by you). Returns
 * the files that were attached; none where the app can't save a file (the web app).
 */
async function saveAndAttach(number: number, dropped: readonly File[], act: TodoAct): Promise<ComposerFile[]> {
  const saver = todosApi()?.files;
  if (dropped.length === 0 || !saver) return [];
  const payload = await Promise.all(dropped.map(async (file, index) => ({
    name: file.name || `file-${index + 1}`,
    dataUrl: await readDataUrl(file),
    type: file.type || 'application/octet-stream',
  })));
  const paths = await saver.save(`pending_todo-${number}`, payload);
  const attached: ComposerFile[] = [];
  for (const [index, path] of paths.entries()) {
    const name = payload[index]?.name ?? fileName(path);
    if (await act({ kind: 'attach', number, target: path, label: name })) attached.push({ name, path });
  }
  return attached;
}

export interface ComposerAttach {
  files: ComposerFile[];
  busy: boolean;
  /** False where the app can't pick or save a file (the web app): 📎 stays out of the composer. */
  available: boolean;
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
    const path = await todosApi()?.files?.pick().catch(() => null);
    if (!path) return;
    setBusy(true);
    await attach(path, fileName(path));
    setBusy(false);
  }, [attach]);

  const addFiles = useCallback(async (dropped: readonly File[]) => {
    if (dropped.length === 0 || !todosApi()?.files) return;
    setBusy(true);
    try {
      const attached = await saveAndAttach(number, dropped, act);
      setFiles((current) => [...current, ...attached.filter((file) => !current.some((known) => known.path === file.path))]);
    } catch (error) {
      showActionError('Could not attach the file', error);
    } finally {
      setBusy(false);
    }
  }, [act, number]);

  const remove = useCallback((path: string) => setFiles((current) => current.filter((file) => file.path !== path)), []);
  const clear = useCallback(() => setFiles([]), []);
  return { files, busy, available: todosApi()?.files !== undefined, pick, addFiles, remove, clear };
}

/** Files dropped on the thread, on their way to that to-do's composer. */
class ComposerFilesEvent extends Event {
  static readonly type = 'pane:todo-composer-files';
  constructor(readonly number: number, readonly files: readonly File[]) {
    super(ComposerFilesEvent.type);
  }
}

/** A file dropped anywhere on the to-do's thread goes to its composer, as one dropped on the box does. */
export function sendFilesToComposer(number: number, files: readonly File[]): void {
  window.dispatchEvent(new ComposerFilesEvent(number, files));
}

/** The composer's side of `sendFilesToComposer`. */
export function useComposerFileInbox(number: number, onFiles: (files: readonly File[]) => void): void {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    const listener = (event: Event) => {
      if (event instanceof ComposerFilesEvent && event.number === number) latest.current(event.files);
    };
    window.addEventListener(ComposerFilesEvent.type, listener);
    return () => window.removeEventListener(ComposerFilesEvent.type, listener);
  }, [number]);
}

export interface FileDropZone {
  /** A file is being dragged over the zone: it shows its drop ring. */
  dragging: boolean;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

/**
 * A place files can be dropped. The innermost zone takes the drop (it stops there), so the
 * composer inside the thread, or the split beside it, each keep their own. Off (`enabled` false)
 * where the app can't save a file.
 */
export function useFileDropZone(onFiles: (files: File[]) => void, enabled = true): FileDropZone {
  const [dragging, setDragging] = useState(false);
  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!enabled || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  }, [enabled]);
  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    // Leaving for a child of the zone is still over it.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  }, []);
  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    setDragging(false);
    if (!enabled) return;
    const files = eventFiles(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    onFiles(files);
  }, [enabled, onFiles]);
  return { dragging, onDragOver, onDragLeave, onDrop };
}

/**
 * Files dropped on the split or the details sidebar's Attachments: attached to the to-do straight
 * away (no comment), through the composer's save and attach; `onAttached` gets each path so the
 * split shows the last one.
 */
export function useAttachDrop(number: number, onAttached: (target: string) => void): FileDropZone {
  const act = useTodosStore((state) => state.act);
  const available = todosApi()?.files !== undefined;
  const onFiles = useCallback(async (files: File[]) => {
    try {
      const last = (await saveAndAttach(number, files, act)).at(-1);
      if (last) onAttached(last.path);
    } catch (error) {
      showActionError('Could not attach the file', error);
    }
  }, [act, number, onAttached]);
  return useFileDropZone((files) => void onFiles(files), available);
}
