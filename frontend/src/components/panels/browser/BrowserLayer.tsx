import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { usePanelStore } from '../../../stores/panelStore';
import { panelApi } from '../../../services/panelApi';

const BrowserPanel = lazy(() => import('./BrowserPanel'));

/** Main's event with the tabs agents hold (main/src/services/browser/browserHost.ts). */
const HELD_EVENT = 'browser-panel:held';
/** Main's event while a call runs on a tab: its hidden page paints, transparent, so captures are current. */
const BUSY_EVENT = 'browser-panel:busy';

/**
 * Where browser tabs' pages live (P4, D-126). A <webview> reloads its page whenever it moves in the
 * DOM or unmounts, so every browser tab's page renders here, in one layer that stays mounted across
 * tab and Pane switches. A tab's slot in its Pane only says where it is; the layer draws the page
 * over the slot when the tab is in view and hides it with CSS otherwise. A page mounts only while
 * its tab is in view or an agent holds it, so tabs nobody drives cost nothing when hidden.
 */
interface Slot { panel: ToolPanel; element: HTMLElement; active: boolean }

const slots = new Map<string, Slot>();
const lastRects = new Map<string, { left: number; top: number; width: number; height: number }>();
let held: ReadonlyArray<{ panelId: string; sessionId?: string }> = [];
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
export function BrowserLayer() {
  useSyncExternalStore(subscribe, () => version);
  const panelsBySession = usePanelStore(state => state.panels);
  const [, relayout] = useState(0);

  useEffect(() => {
    const onHeld = (event: Event) => {
      // SAFETY: preload dispatches this event with main's { tabs } payload.
      held = (event as CustomEvent<{ tabs: Array<{ panelId: string; sessionId?: string }> }>).detail.tabs;
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
    const onResize = () => relayout(count => count + 1);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener(HELD_EVENT, onHeld);
      window.removeEventListener(BUSY_EVENT, onBusy);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // A held tab in a Pane this window has not loaded yet: load that Pane's tabs.
  useEffect(() => {
    for (const { sessionId } of held) {
      if (sessionId && !panelsBySession[sessionId]) {
        void panelApi.loadPanelsForSession(sessionId).then(panels => usePanelStore.getState().setPanels(sessionId, panels)).catch(() => undefined);
      }
    }
  }, [panelsBySession, version]);

  const byId = new Map<string, ToolPanel>();
  for (const panels of Object.values(panelsBySession)) for (const panel of panels) if (panel.type === 'browser') byId.set(panel.id, panel);
  const ids = new Set([...slots.keys(), ...held.map(tab => tab.panelId)]);

  return (
    <>
      {[...ids].map(id => {
        const slot = slots.get(id);
        const panel = slot?.panel ?? byId.get(id);
        if (!panel) return null;
        const visible = slot !== undefined && slot.active && slot.element.isConnected;
        const measured = visible ? slot.element.getBoundingClientRect() : undefined;
        const rect = measured && measured.width > 0 ? { left: measured.left, top: measured.top, width: measured.width, height: measured.height } : lastRects.get(id) ?? { left: 0, top: 0, width: 1280, height: 800 };
        lastRects.set(id, rect);
        // A hidden page is not drawn, and Chromium throttles it. While a call runs on it, it is drawn
        // fully transparent under the tab in view, so its screenshots are current.
        const painting = visible || busy.has(id);
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
            <Suspense fallback={null}>
              <BrowserPanel panel={panel} isActive={visible} />
            </Suspense>
          </div>
        );
      })}
    </>
  );
}
