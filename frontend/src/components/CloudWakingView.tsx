import { useEffect, useState } from 'react';
import type { PaneCloudClone, PaneCloudCreateStep } from '../../../shared/types/paneCloud';
import { usePaneCloudStore, type PaneCloudWaking } from '../stores/paneCloudStore';
import { openNewCloudSession } from '../utils/openNewCloudSession';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { Button } from './ui/Button';
import { SessionActivityIcon } from './SessionActivity';

const STEP_TEXT = {
  creating: 'Starting the machine',
  pairing: 'Connecting',
  'starting-session': 'Starting the Session',
} satisfies Record<PaneCloudCreateStep, string>;

/** Minutes and seconds since Create, as `1:07`. */
function elapsed(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * A new cloud Session from Create until its first terminal (frame D2, D-104 and D-107): the machine
 * starting, then the repo's clone with git's own progress and the time so far. When the clone makes
 * the repo's Pane, the window opens it; a failed clone shows git's error with Retry.
 */
export function CloudWakingView({ waking }: { waking: PaneCloudWaking }) {
  const snapshot = usePaneCloudStore(state => state.snapshot);
  const session = waking.vmId ? snapshot.sessions.find(entry => entry.vmId === waking.vmId) : undefined;
  const clone: PaneCloudClone | null = session?.clone ?? null;
  const failed = waking.error !== null || clone?.state === 'failed';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (failed) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [failed]);

  // Created, and either the clone made its Pane or there was no repo to clone: open it like any machine's.
  const paneId = clone?.state === 'ready' ? clone.paneId : null;
  const repo = clone?.repo ?? null;
  const noRepo = session !== undefined && clone === null;
  const { machineId, sessionId, name } = waking;
  useEffect(() => {
    if (!machineId) return;
    const target = paneId ? { kind: 'pane' as const, id: paneId, name: repo ?? name } : noRepo && sessionId ? { kind: 'session' as const, id: sessionId, name } : null;
    if (!target) return;
    usePaneCloudStore.getState().setWaking(null);
    void openNewCloudSession(machineId, target);
  }, [machineId, sessionId, name, paneId, repo, noRepo]);

  // Opening anything else leaves the view; the new Session's row stays in the sidebar.
  useEffect(() => {
    const leave = () => usePaneCloudStore.getState().setWaking(null);
    const stopNavigation = useNavigationStore.subscribe((next, previous) => {
      if (next.activeView !== previous.activeView || next.activeProjectId !== previous.activeProjectId) leave();
    });
    const stopSessions = useSessionStore.subscribe((next, previous) => {
      if (next.activeSessionId !== previous.activeSessionId) leave();
    });
    return () => { stopNavigation(); stopSessions(); };
  }, []);

  const close = () => usePaneCloudStore.getState().setWaking(null);
  const status = clone ? `Cloning ${clone.repo}` : snapshot.creating ? STEP_TEXT[snapshot.creating.step] : STEP_TEXT.creating;

  return (
    <div className="flex h-full w-full min-w-0 flex-1 flex-col bg-bg-editor font-mono text-sm" data-testid="cloud-waking-view">
      <div className="flex-1 overflow-auto px-4 py-3">
        {waking.error ? (
          <>
            <p className="text-text-primary">{waking.error.message}</p>
            {waking.error.next && <p className="text-text-secondary">{waking.error.next}</p>}
          </>
        ) : clone?.state === 'failed' ? (
          <>
            <p className="text-text-primary">git clone {clone.repo}</p>
            <pre className="whitespace-pre-wrap text-status-error" data-testid="cloud-waking-error">{clone.error}</pre>
          </>
        ) : (
          <>
            <p className="text-text-secondary" data-testid="cloud-waking-status">{status}</p>
            {clone?.line && <p className="text-text-tertiary" data-testid="cloud-waking-progress">{clone.line}</p>}
          </>
        )}
      </div>
      <div className="flex h-11 items-center gap-2 border-t border-border-primary px-4">
        {failed ? (
          <>
            {clone?.state === 'failed' && waking.vmId && (
              <Button type="button" size="sm" variant="secondary" onClick={() => void usePaneCloudStore.getState().retryClone(waking.vmId ?? '')}>Retry</Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={close}>Close</Button>
          </>
        ) : (
          <>
            <SessionActivityIcon state="working" />
            <span className="truncate text-text-secondary">{waking.name}</span>
            <span className="ml-auto tabular-nums text-text-tertiary">{elapsed(waking.startedAt, now)}</span>
          </>
        )}
      </div>
    </div>
  );
}
