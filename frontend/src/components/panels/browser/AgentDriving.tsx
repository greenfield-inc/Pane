import { useEffect, useState } from 'react';
import { MousePointer2 } from 'lucide-react';
import type { DeviceDriver } from '../../../../../shared/types/devices';
import { cn } from '../../../utils/cn';
import { DriverChip } from '../device/DeviceToolViews';

/** Main's event with where an agent clicked in a tab (main/src/services/browser/browserHost.ts). */
const AGENT_CURSOR_EVENT = 'browser-panel:agent-cursor';
/** How long the agent's cursor stays at a click before it fades. */
const CURSOR_SHOWN_MS = 1_200;

/** Who drives a browser tab, floating over the top of its page, with Take over and Hand to agent (D-100's chip). */
function BrowserDriverChip({ panelId, driver, agentName }: { panelId: string; driver: DeviceDriver; agentName: string | undefined }) {
  const set = (who: 'person' | 'agent') => { void window.electronAPI?.invoke('browser:driver', panelId, who); };
  return (
    <div className="pointer-events-auto absolute left-1/2 top-2 max-w-[calc(100%-16px)] -translate-x-1/2 whitespace-nowrap rounded-full bg-surface-primary text-xs shadow-md" data-testid="browser-driver-chip">
      <DriverChip driver={driver} agentName={agentName} onTakeOver={() => set('person')} onHandBack={() => set('agent')} />
    </div>
  );
}

/** Who drives the page (chip, outline) and the agent's cursor where it last clicked. Only the chip takes input. */
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
  // The agent that drove last, so Hand to names it after the person takes over by touch.
  const [lastAgent, setLastAgent] = useState<string>();
  useEffect(() => { if (driver?.by === 'agent') setLastAgent(driver.agent); }, [driver]);
  const cursorShown = cursor !== null && agentDriving && Date.now() - cursor.at < CURSOR_SHOWN_MS;
  return (
    <div className={cn('pointer-events-none absolute inset-0 z-20 border-2 transition-colors duration-200', agentDriving ? 'border-interactive' : 'border-transparent')} data-testid="browser-agent-overlay" data-driving={agentDriving ? 'agent' : driver?.by ?? 'none'}>
      {driver && <BrowserDriverChip panelId={panelId} driver={driver} agentName={lastAgent} />}
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
