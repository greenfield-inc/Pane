import { useCallback, useEffect, useState } from 'react';
import { runNotify, useNotifyStore } from '../../stores/notifyStore';
import { cn } from '../../utils/cn';
import { CloseButton } from '../notify/NotifyCard';
import { cardTitle, isHealthCard, KIND_ICON, reviewHealthCard, type HealthNotifyItem } from './healthCardActions';

/** At most this many popups stack in the corner; the rest wait in Approvals. */
const MAX_SHOWN = 3;

/**
 * Inside the Pane window, a waiting machine health card shows as a small popup in the
 * bottom-left corner that never takes focus. A warning hides after Notify's update time
 * (paused while the pointer is over it); a critical card is tinted red and stays until
 * dismissed or resolved. Either way the card keeps waiting in Approvals, with every choice.
 */
export function HealthCardPopups({ suppressed }: { suppressed: boolean }) {
  const snapshot = useNotifyStore(state => state.snapshot);
  const [timedOut, setTimedOut] = useState<ReadonlySet<string>>(new Set());
  const hide = useCallback((id: string) => setTimedOut(previous => new Set([...previous, id])), []);
  // Dismissed or snoozed cards are in `hidden`, as on Notify's strip.
  const hidden = new Set(snapshot?.hidden);
  const cards = (snapshot?.items ?? [])
    .filter((item): item is HealthNotifyItem => isHealthCard(item) && item.state === 'waiting' && !item.unreachable && !item.dismissedAt
      && !hidden.has(item.id) && !timedOut.has(item.id))
    // Critical first, then the newest.
    .sort((a, b) => Number(b.machineHealth.level === 'critical') - Number(a.machineHealth.level === 'critical') || b.createdAt - a.createdAt)
    .slice(0, MAX_SHOWN);
  if (suppressed || !snapshot || cards.length === 0) return null;
  return <PopupStack cards={cards} hideAfterMs={snapshot.settings.updatesHideAfterSeconds * 1000} onTimeout={hide} />;
}

/** Mounted only while popups show, so a hover never outlives the stack it was on. */
function PopupStack({ cards, hideAfterMs, onTimeout }: { cards: HealthNotifyItem[]; hideAfterMs: number; onTimeout: (id: string) => void }) {
  // Over the stack, nothing hides, so a popup never moves out from under the pointer.
  const [hovering, setHovering] = useState(false);
  return (
    <div
      className="fixed bottom-4 left-4 z-fixed flex w-[360px] max-w-[calc(100vw-2rem)] flex-col-reverse gap-2"
      data-testid="health-popups"
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      {cards.map(card => (
        <HealthPopup key={card.id} card={card} hideAfterMs={hideAfterMs} held={hovering} onTimeout={onTimeout} />
      ))}
    </div>
  );
}

function HealthPopup({ card, hideAfterMs, held, onTimeout }: { card: HealthNotifyItem; hideAfterMs: number; held: boolean; onTimeout: (id: string) => void }) {
  const critical = card.machineHealth.level === 'critical';
  useEffect(() => {
    if (critical || held) return;
    const timer = window.setTimeout(() => onTimeout(card.id), hideAfterMs);
    return () => window.clearTimeout(timer);
  }, [critical, held, hideAfterMs, onTimeout, card.id]);
  const Icon = KIND_ICON[card.machineHealth.kind];
  return (
    <div
      role={critical ? 'alert' : 'status'}
      aria-label={cardTitle(card)}
      data-testid="health-popup"
      data-level={card.machineHealth.level}
      // The opaque surface under the tint keeps text readable over whatever the corner covers.
      className={cn('overflow-hidden rounded-[18px] bg-surface-primary shadow-modal ring-1', critical ? 'ring-status-error/40' : 'ring-border-secondary')}
    >
      <div className={cn('flex gap-3 p-3.5', critical && 'bg-status-error/10')}>
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          critical ? 'bg-status-error/15 text-status-error' : 'bg-status-warning/15 text-status-warning')}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className={cn('min-w-0 flex-1 pt-1 text-[14px] font-semibold leading-snug', critical ? 'text-status-error-on-tint' : 'text-text-primary')}>{cardTitle(card)}</div>
            <CloseButton item={card} onCommand={runNotify} />
          </div>
          {card.context && <p className="mt-1 line-clamp-4 text-[13px] leading-snug text-text-secondary">{card.context}</p>}
          <div className="mt-2.5 flex">
            <button
              type="button"
              onClick={() => void reviewHealthCard(card)}
              className="h-[30px] rounded-[10px] bg-surface-tertiary px-3 text-[12.5px] font-medium text-text-primary hover:bg-surface-hover"
            >
              Open Resources
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
