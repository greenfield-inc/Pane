import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceTabClient } from './deviceClient';

/** Frames over a connection: about twice a second (phones, the browser app, a remote desktop). */
export const FRAME_POLL_MS = 500;
/** The least time between reads, so a burst of input asks for a frame at most this often. */
const READ_GAP_MS = 100;

/**
 * The device's latest frame as a data URL, read every `everyMs` while the page is visible (off
 * when undefined), no larger than `maxPx` on its longest side. One read is on its way at a time,
 * so frames never arrive faster than the link carries them. The second value reads a frame now
 * (or right after the one on its way), so the person sees an input land without waiting for the next tick.
 */
export function useDeviceFrames(client: DeviceTabClient, panelId: string, everyMs: number | undefined, maxPx?: number): [string | undefined, () => void] {
  const [frame, setFrame] = useState<string>();
  const readNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (everyMs === undefined) return;
    let cancelled = false;
    let timer: number | undefined;
    let reading = false;
    let again = false;
    let lastRead = 0;
    const tick = async () => {
      window.clearTimeout(timer);
      reading = true;
      lastRead = performance.now();
      if (document.visibilityState === 'visible') {
        const next = await client.frame(panelId, maxPx).catch(() => undefined);
        if (cancelled) return;
        if (next) setFrame(next);
      }
      reading = false;
      if (again) {
        again = false;
        void tick();
        return;
      }
      timer = window.setTimeout(() => { void tick(); }, everyMs);
    };
    readNow.current = () => {
      if (reading) {
        again = true;
        return;
      }
      const wait = READ_GAP_MS - (performance.now() - lastRead);
      window.clearTimeout(timer);
      if (wait <= 0) void tick();
      else timer = window.setTimeout(() => { void tick(); }, wait);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      readNow.current = () => undefined;
    };
  }, [client, panelId, everyMs, maxPx]);
  return [frame, useCallback(() => readNow.current(), [])];
}
