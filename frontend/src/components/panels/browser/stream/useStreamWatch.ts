import { useEffect, type RefObject } from 'react';
import { VIEWER_ID } from '../browserWatch';
import { usePageVisible } from './usePageVisible';
import type { JsonValue } from '../../../../../../shared/validation/boundaryDecoder';

/** How often a screen repeats that it shows a tab; the host forgets one silent for 15 s. */
const WATCH_EVERY_MS = 5_000;

type Invoke = (channel: string, ...args: Array<string | null | { kind: string; onScreen: boolean; width: number; height: number; scale: number }>) => Promise<JsonValue>;

/**
 * Tells the tab's host this screen shows it (`browser:watch`) every 5 s and when it changes size,
 * with the room its stream gives the page (the element marked data-testid "browser-stream" inside
 * `rootRef`), and that it stopped when unmounted or hidden. Hidden, it reports nothing.
 */
export function useStreamWatch(invoke: Invoke, panelId: string, kind: 'desktop' | 'phone' | 'web', rootRef: RefObject<HTMLElement | null>, on = true): void {
  const visible = usePageVisible();
  const live = on && visible;
  useEffect(() => {
    if (!live) return;
    const box = () => rootRef.current?.querySelector('[data-testid="browser-stream"]');
    // The room before a phone's keyboard opened: the keyboard shrinks the stream's box, and the
    // host's page must not reflow to it.
    let steady: { width: number; height: number } | undefined;
    const typing = () => {
      const active = document.activeElement;
      return kind !== 'desktop' && active instanceof HTMLElement && rootRef.current?.contains(active) === true && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    };
    const report = () => {
      const rect = box()?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      let size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      // A rotation changes the width too: that size is the new room.
      if (typing() && steady?.width === size.width) size = steady;
      else steady = size;
      void invoke('browser:watch', panelId, VIEWER_ID, { kind, onScreen: true, ...size, scale: window.devicePixelRatio || 1 }).catch(() => undefined);
    };
    report();
    const timer = window.setInterval(report, WATCH_EVERY_MS);
    const observer = new ResizeObserver(report);
    const element = box();
    if (element) observer.observe(element);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
      void invoke('browser:watch', panelId, VIEWER_ID, null).catch(() => undefined);
    };
  }, [invoke, panelId, kind, rootRef, live]);
}
