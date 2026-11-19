/**
 * This window's reports to the computers whose browser tabs it shows (`browser:watch`, a host
 * channel): which tabs are on screen and the space each gives its page. A tab's page lives on its
 * Pane's host, which keeps it alive while any screen shows it and for 15 minutes after.
 */

/** This window, as one of the screens watching browser tabs. */
// randomUUID exists only in secure contexts; a web app opened over plain http still loads.
export const VIEWER_ID = globalThis.crypto?.randomUUID?.() ?? `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
/** How often a screen repeats that it still shows a tab; the host forgets one silent for 15 s. */
const WATCH_EVERY_MS = 5_000;

export interface WatchedTab { width: number; height: number }

const shown = new Map<string, WatchedTab>();
let timer: ReturnType<typeof setInterval> | undefined;

function send(panelId: string, tab: WatchedTab | null): void {
  const report = tab ? { kind: 'desktop', onScreen: document.visibilityState === 'visible', width: tab.width, height: tab.height, scale: window.devicePixelRatio || 1 } : null;
  void window.electronAPI?.invoke('browser:watch', panelId, VIEWER_ID, report)?.catch(() => undefined);
}

function resendAll(): void {
  for (const [panelId, tab] of shown) send(panelId, tab);
}

/** The tabs this window shows now, with their page's space. Reports what changed at once. */
export function reportShownTabs(now: ReadonlyMap<string, WatchedTab>): void {
  for (const [panelId] of shown) {
    if (now.has(panelId)) continue;
    shown.delete(panelId);
    send(panelId, null);
  }
  for (const [panelId, tab] of now) {
    const before = shown.get(panelId);
    if (before && Math.round(before.width) === Math.round(tab.width) && Math.round(before.height) === Math.round(tab.height)) continue;
    const rounded = { width: Math.round(tab.width), height: Math.round(tab.height) };
    shown.set(panelId, rounded);
    send(panelId, rounded);
  }
  if (shown.size > 0 && !timer) {
    timer = setInterval(resendAll, WATCH_EVERY_MS);
    document.addEventListener('visibilitychange', resendAll);
  } else if (shown.size === 0 && timer) {
    clearInterval(timer);
    timer = undefined;
    document.removeEventListener('visibilitychange', resendAll);
  }
}
