import { useCallback, useEffect, useRef, useState } from 'react';
import type { UploadProgress } from '../../../shared/chunkedUpload';
import { uploadFileToHost, type HostUploadOptions } from '../utils/hostUpload';

/** A copy shows once it has run this long, so a small file never flashes a progress row. */
const SHOW_AFTER_MS = 400;

export interface HostUploadItem {
  id: string;
  name: string;
  progress: UploadProgress;
}

/**
 * Copies files to the Pane's machine and lists the copies still running, with
 * their progress, for a progress list to show. `upload` resolves to the
 * host's path, or null when the person cancelled it.
 */
export function useHostUploads() {
  const [items, setItems] = useState<HostUploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const upload = useCallback(async (options: Omit<HostUploadOptions, 'signal' | 'onProgress'>): Promise<string | null> => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    controllers.current.set(id, controller);
    let latest: UploadProgress = { receivedBytes: 0, totalBytes: options.file.size, retrying: false, lastProgressAt: Date.now(), secondsLeft: null };
    let shown = false;
    const showTimer = setTimeout(() => {
      shown = true;
      setItems(current => [...current, { id, name: options.file.name, progress: latest }]);
    }, SHOW_AFTER_MS);
    try {
      return await uploadFileToHost({
        ...options,
        signal: controller.signal,
        onProgress: progress => {
          latest = progress;
          if (shown) setItems(current => current.map(item => (item.id === id ? { ...item, progress } : item)));
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      clearTimeout(showTimer);
      controllers.current.delete(id);
      setItems(current => current.filter(item => item.id !== id));
    }
  }, []);

  const cancel = useCallback((id: string) => controllers.current.get(id)?.abort(), []);

  // Closing the tab stops its copies; the host deletes partial files after a day.
  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) controller.abort();
    };
  }, []);

  return { items, upload, cancel };
}
