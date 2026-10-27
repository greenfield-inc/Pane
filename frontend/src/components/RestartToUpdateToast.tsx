import { useCallback, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Button, IconButton } from './ui/Button';
import { LiveRegion } from './ui/LiveRegion';
import { usePausableDismiss } from '../hooks/usePausableDismiss';
import { useSessionStore } from '../stores/sessionStore';
import {
  restartToUpdate,
  setRestartTonight,
  snoozeRestartToUpdate,
  useRestartToUpdateStore,
} from '../stores/restartToUpdateStore';
import { restartToUpdateToastCopy, restoredToastMessage, type RestartToUpdateToastView } from './restartToUpdateCopy';
import type { RestartToUpdateState, UpdateRestoreResult } from '../../../shared/types/updater';
import type { Session } from '../types/session';

// Bottom right of the main area, above terminals (z-fixed) and below modal dialogs (z-modal).
const TOAST_FRAME = 'fixed bottom-4 right-4 z-fixed w-[300px] max-w-[calc(100vw-2rem)] rounded-lg border border-border-primary bg-surface-primary text-text-primary shadow-dropdown';

/** Open (not archived) Panes across every project, as the sidebar lists them. */
function countOpenPanes(sessions: readonly Session[]): number {
  return sessions.filter(session => !session.archived && !session.isHidden && session.projectId != null).length;
}

function resolveView(
  state: RestartToUpdateState | null,
  pillToastOpen: boolean,
  paneCount: number,
): RestartToUpdateToastView | null {
  const version = state?.readyVersion;
  if (!state || !version) return null;
  if (pillToastOpen) {
    if (state.tonight) return { kind: 'tonight', version };
    if (state.busy) return { kind: 'busy', version, busy: state.busy };
    return { kind: 'clicked-idle', version, paneCount };
  }
  return state.idleToastDue ? { kind: 'idle', version, paneCount } : null;
}

/** The restart-to-update toast: the idle offer, the pill's states, and the notice after the restart. */
export function RestartToUpdateToast() {
  const state = useRestartToUpdateStore(store => store.state);
  const pillToastOpen = useRestartToUpdateStore(store => store.pillToastOpen);
  const restoreResult = useRestartToUpdateStore(store => store.restoreResult);
  const paneCount = useSessionStore(store => countOpenPanes(store.sessions));

  const view = restoreResult ? null : resolveView(state, pillToastOpen, paneCount);
  const copy = view ? restartToUpdateToastCopy(view) : null;
  const announcement = restoreResult
    ? restoredToastMessage(restoreResult)
    : copy ? `${copy.title}. ${copy.body}` : '';

  return (
    <>
      <LiveRegion>{announcement}</LiveRegion>
      {restoreResult && <RestoredToast result={restoreResult} />}
      {view && copy && <ActionToast view={view} title={copy.title} body={copy.body} note={copy.note} idleToastDue={state?.idleToastDue ?? false} />}
    </>
  );
}

interface ActionToastProps {
  view: RestartToUpdateToastView;
  title: string;
  body: string;
  note?: string;
  idleToastDue: boolean;
}

function ActionToast({ view, title, body, note, idleToastDue }: ActionToastProps) {
  const closePillToast = useRestartToUpdateStore(store => store.closePillToast);
  const [restarting, setRestarting] = useState(false);
  const fromPill = view.kind !== 'idle';

  const restart = async () => {
    setRestarting(true);
    await restartToUpdate(fromPill ? 'pill' : 'toast');
    // Still here means the restart failed; its error is already showing.
    setRestarting(false);
  };

  const later = () => {
    if (fromPill) closePillToast();
    // The pill only reopened what Later would have hidden, so hide the idle offer too.
    if (!fromPill || idleToastDue) void snoozeRestartToUpdate();
  };

  const setTonight = (enabled: boolean) => {
    closePillToast();
    void setRestartTonight(enabled);
  };

  return (
    <section
      aria-label={title}
      onKeyDown={event => { if (fromPill && event.key === 'Escape') closePillToast(); }}
      className={`${TOAST_FRAME} px-3.5 py-3`}
    >
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4 shrink-0 text-interactive" aria-hidden="true" />
        <h2 className="text-[13px] font-semibold">{title}</h2>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-text-secondary">{body}</p>
      {note && <p className="mt-1 text-[11px] leading-snug text-text-tertiary">{note}</p>}
      <div className="mt-3 flex items-center justify-end gap-1.5">
        {(view.kind === 'idle' || view.kind === 'clicked-idle') && (
          <Button size="sm" variant="ghost" disabled={restarting} onClick={() => setTonight(true)}>Tonight</Button>
        )}
        {view.kind === 'tonight' ? (
          <Button size="sm" variant="secondary" disabled={restarting} onClick={() => setTonight(false)}>Don&apos;t restart tonight</Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={restarting} onClick={later}>Later</Button>
        )}
        <Button size="sm" variant="primary" disabled={restarting} onClick={() => void restart()}>
          {view.kind === 'busy' ? 'Restart anyway' : 'Restart now'}
        </Button>
      </div>
    </section>
  );
}

function RestoredToast({ result }: { result: UpdateRestoreResult }) {
  const showRestoreResult = useRestartToUpdateStore(store => store.showRestoreResult);
  const dismiss = useCallback(() => showRestoreResult(null), [showRestoreResult]);
  const pauseHandlers = usePausableDismiss(dismiss, 8000);

  return (
    <section
      aria-label="Pane update"
      {...pauseHandlers}
      onKeyDown={event => { if (event.key === 'Escape') dismiss(); }}
      className={`${TOAST_FRAME} flex items-start gap-2 py-2.5 pl-3.5 pr-2`}
    >
      <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-interactive" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-secondary">{restoredToastMessage(result)}</p>
      <IconButton size="sm" variant="ghost" aria-label="Dismiss" onClick={dismiss} icon={<X className="h-3.5 w-3.5" />} />
    </section>
  );
}
