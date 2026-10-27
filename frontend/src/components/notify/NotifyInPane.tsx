import { useNavigationStore } from '../../stores/navigationStore';
import { notifyItem, runNotify, useNotifyStore } from '../../stores/notifyStore';
import { NotifyCard } from './NotifyCard';
import { NotifyStrip } from './NotifyStrip';

/**
 * The strip while Pane is in front: bottom center of the main area, over the
 * terminal and never over the sidebar. `left` is the sidebar's width.
 */
export function NotifyInPaneStrip({ left }: { left: number }) {
  const snapshot = useNotifyStore((state) => state.snapshot);
  const onInbox = useNavigationStore((state) => state.activeView === 'notify');
  if (!snapshot || snapshot.stripSurface !== 'pane' || !snapshot.strip) return null;
  // The inbox already lists every waiting question with the same answers.
  if (onInbox && snapshot.strip.kind === 'question') return null;
  // The docked card already shows this question in its terminal.
  if (snapshot.strip.itemId === snapshot.dockedItemId) return null;
  return (
    <div
      className="pointer-events-none absolute bottom-[18px] right-0 z-30 flex justify-center px-4"
      style={{ left }}
      data-testid="notify-in-pane-strip"
    >
      <div className="pointer-events-auto max-w-full">
        <NotifyStrip snapshot={snapshot} menuPlacement="above" className="max-w-full" />
      </div>
    </div>
  );
}

/** Open in Pane: the question docked, expanded, at the bottom of the terminal that asked it. */
export function NotifyDock({ panelId }: { panelId: string }) {
  const item = useNotifyStore((state) => {
    const docked = notifyItem(state.snapshot, state.snapshot?.dockedItemId);
    return docked?.source.panelId === panelId ? docked : undefined;
  });
  if (!item || (item.state !== 'waiting' && item.state !== 'sent' && item.state !== 'expired')) return null;
  const view = item.state === 'waiting' ? 'question' : item.state;
  return (
    <div className="absolute inset-x-4 bottom-4 z-20 flex justify-center" data-testid="notify-dock">
      <NotifyCard item={item} view={view} form="docked" menuPlacement="above" onCommand={runNotify} />
    </div>
  );
}
