import { useEffect, useState } from 'react';
import { MousePointer2 } from 'lucide-react';
import type { DeviceDriver } from '../../../../../shared/types/devices';
import { cn } from '../../../utils/cn';
import { DriverChip } from '../device/DeviceToolViews';

/** Main's event with where an agent clicked in a tab (main/src/services/browser/browserHost.ts). */
const AGENT_CURSOR_EVENT = 'browser-panel:agent-cursor';
/** How long the agent's cursor stays at a click before it fades. */
const CURSOR_SHOWN_MS = 1_200;

/** Who drives a browser tab, in its address bar, with Take over and Hand to agent (D-100's chip). */
export function BrowserDriverChip({ panelId, driver }: { panelId: string; driver: DeviceDriver | undefined }) {
  const set = (who: 'person' | 'agent') => { void window.electronAPI?.invoke('browser-panel:driver', panelId, who); };
  if (!driver) return null;
  return (
    <span className="flex min-w-0 max-w-[45%] flex-shrink text-xs">
      <DriverChip driver={driver} onTakeOver={() => set('person')} onHandBack={() => set('agent')} />
    </span>
  );
}

/** The outline while an agent drives the page, and its cursor where it last clicked. Never takes input. */
export function AgentOverlay({ panelId, driver }: { panelId: string; driver: DeviceDriver | undefined }) {
  const [cursor, setCursor] = useState<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const onCursor = (event: Event) => {
      // SAFETY: preload dispatches this event with main's { panelId, x, y } payload.
      const detail = (event as CustomEvent<{ panelId: string; x: number; y: number }>).detail;
      if (detail.panelId === panelId) setCursor({ x: detail.x, y: detail.y, at: Date.now() });
    };
    window.addEventListener(AGENT_CURSOR_EVENT, onCursor);
    return () => window.removeEventListener(AGENT_CURSOR_EVENT, onCursor);
  }, [panelId]);
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!cursor) return;
    const timer = setTimeout(() => rerender(count => count + 1), CURSOR_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [cursor]);
  const agentDriving = driver?.by === 'agent';
  const cursorShown = cursor !== null && agentDriving && Date.now() - cursor.at < CURSOR_SHOWN_MS;
  return (
    <div className={cn('pointer-events-none absolute inset-0 z-20 border-2 transition-colors duration-200', agentDriving ? 'border-interactive' : 'border-transparent')} data-testid="browser-agent-overlay" data-driving={agentDriving ? 'agent' : driver?.by ?? 'none'}>
      {cursor && (
        <MousePointer2
          className={cn('absolute h-5 w-5 fill-interactive text-text-on-interactive drop-shadow transition-opacity duration-200', cursorShown ? 'opacity-100' : 'opacity-0')}
          style={{ left: cursor.x, top: cursor.y }}
          data-testid="browser-agent-cursor"
        />
      )}
    </div>
  );
}
