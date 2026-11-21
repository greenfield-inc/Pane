import { Suspense, lazy, memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { usePanelStore } from '../../../stores/panelStore';
import { panelApi } from '../../../services/panelApi';
import { PanelErrorBoundary } from '../PanelErrorBoundary';
import { reportShownTabs, type WatchedTab } from './browserWatch';
import { StreamedBrowserPanel } from './stream/StreamedBrowserPanel';
import { useRemoteRuntimeState } from '../../../hooks/useRemoteRuntimeState';

const BrowserPanel = lazy(() => import('./BrowserPanel'));

/** Main's event with the tabs whose pages stay alive (main/src/services/browser/browserHost.ts). */
const HELD_EVENT = 'browser-panel:held';
/** Main's event while a call runs on a tab: its hidden page paints, transparent, so captures are current. */
const BUSY_EVENT = 'browser-panel:busy';

/**
 * Where browser tabs' pages live (P4, D-126). A <webview> reloads its page whenever it moves in the
 * DOM or unmounts, so every browser tab's page renders here, in one layer that stays mounted across
 * tab and Pane switches. A tab's slot in its Pane only says where it is; the layer draws the page
 * over the slot when the tab is in view and hides it with CSS otherwise. A page mounts only while
 * its tab is in view or main holds it (an agent acted on it, or a screen showed it in the last 15
 * minutes), so tabs nobody uses cost nothing when hidden.
 */
interface Slot { panel: ToolPanel; element: HTMLElement; active: boolean }

const slots = new Map<string, Slot>();
const lastRects = new Map<string, { left: number; top: number; width: number; height: number }>();
/** The last panel seen for each page, so a held page stays mounted while its Pane's tabs reload. */
const lastPanels = new Map<string, ToolPanel>();
/** Held tabs whose Pane's tabs this window asked main for, so it asks once. */
const requested = new Set<string>();
let held: ReadonlyArray<{ panelId: string; sessionId?: string; painting?: boolean }> = [];
const busy = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A browser tab's place in its Pane. The layer draws its page there. */
export function BrowserSlot({ panel, isActive }: { panel: ToolPanel; isActive: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    slots.set(panel.id, { panel, element, active: isActive });
    changed();
    const observer = new ResizeObserver(changed);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (slots.get(panel.id)?.element === element) slots.delete(panel.id);
      changed();
    };
  }, [panel, isActive]);
  return <div ref={ref} className="h-full w-full" data-browser-slot={panel.id} />;
}

