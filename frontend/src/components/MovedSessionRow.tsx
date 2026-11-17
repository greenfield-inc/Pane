import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { SessionMoveMark } from '../../../shared/types/sessionMove';
import { moveMarkLabel, movedBannerLine, restoreHereWarning } from '../utils/sessionMoveView';
import { machineIdNamed, openSessionOnMachineNamed } from '../utils/sessionMoveOpen';
import { Button } from './ui/Button';

/**
 * An archived Session that moved to another machine (state 7): "Moved to <machine>" in the
 * archived list. Selecting it shows its read-only banner, with Open it there and Restore here,
 * which restores the Session as any archived one, after saying when that is safe.
 */
export function MovedSessionRow({ session, mark, onRestore }: {
  session: OrchestrationSessionRecord;
  mark: SessionMoveMark;
  onRestore: (sessionId: string) => Promise<void>;
}) {
  const bannerId = useId();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const name = session.name || 'Untitled';
  const reachable = machineIdNamed(mark.machine) !== undefined;
  return (
    <div data-testid={`archived-orchestration-session-${session.id}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bannerId}
        onClick={() => { setOpen(!open); setConfirming(false); }}
        className="flex w-full items-center gap-2 pl-8 pr-3 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-interactive"
      >
        <ArrowRight aria-hidden="true" className="h-3 w-3 flex-shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">{name}</span>
        <span data-testid="session-move-label" className="max-w-[55%] flex-shrink-0 truncate text-[10px] text-text-muted">{moveMarkLabel(mark)}</span>
      </button>
      {open && (
        <div id={bannerId} role="region" aria-label={`${name} moved`} data-testid="moved-session-banner" className="mx-3 mb-1.5 rounded-md border border-border-primary bg-surface-primary px-2.5 py-2 text-xs text-text-secondary">
          <p className="text-text-primary">{movedBannerLine(mark)} It is read-only here.</p>
          {confirming ? (
            <>
              <p className="mt-1.5">{restoreHereWarning(mark.machine)}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant="warning" className="h-6 px-2 text-xs" loading={restoring} onClick={() => {
                  setRestoring(true);
                  void onRestore(session.id).finally(() => setRestoring(false));
                }}>Restore here</Button>
                <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={restoring} onClick={() => setConfirming(false)}>Keep it archived</Button>
              </div>
            </>
          ) : (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5">
              <button
                type="button"
                disabled={!reachable}
                title={reachable ? undefined : `This computer has no saved connection to ${mark.machine}. Add it in Settings → Remote Access, or open Pane on ${mark.machine}.`}
                onClick={() => openSessionOnMachineNamed(mark.machine, { id: session.id, name })}
                className="font-medium text-interactive hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
              >
                Open it there
              </button>
              <span aria-hidden="true" className="text-text-muted">·</span>
              <button type="button" onClick={() => setConfirming(true)} className="font-medium text-interactive hover:underline">Restore here</button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
