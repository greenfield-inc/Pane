import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { DeviceOpenMarker } from '../../../../shared/types/devices';
import { useDeviceTab } from './useDeviceTab';
import { openPaneTarget } from '../terminal/openPaneLink';
import { cn } from '../../utils/cn';

/** About one frame a second while the card is on screen (journey 3). */
const FRAME_MS = 1_000;

/**
 * The card at a chat's device_open step (option 2 of the D-71 mockups): a phone-shaped thumbnail
 * like an image the agent sent, with a Live badge while the device runs and Closed after. It
 * refreshes about once a second while on screen, and clicking it focuses the device tab.
 */
export function DeviceCard({ marker }: { marker: DeviceOpenMarker }) {
  const { paneId, state } = useDeviceTab(marker.panelId);
  const live = state?.phase === 'live';
  const [frame, setFrame] = useState<string>();
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

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
    const load = async () => {
      const response = await window.electronAPI.devices.frame(marker.panelId).catch(() => undefined);
      if (!cancelled && response?.success && response.data) setFrame(response.data);
    };
    void load();
    if (!live) return () => { cancelled = true; };
    const timer = window.setInterval(() => { void load(); }, FRAME_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [marker.panelId, visible, live]);

  const open = () => { if (paneId) void openPaneTarget({ paneId, panelId: marker.panelId }); };

  return (
    <button
      ref={ref}
      type="button"
      onClick={open}
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
