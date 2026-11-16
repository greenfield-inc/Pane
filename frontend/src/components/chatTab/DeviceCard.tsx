import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { DeviceOpenMarker, DevicePanelPhase } from '../../../../shared/types/devices';
import { cn } from '../../utils/cn';

/** About one frame a second while the card is on screen (journey 3). */
const FRAME_MS = 1_000;

/** What a chat client gives its device cards: the device tab's phase, its frames, and how to open it. */
export interface ChatDeviceActions {
  /** Device tabs this chat's agent opened; their cards show under the latest turn when no step carried one. */
  openedHere: readonly DeviceOpenMarker[];
  phase(panelId: string): DevicePanelPhase | undefined;
  frame(panelId: string): Promise<string | undefined>;
  open(panelId: string): void;
}

/**
 * The card at a chat's device_open step (option 2 of the D-71 mockups): a phone-shaped thumbnail
 * like an image the agent sent, with a Live badge while the device runs and Closed after. It
 * refreshes about once a second while on screen and the window is visible, and clicking it
 * focuses the device tab.
 */
export function DeviceCard({ marker, device }: { marker: DeviceOpenMarker; device: ChatDeviceActions }) {
  const live = device.phase(marker.panelId) === 'live';
  const [frame, setFrame] = useState<string>();
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const read = device.frame;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: number | undefined;
    // The next read waits for the last one, and none run while the window is hidden.
    const tick = async (first: boolean) => {
      if (first || document.visibilityState === 'visible') {
        const next = await read(marker.panelId).catch(() => undefined);
        if (cancelled) return;
        if (next) setFrame(next);
      }
      if (live) timer = window.setTimeout(() => { void tick(false); }, FRAME_MS);
    };
    void tick(true);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [marker.panelId, visible, live, read]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => device.open(marker.panelId)}
      className="chat-device-card relative mt-1 block overflow-hidden rounded-[22px] border-[5px] border-device-bezel bg-device-screen text-left"
      style={{ width: 132, aspectRatio: '402 / 874' }}
      aria-label={`Open ${marker.name}`}
      data-testid="chat-device-card"
      data-live={live}
    >
      {frame && <img src={frame} alt="" className={cn('h-full w-full object-cover', !live && 'opacity-50 grayscale')} />}
      <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-surface-primary px-2 py-0.5 text-[11px] text-text-primary shadow-sm">
        <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-status-success' : 'bg-status-neutral')} />
        {live ? 'Live' : 'Closed'}
        {live && <ExternalLink className="h-3 w-3" />}
      </span>
    </button>
  );
}