/** The pages of browser tabs in view or held, each over its tab's slot or hidden. */
export const BrowserLayer = memo(function BrowserLayer() {
  useSyncExternalStore(subscribe, () => version);
  const panelsBySession = usePanelStore(state => state.panels);
  const [, relayout] = useState(0);
  // On a desktop showing another computer's Pane, tabs stream from that computer (S3).
  const remote = useRemoteRuntimeState().connectionState.mode === 'remote';

  useEffect(() => {
    const onHeld = (event: Event) => {
      // SAFETY: preload dispatches this event with main's { tabs } payload.
      held = (event as CustomEvent<{ tabs: Array<{ panelId: string; sessionId?: string; painting?: boolean }> }>).detail.tabs;
      changed();
    };
    window.addEventListener(HELD_EVENT, onHeld);
    const onBusy = (event: Event) => {
      // SAFETY: preload dispatches this event with main's { panelId, busy } payload.
      const detail = (event as CustomEvent<{ panelId: string; busy: boolean }>).detail;
      const count = (busy.get(detail.panelId) ?? 0) + (detail.busy ? 1 : -1);
      if (count > 0) busy.set(detail.panelId, count);
      else busy.delete(detail.panelId);
      changed();
    };
    window.addEventListener(BUSY_EVENT, onBusy);
    // A page stays here while its Pane is out of view, and its tab's state keeps changing (the size
    // another screen gives it, its URL, who drives): take every browser tab's update, not only the
    // shown Pane's, or its view keeps a stale size and frames streamed from it come out cut off.
    const stopUpdates = window.electronAPI?.events?.onPanelUpdated(panel => {
      if (panel.type !== 'browser') return;
      usePanelStore.getState().updatePanelState(panel);
      if (lastPanels.has(panel.id)) lastPanels.set(panel.id, panel);
      changed();
    });
    const onResize = () => relayout(count => count + 1);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener(HELD_EVENT, onHeld);
      window.removeEventListener(BUSY_EVENT, onBusy);
      stopUpdates?.();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // A held tab this window doesn't have yet (its Pane's tabs never loaded, or the agent just opened
  // it in a Pane out of view): load that Pane's tabs once.
  useEffect(() => {
    for (const { panelId, sessionId } of held) {
      if (!sessionId || requested.has(panelId)) continue;
      if (panelsBySession[sessionId]?.some(panel => panel.id === panelId)) continue;
      requested.add(panelId);
      void panelApi.loadPanelsForSession(sessionId).then(panels => usePanelStore.getState().setPanels(sessionId, panels)).catch(() => requested.delete(panelId));
    }
  }, [panelsBySession, version]);

  const byId = new Map<string, ToolPanel>();
  for (const panels of Object.values(panelsBySession)) for (const panel of panels) if (panel.type === 'browser') byId.set(panel.id, panel);
  const ids = new Set([...slots.keys(), ...held.map(tab => tab.panelId)]);
  for (const id of lastPanels.keys()) if (!ids.has(id)) lastPanels.delete(id);
  // Another device streams these, so their pages keep drawing while hidden here.
  const streamed = new Set(held.filter(tab => tab.painting).map(tab => tab.panelId));
  const shown = new Map<string, WatchedTab>();
  // Main hears which tabs this window shows, so their pages outlive a switch away.
  useEffect(() => reportShownTabs(shown));

  return (
    <>
      {/* A fixed order: React never moves a page's element, which would reload its webview. */}
      {[...ids].sort().map(id => {
        const slot = slots.get(id);
        const panel = slot?.panel ?? byId.get(id) ?? lastPanels.get(id);
        if (!panel) return null;
        lastPanels.set(id, panel);
        // A slot inside something hidden (Settings over the Pane) is not on screen, whatever its tab says.
        const measured = slot?.active && slot.element.isConnected && slot.element.checkVisibility() ? slot.element.getBoundingClientRect() : undefined;
        const visible = measured !== undefined && measured.width > 0 && measured.height > 0;
        const rect = visible ? { left: measured.left, top: measured.top, width: measured.width, height: measured.height } : lastRects.get(id) ?? { left: 0, top: 0, width: 1280, height: 800 };
        lastRects.set(id, rect);
        // A desktop showing another computer's Pane reports from the stream itself (StreamedBrowserPanel).
        // A tab this computer's own agents hold is this computer's page, even while it shows another computer.
        const fromHost = remote && !held.some(tab => tab.panelId === id);
        if (visible && !fromHost) shown.set(id, { width: rect.width, height: rect.height });
        // A hidden page is not drawn, and Chromium throttles it. While a call runs on it, or another
        // device streams it, it is drawn fully transparent under the tab in view, so its frames are current.
        const painting = visible || busy.has(id) || streamed.has(id);
        const style: CSSProperties = {
          position: 'fixed',
          ...rect,
          // Above the panel area it covers, below every popover, dropdown and dialog.
          zIndex: visible ? 1 : 0,
          visibility: painting ? 'visible' : 'hidden',
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
        };
        return (
          <div key={id} style={style} aria-hidden={!visible} inert={!visible ? true : undefined} data-browser-page={id} data-browser-page-visible={visible}>
            <PanelErrorBoundary panelId={panel.id}>
              <Suspense fallback={null}>
                {fromHost
                  ? <StreamedBrowserPanel panel={panel} isActive={visible} ownCopy={onViewLive => <BrowserPanel panel={panel} isActive={visible} onViewLive={onViewLive} />} />
                  : <BrowserPanel panel={panel} isActive={visible} />}
              </Suspense>
            </PanelErrorBoundary>
          </div>
        );
      })}
    </>
  );
});
