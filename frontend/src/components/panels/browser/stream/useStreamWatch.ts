import { useEffect, type RefObject } from 'react';
import { VIEWER_ID } from '../browserWatch';
import type { JsonValue } from '../../../../../../shared/validation/boundaryDecoder';

/** How often a screen repeats that it shows a tab; the host forgets one silent for 15 s. */
const WATCH_EVERY_MS = 5_000;

type Invoke = (channel: string, ...args: Array<string | null | { kind: string; onScreen: boolean; width: number; height: number; scale: number }>) => Promise<JsonValue>;

/**
 * Tells the tab's host this screen shows it (`browser:watch`) every 5 s and when it changes size
 * or visibility, with the room its stream gives the page (the element marked data-testid
 * "browser-stream" inside `rootRef`), and that it stopped when unmounted.
 */
export function useStreamWatch(invoke: Invoke, panelId: string, kind: 'desktop' | 'phone' | 'web', rootRef: RefObject<HTMLElement | null>, on = true): void {
  useEffect(() => {
    if (!on) return;
    const box = () => rootRef.current?.querySelector('[data-testid="browser-stream"]');
    const report = () => {
      const rect = box()?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      void invoke('browser:watch', panelId, VIEWER_ID, { kind, onScreen: document.visibilityState === 'visible', width: Math.round(rect.width), height: Math.round(rect.height), scale: window.devicePixelRatio || 1 }).catch(() => undefined);
    };
    report();
    const timer = window.setInterval(report, WATCH_EVERY_MS);
    document.addEventListener('visibilitychange', report);
    const observer = new ResizeObserver(report);
    const element = box();
    if (element) observer.observe(element);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', report);
      observer.disconnect();
      void invoke('browser:watch', panelId, VIEWER_ID, null).catch(() => undefined);
    };
  }, [invoke, panelId, kind, rootRef, on]);
}
