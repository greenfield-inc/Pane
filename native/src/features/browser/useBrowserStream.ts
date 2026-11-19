import { useEffect, useRef, useState } from 'react';

import type { BrowserFrame, BrowserInput, BrowserInputResult, BrowserTabView } from '@shared/types/browserStream';
import { decodeBoundary } from '@shared/validation/boundaryDecoder';
import { browserFrameAnswerSchema, browserInputResultSchema, browserTabViewSchema } from '@shared/validation/browserStreamSchemas';

import { invokeChannel, useDaemon } from '@/daemon';

import { isOlderHost, VIEWER_ID, type StreamStop } from './browserStream';

type DaemonClient = ReturnType<typeof useDaemon>['client'];

/** Retries after a failed read back off from 500 ms to 5 s. */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5_000;
/** How often a screen repeats that it still shows a tab; the host forgets one silent for 15 s. */
const WATCH_EVERY_MS = 5_000;
/**
 * A frame read the host leaves unanswered this long means it can't be reached: the host answers
 * within about a second even with nothing new, while a reconnecting link holds reads.
 */
const FRAME_DEADLINE_MS = 5_000;

/** Rejects when `work` takes longer than `ms`; the late answer is dropped. */
function within<Value>(work: Promise<Value>, ms: number): Promise<Value> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The host did not answer in time.')), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export interface BrowserStream {
  frame?: BrowserFrame;
  view?: BrowserTabView;
  stop?: StreamStop;
  /** When the page was found reloaded on the host (it slept, or Pane there restarted). */
  reloadedAt?: number;
}

/** The host's browser channels, called as this phone. */
export function browserChannels(client: DaemonClient) {
  return {
    input: async (panelId: string, batch: BrowserInput[]): Promise<BrowserInputResult> =>
      decodeBoundary(await invokeChannel(client, 'browser:input', [panelId, VIEWER_ID, batch]), browserInputResultSchema),
    driver: (panelId: string, who: 'person' | 'agent') => invokeChannel(client, 'browser:driver', [panelId, who, VIEWER_ID]),
  };
}

/**
 * A browser tab streamed from its host while `on` (the tab shown and the app active): the newest
 * frame, one read on its way at a time, and the tab's state. It reports the stream's `space` to
 * the host every 5 s and says when it stops. A failed read keeps the last frame and says why.
 */
export function useBrowserStream(panelId: string, on: boolean, space: { width: number; height: number; scale: number } | undefined): BrowserStream & { wake(): void } {
  const { client } = useDaemon();
  const [stream, setStream] = useState<BrowserStream>({});
  const wakeRef = useRef<() => void>(() => undefined);
  // Bumped by a wake, so the watch report goes again at once and the host remounts the page.
  const [wakes, setWakes] = useState(0);

  const width = space ? Math.round(space.width) : 0;
  const height = space ? Math.round(space.height) : 0;
  const scale = space?.scale ?? 1;
  useEffect(() => {
    if (!on || width <= 0 || height <= 0) return;
    const report = () => { void invokeChannel(client, 'browser:watch', [panelId, VIEWER_ID, { kind: 'phone', onScreen: true, width, height, scale }]).catch(() => undefined); };
    report();
    const timer = setInterval(report, WATCH_EVERY_MS);
    return () => {
      clearInterval(timer);
      void invokeChannel(client, 'browser:watch', [panelId, VIEWER_ID, null]).catch(() => undefined);
    };
  }, [client, panelId, on, width, height, scale, wakes]);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let seq = 0;
    let version = 0;
    let page: string | undefined;
    let frameRetry = RETRY_MIN_MS;
    let viewRetry = RETRY_MIN_MS;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sleep = (ms: number) => new Promise<void>(resolve => {
      const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
      timers.add(timer);
    });
    const frames = async () => {
      while (!cancelled) {
        try {
          const answer = decodeBoundary(await within(invokeChannel(client, 'browser:frame', [panelId, VIEWER_ID, seq]), FRAME_DEADLINE_MS), browserFrameAnswerSchema);
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
          const older = isOlderHost(cause);
          setStream(current => ({ ...current, stop: older ? 'older' : 'unreachable' }));
          if (older) return;
          await sleep(frameRetry);
          frameRetry = Math.min(frameRetry * 2, RETRY_MAX_MS);
        }
      }
    };
    const views = async () => {
      while (!cancelled) {
        try {
          const view = decodeBoundary(await invokeChannel(client, 'browser:view', [panelId, version]), browserTabViewSchema);
          if (cancelled) return;
          viewRetry = RETRY_MIN_MS;
          version = view.version;
          // A different page than before means the host loaded it again from its URL.
          const reloaded = page !== undefined && view.page !== undefined && view.page !== page;
          if (view.page !== undefined) page = view.page;
          setStream(current => (reloaded ? { ...current, view, reloadedAt: Date.now() } : { ...current, view }));
        } catch (cause) {
          if (cancelled) return;
          if (isOlderHost(cause)) { setStream(current => ({ ...current, stop: 'older' })); return; }
          await sleep(viewRetry);
          viewRetry = Math.min(viewRetry * 2, RETRY_MAX_MS);
        }
      }
    };
    wakeRef.current = () => {
      seq = 0;
      setStream(current => ({ ...current, stop: undefined }));
    };
    void frames();
    void views();
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      wakeRef.current = () => undefined;
    };
  }, [client, panelId, on]);

  return { ...stream, wake: () => { setWakes(count => count + 1); wakeRef.current(); } };
}
