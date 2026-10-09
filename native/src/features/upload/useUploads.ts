import { useEffect, useRef, useState } from 'react';

import { invokeChannel, useDaemon } from '@/daemon';

import { ChunkedUploadUnsupportedError, uploadInChunks, UploadRefusedError } from './chunkedUpload';
import { pickFiles, type AttachSource, type PickedFile } from './pickFiles';

/** After this long without the host confirming new bytes, the receipt reads "Paused, retrying". */
const PAUSED_AFTER_MS = 5 * 60 * 1000;
/** Done receipts stay up this long. */
const DONE_VISIBLE_MS = 4000;
/** Hosts without chunked upload take one request, capped at 16 MB of base64. */
const SINGLE_REQUEST_MAX_BYTES = 12 * 1024 * 1024;

type ReceiptState = 'queued' | 'uploading' | 'retrying' | 'failed' | 'done';

export interface UploadReceipt {
  id: string;
  name: string;
  uri: string;
  isImage: boolean;
  totalBytes: number;
  receivedBytes: number;
  state: ReceiptState;
  /** Retrying for more than five minutes without progress. */
  paused: boolean;
  error: string | null;
}

interface Job {
  file: PickedFile;
  controller: AbortController;
  nudge: (() => void) | null;
}

/**
 * Picks files and sends them to the host one at a time, in the order picked.
 * Each finished upload hands its host path to `onUploaded`. Uploads run until
 * done, cancelled or refused; a failed one can be retried and resumes where
 * the host left off.
 */
export function useUploads(sessionId: string, onUploaded: (path: string) => void) {
  const { client } = useDaemon();
  const [receipts, setReceipts] = useState<UploadReceipt[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const jobs = useRef(new Map<string, Job>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const delivered = useRef(onUploaded);
  useEffect(() => {
    delivered.current = onUploaded;
  });

  const update = (id: string, patch: Partial<UploadReceipt>) =>
    setReceipts(current => current.map(receipt => (receipt.id === id ? { ...receipt, ...patch } : receipt)));
  const remove = (id: string) => {
    jobs.current.delete(id);
    setReceipts(current => current.filter(receipt => receipt.id !== id));
  };

  const run = async (id: string) => {
    const found = jobs.current.get(id);
    if (!found || found.controller.signal.aborted) return;
    const job: Job = found;
    update(id, { state: 'uploading', error: null, paused: false });
    try {
      let path: string;
      try {
        path = await uploadInChunks({
          invoke: (channel, args) => client.invoke(channel, args),
          file: job.file,
          sessionId,
          uploadId: id,
          signal: job.controller.signal,
          wait: (ms, signal) => new Promise<void>(resolve => {
            const timer = setTimeout(done, ms);
            function done() {
              clearTimeout(timer);
              job.nudge = null;
              resolve();
            }
            job.nudge = done;
            signal?.addEventListener('abort', done, { once: true });
          }),
          onProgress: progress => update(id, {
            receivedBytes: progress.receivedBytes,
            state: progress.retrying ? 'retrying' : 'uploading',
            paused: progress.retrying && Date.now() - progress.lastProgressAt >= PAUSED_AFTER_MS,
          }),
        });
      } catch (error) {
        if (!(error instanceof ChunkedUploadUnsupportedError)) throw error;
        path = await uploadInOneRequest(job.file);
      }
      update(id, { state: 'done', receivedBytes: job.file.size, paused: false });
      delivered.current(path);
      setTimeout(() => remove(id), DONE_VISIBLE_MS);
    } catch (error) {
      if (job.controller.signal.aborted) return;
      const message = error instanceof UploadRefusedError || error instanceof Error ? error.message : String(error);
      update(id, { state: 'failed', paused: false, error: message });
    }
  };

  /** Hosts from before chunked upload: the same single request desktop's upload button sends. */
  const uploadInOneRequest = async (file: PickedFile): Promise<string> => {
    if (file.size > SINGLE_REQUEST_MAX_BYTES) {
      throw new Error('This host takes files up to 12 MB. Update Pane on the host to send larger files.');
    }
    const dataUrl = `data:${file.mimeType};base64,${await file.read(0, file.size)}`;
    const result = file.isImage
      ? await invokeChannel<{ filePath: string }>(client, 'terminal:paste-image', ['', sessionId, dataUrl, file.mimeType])
      : await invokeChannel<{ filePath: string }>(client, 'terminal:paste-file', [sessionId, dataUrl, file.name]);
    return result.filePath;
  };

  const enqueue = (id: string) => {
    queue.current = queue.current.then(() => run(id));
  };

  const attach = async (source: AttachSource) => {
    setPickError(null);
    let files: PickedFile[];
    try {
      files = await pickFiles(source);
    } catch (error) {
      setPickError(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const file of files) {
      const id = createUploadId();
      jobs.current.set(id, { file, controller: new AbortController(), nudge: null });
      setReceipts(current => [...current, {
        id,
        name: file.name,
        uri: file.uri,
        isImage: file.isImage,
        totalBytes: file.size,
        receivedBytes: 0,
        state: 'queued',
        paused: false,
        error: null,
      }]);
      enqueue(id);
    }
  };

  const cancel = (id: string) => {
    jobs.current.get(id)?.controller.abort();
    remove(id);
  };

  const retry = (id: string) => {
    const job = jobs.current.get(id);
    if (!job) return;
    if (job.nudge) {
      // Waiting between attempts: try again now.
      job.nudge();
      return;
    }
    update(id, { state: 'queued', error: null });
    enqueue(id);
  };

  // Leaving the pane stops its uploads; the host deletes the partial files after a day.
  useEffect(() => {
    const running = jobs.current;
    return () => {
      for (const job of running.values()) job.controller.abort();
    };
  }, []);

  return { receipts, attach, cancel, retry, pickError, clearPickError: () => setPickError(null) };
}

function createUploadId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `mobile-${Array.from({ length: 20 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`;
}
