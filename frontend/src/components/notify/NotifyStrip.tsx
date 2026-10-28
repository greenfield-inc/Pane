import type { NotifySnapshot } from '../../../../shared/types/notify';
import { isMac } from '../../utils/platformUtils';
import { notifyItem, runNotify } from '../../stores/notifyStore';
import { NotifyCard, type NotifyCardProps, type NotifyQueuePosition } from './NotifyCard';
import { shortcutLabel } from './notifyFormat';

interface NotifyStripProps {
  snapshot: NotifySnapshot;
  narrow?: boolean;
  menuPlacement: NotifyCardProps['menuPlacement'];
  onFieldFocusRequest?: () => Promise<void>;
  className?: string;
}

function queuePosition(snapshot: NotifySnapshot, id: string): NotifyQueuePosition | undefined {
  const index = snapshot.queue.indexOf(id);
  if (index < 0) return undefined;
  return {
    index: index + 1,
    total: snapshot.queue.length,
    next: notifyItem(snapshot, snapshot.queue[index + 1]),
  };
}

/** What main put on the strip, drawn by the shared card. Renders nothing when the strip is empty. */
export function NotifyStrip({ snapshot, narrow, menuPlacement, onFieldFocusRequest, className }: NotifyStripProps) {
  const strip = snapshot.strip;
  const item = notifyItem(snapshot, strip?.itemId);
  if (!strip || !item) return null;
  return (
    <NotifyCard
      item={item}
      view={strip.kind}
      form="strip"
      onCommand={runNotify}
      queue={queuePosition(snapshot, item.id)}
      shortcutHint={snapshot.firstRun ? shortcutLabel(snapshot.settings.shortcut, isMac()) : undefined}
      hideAt={strip.kind === 'info' ? strip.hideAt : undefined}
      hideAfterMs={snapshot.settings.updatesHideAfterSeconds * 1000}
      narrow={narrow}
      menuPlacement={menuPlacement}
      onFieldFocusRequest={onFieldFocusRequest}
      className={className}
      onOpenUrl={(url) => { void window.electronAPI.openExternal(url); }}
    />
  );
}
