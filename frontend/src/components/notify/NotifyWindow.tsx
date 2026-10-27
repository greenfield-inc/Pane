import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { DEFAULT_APPEARANCE, resolveAppearanceTheme, themeBase, THEME_CLASSES } from '../../../../shared/types/appearance';
import { readAppearanceCache } from '../../utils/appearanceCache';
import { runNotify, subscribeNotify, useNotifyStore } from '../../stores/notifyStore';
import { cn } from '../../utils/cn';
import { NotifyStrip } from './NotifyStrip';
import { NotifyRound } from './NotifyRound';

/**
 * The floating Notify windows: `notify.html?view=strip` (always on top, never
 * takes focus until a text field asks) and `notify.html?view=round[&id=...]`
 * (Answer all, takes focus). Main sizes each window to the card it reports.
 */

/** Room around the card for its shadow; included in the size sent to main. */
const SHADOW_PADDING = 32;

const ALL_THEME_CLASSES = [...new Set(Object.values(THEME_CLASSES).flat())];

/** The same theme the main window shows: main passes its appearance in argv, as it does there. */
function applyTheme(prefersDark: boolean): void {
  const appearance = window.electronAPI?.appearanceSnapshot ?? readAppearanceCache() ?? DEFAULT_APPEARANCE;
  const theme = resolveAppearanceTheme(appearance, prefersDark);
  for (const element of [document.documentElement, document.body]) {
    element.classList.remove(...ALL_THEME_CLASSES);
    element.classList.add(...THEME_CLASSES[theme]);
    element.classList.toggle('high-contrast', localStorage.getItem('high-contrast') === 'true');
    // The window is transparent; the card draws its own background and shadow.
    element.style.setProperty('background', 'transparent', 'important');
  }
  document.documentElement.style.colorScheme = themeBase(theme);
}

function watchTheme(): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  applyTheme(query.matches);
  const refresh = () => applyTheme(query.matches);
  query.addEventListener('change', refresh);
  const unsubscribe = window.electronAPI?.events?.onNativeAppearanceUpdated?.(({ prefersDark }) => applyTheme(prefersDark));
  return () => {
    query.removeEventListener('change', refresh);
    unsubscribe?.();
  };
}

/** Reports the card's outer box (plus the open menu, plus shadow room) whenever it changes. */
function useReportSize(rootRef: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let last = '';
    const measure = () => {
      const boxes = Array.from(root.querySelectorAll('[data-testid="notify-card"], [data-testid="notify-round"], [data-notify-menu]'))
        .map((element) => element.getBoundingClientRect());
      if (boxes.length === 0) return;
      const left = Math.min(...boxes.map((box) => box.left));
      const top = Math.min(...boxes.map((box) => box.top));
      const right = Math.max(...boxes.map((box) => box.right));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      const size = {
        width: Math.ceil(right - left + SHADOW_PADDING * 2),
        height: Math.ceil(bottom - top + SHADOW_PADDING * 2),
      };
      const key = `${size.width}x${size.height}`;
      if (key === last) return;
      last = key;
      window.electronAPI.notify.resizeWindow(size);
    };
    const resizeObserver = new ResizeObserver(measure);
    const observeAll = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(root);
      root.querySelectorAll('[data-testid="notify-card"], [data-testid="notify-round"], [data-notify-menu]')
        .forEach((element) => resizeObserver.observe(element));
    };
    const mutationObserver = new MutationObserver(() => {
      observeAll();
      measure();
    });
    mutationObserver.observe(root, { childList: true, subtree: true });
    observeAll();
    measure();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [rootRef]);
}

export function NotifyWindow({ view, startId }: { view: 'strip' | 'round'; startId?: string }) {
  const snapshot = useNotifyStore((state) => state.snapshot);
  const rootRef = useRef<HTMLDivElement>(null);
  // Before the first paint, so the card never shows in the wrong theme.
  useLayoutEffect(() => watchTheme(), []);
  useEffect(() => subscribeNotify(), []);
  useReportSize(rootRef);

  const position = snapshot?.settings.position ?? 'bottom-center';
  const atTop = position === 'top-right';
  return (
    <div
      ref={rootRef}
      style={{ padding: SHADOW_PADDING }}
      className={cn(
        // Cards keep their natural height so the window can grow to fit them instead of clipping.
        'fixed inset-0 flex flex-col [&>*]:shrink-0',
        view === 'round' ? 'items-center justify-start'
          : cn(atTop ? 'justify-start' : 'justify-end', position === 'bottom-center' ? 'items-center' : 'items-end'),
      )}
    >
      {snapshot && view === 'round' && <NotifyRound snapshot={snapshot} startId={startId} onCommand={runNotify} />}
      {snapshot && view === 'strip' && snapshot.stripSurface === 'window' && (
        <NotifyStrip
          snapshot={snapshot}
          narrow={atTop}
          menuPlacement={atTop ? 'below' : 'above'}
          onFieldFocusRequest={() => window.electronAPI.notify.focusWindow()}
        />
      )}
    </div>
  );
}
