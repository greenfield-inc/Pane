import { useEffect, useRef, useState } from 'react';

import { useDaemon } from '@/daemon';

import { uploadToHost } from '@shared/chunkedUpload';
import { pickFiles, type AttachSource, type PickedFile } from './pickFiles';

/** After this long without the host confirming new bytes, the receipt reads "Paused, retrying". */
const PAUSED_AFTER_MS = 5 * 60 * 1000;
/** Done receipts stay up this long. */
const DONE_VISIBLE_MS = 4000;

type ReceiptState = 'queued' | 'uploading' | 'retrying' | 'failed' | 'done';

export interface UploadReceipt {
  id: string;
  name: string;
  uri: string;
  isImage: boolean;
  totalBytes: number;
  receivedBytes: number;
  /** Seconds until done at the recent speed, when known. */
  secondsLeft: number | null;
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
      const path = await uploadToHost({
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
          secondsLeft: progress.secondsLeft,
          state: progress.retrying ? 'retrying' : 'uploading',
          paused: progress.retrying && Date.now() - progress.lastProgressAt >= PAUSED_AFTER_MS,
        }),
      });
      update(id, { state: 'done', receivedBytes: job.file.size, paused: false });
      delivered.current(path);
      setTimeout(() => remove(id), DONE_VISIBLE_MS);
    } catch (error) {
      if (job.controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      update(id, { state: 'failed', paused: false, error: message });
    }
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
        secondsLeft: null,
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

  // Leaving the pane stops its uploads, and the host deletes their partial files.
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
