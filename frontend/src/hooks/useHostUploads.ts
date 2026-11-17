import { useCallback, useSyncExternalStore } from 'react';
import type { UploadProgress } from '../../../shared/chunkedUpload';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { uploadFileToHost, type HostUploadOptions } from '../utils/hostUpload';

/** A copy shows once it has run this long, so a small file never flashes a progress row. */
const SHOW_AFTER_MS = 400;

export interface HostUploadItem {
  id: string;
  name: string;
  progress: UploadProgress;
}

interface PanelUploads {
  items: HostUploadItem[];
  controllers: Map<string, AbortController>;
  /** What finished while the terminal was away (a path, or why a copy failed), pasted when it is back. */
  waiting: string[];
  paste: ((text: string) => void) | null;
}

const NO_ITEMS: HostUploadItem[] = [];
const panels = new Map<string, PanelUploads>();
const listeners = new Set<() => void>();

function panelUploads(panelId: string): PanelUploads {
  let entry = panels.get(panelId);
  if (!entry) {
    entry = { items: [], controllers: new Map(), waiting: [], paste: null };
    panels.set(panelId, entry);
  }
  return entry;
}

function setItems(panelId: string, update: (items: HostUploadItem[]) => HostUploadItem[]): void {
  const entry = panels.get(panelId);
  if (!entry) return;
  entry.items = update(entry.items);
  for (const listener of listeners) listener();
}

function deliver(panelId: string, text: string): void {
  const entry = panels.get(panelId);
  if (!entry) return;
  if (entry.paste) entry.paste(text);
  else entry.waiting.push(text);
}

/**
 * Copies files to a terminal's machine one at a time and pastes each path into
 * the terminal. The copies belong to the panel, not to the mounted terminal:
 * switching Panes leaves them running, and what finishes meanwhile is pasted
 * when the terminal mounts again (`attachTerminalPaste`). Only closing the
 * panel stops them (`cancelPanelUploads`).
 */
export async function uploadToTerminal(panelId: string, files: readonly File[], options: Omit<HostUploadOptions, 'file' | 'signal' | 'onProgress'>): Promise<void> {
  const entry = panelUploads(panelId);
  for (const file of files) {
    // The panel was closed during an earlier file: the rest are not sent.
    if (panels.get(panelId) !== entry) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    entry.controllers.set(id, controller);
    let latest: UploadProgress = { receivedBytes: 0, totalBytes: file.size, retrying: false, lastProgressAt: Date.now(), secondsLeft: null };
    let shown = false;
    const showTimer = setTimeout(() => {
      shown = true;
      setItems(panelId, items => [...items, { id, name: file.name, progress: latest }]);
    }, SHOW_AFTER_MS);
    try {
      const path = await uploadFileToHost({
        ...options,
        file,
        signal: controller.signal,
        onProgress: progress => {
          latest = progress;
          if (shown) setItems(panelId, items => items.map(item => (item.id === id ? { ...item, progress } : item)));
        },
      });
      // Paste the raw path: Claude's parser detects image file paths and attaches them.
      deliver(panelId, `${path}\n`);
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[TerminalPanel] Failed to upload file:', error);
        deliver(panelId, `[Upload failed] ${ipcErrorMessage(error, 'Unknown error')}\n`);
      }
    } finally {
      clearTimeout(showTimer);
      entry.controllers.delete(id);
      setItems(panelId, items => items.filter(item => item.id !== id));
    }
  }
}

/** Pastes into the mounted terminal: first what finished while it was away, then each copy as it lands. Returns the detach. */
export function attachTerminalPaste(panelId: string, paste: (text: string) => void): () => void {
  const entry = panelUploads(panelId);
  entry.paste = paste;
  for (const text of entry.waiting.splice(0)) paste(text);
  return () => {
    if (entry.paste === paste) entry.paste = null;
  };
}

/** The panel was closed: stop its copies (the host deletes their partial files) and forget them. */
export function cancelPanelUploads(panelId: string): void {
  const entry = panels.get(panelId);
  if (!entry) return;
  for (const controller of entry.controllers.values()) controller.abort();
  panels.delete(panelId);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The terminal's copies still running, with their progress, and a cancel for each. */
export function useHostUploads(panelId: string) {
  const items = useSyncExternalStore(subscribe, () => panels.get(panelId)?.items ?? NO_ITEMS);
  const cancel = useCallback((id: string) => panels.get(panelId)?.controllers.get(id)?.abort(), [panelId]);
  return { items, cancel };
}
