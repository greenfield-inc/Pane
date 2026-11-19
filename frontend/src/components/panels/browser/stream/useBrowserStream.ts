import { useEffect, useRef, useState } from 'react';
import type { BrowserFrame, BrowserTabView } from '../../../../../../shared/types/browserStream';
import { isOlderHost, type BrowserStreamClient } from './streamClient';

/** Why the stream shows no live frames: the host can't be reached, has no stream, or the tab sleeps or went. */
export type StreamStop = 'unreachable' | 'older' | 'asleep' | 'gone';

export interface BrowserStream {
  frame?: BrowserFrame;
  view?: BrowserTabView;
  stop?: StreamStop;
  /** When the page was found reloaded on the host (it slept, or Pane there restarted). */
  reloadedAt?: number;
}

/** Retries after a failed read back off from 500 ms to 5 s. */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5_000;
/**
 * A frame read the host leaves unanswered this long means the host can't be reached: the host
 * answers within about a second even with nothing new, while a connection that is reconnecting
 * holds reads instead of failing them.
 */
const FRAME_DEADLINE_MS = 5_000;

/** Rejects when `work` takes longer than `ms`; the late answer is dropped. */
function within<Value>(work: Promise<Value>, ms: number): Promise<Value> {
  work.catch(() => undefined);
  let timer: number | undefined;
  const late = new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('The host did not answer in time.')), ms); });
  return Promise.race([work, late]).finally(() => window.clearTimeout(timer));
}

/**
 * A browser tab streamed from its host while `on`: the newest frame (one read on its way at a
 * time, so frames come as fast as the link carries them and a still page costs nothing) and the
 * tab's state. A failed read keeps the last frame and reports why.
 */
export function useBrowserStream(client: BrowserStreamClient, panelId: string, on: boolean): BrowserStream & { wake(): void } {
  const [stream, setStream] = useState<BrowserStream>({});
  const wakeRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let seq = 0;
    let version = 0;
    let page: string | undefined;
    let frameRetry = RETRY_MIN_MS;
    let viewRetry = RETRY_MIN_MS;
    let timer: number | undefined;
    const sleep = (ms: number) => new Promise<void>(resolve => { timer = window.setTimeout(resolve, ms); });
    const older = (error: Error | undefined) => error !== undefined && isOlderHost(error);
    const frames = async () => {
      while (!cancelled) {
        if (document.visibilityState !== 'visible') { await sleep(500); continue; }
        try {
          const answer = await within(client.frame(panelId, seq), FRAME_DEADLINE_MS);
          if (cancelled) return;
          frameRetry = RETRY_MIN_MS;
          if ('frame' in answer) {
            seq = answer.frame.seq;
            setStream(current => ({ ...current, frame: answer.frame, stop: undefined }));
          } else if ('stopped' in answer) {
            setStream(current => ({ ...current, stop: answer.stopped }));
            await sleep(2_000);
          } else {
            setStream(current => (current.stop === 'unreachable' ? { ...current, stop: undefined } : current));
          }
        } catch (cause) {
          if (cancelled) return;
          const error = cause instanceof Error ? cause : undefined;
          setStream(current => ({ ...current, stop: older(error) ? 'older' : 'unreachable' }));
          if (older(error)) return;
          await sleep(frameRetry);
          frameRetry = Math.min(frameRetry * 2, RETRY_MAX_MS);
        }
      }
    };
    const views = async () => {
      while (!cancelled) {
        try {
          const view = await client.view(panelId, version);
          if (cancelled) return;
          viewRetry = RETRY_MIN_MS;
          version = view.version;
          // A different page than before means the host loaded it again from its URL.
          const reloaded = page !== undefined && view.page !== undefined && view.page !== page;
          if (view.page !== undefined) page = view.page;
          setStream(current => (reloaded ? { ...current, view, reloadedAt: Date.now() } : { ...current, view }));
          // A closed tab answers at once: ask again in a while, not in a tight loop.
          if (view.stopped === 'gone') await sleep(2_000);
        } catch (cause) {
          if (cancelled) return;
          if (older(cause instanceof Error ? cause : undefined)) { setStream(current => ({ ...current, stop: 'older' })); return; }
          await sleep(viewRetry);
          viewRetry = Math.min(viewRetry * 2, RETRY_MAX_MS);
        }
      }
    };
    wakeRef.current = () => { seq = 0; setStream(current => ({ ...current, stop: undefined })); };
    void frames();
    void views();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      wakeRef.current = () => undefined;
    };
  }, [client, panelId, on]);
  return { ...stream, wake: () => wakeRef.current() };
}
