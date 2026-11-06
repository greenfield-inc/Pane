import { useEffect, useState } from 'react';
import { workerLines, type ChatWorkerLine, type WorkerPaneInput } from '../../../../shared/chatTabPresentation';

/** The part of a Session overview (`orchestration-sessions:overview`) that worker lines read. */
export interface SessionWorkersOverview {
  session: { associations: ReadonlyArray<{ paneId: string; attachedAt: string }> };
  panes: readonly WorkerPaneInput[];
}

/** Where a client reads a Session's overview: Electron IPC on the desktop, the host connection in the PWA. */
export interface SessionWorkerSource {
  overview(sessionId: string): Promise<SessionWorkersOverview | null | undefined>;
  /** Calls back when the Session's Panes, their agent states or reports may have changed; returns the unsubscribe. */
  onChange(callback: () => void): () => void;
}

/**
 * Keeps a Session's worker lines current from Pane's own overview (never from what
 * the agent wrote). A failed or empty read keeps the last lines. Returns the stop.
 */
export function watchSessionWorkers(source: SessionWorkerSource, sessionId: string, onWorkers: (workers: ChatWorkerLine[]) => void, burstMs = 300): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    source.overview(sessionId).then(overview => {
      if (!live || !overview) return;
      const attached = new Map(overview.session.associations.map(association => [association.paneId, association.attachedAt]));
      onWorkers(workerLines(overview.panes, attached));
    }).catch(() => undefined);
  };
  // Status changes arrive in bursts; one read covers each burst.
  const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, burstMs); };
  const unsubscribe = source.onChange(soon);
  refresh();
  return () => { live = false; if (timer) clearTimeout(timer); unsubscribe(); };
}

/** The Session's worker lines for its orchestrator's chat; `source` must be stable across renders. */
export function useSessionWorkers(source: SessionWorkerSource, sessionId: string | undefined): ChatWorkerLine[] | undefined {
  const [workers, setWorkers] = useState<ChatWorkerLine[]>();
  useEffect(() => {
    if (!sessionId) return;
    return watchSessionWorkers(source, sessionId, setWorkers);
  }, [source, sessionId]);
  return workers;
}
