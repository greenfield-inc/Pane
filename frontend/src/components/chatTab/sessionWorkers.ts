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
  /**
   * Calls back when Sessions' Panes, their agent states or reports may have changed, with the id
   * of the Session that changed when the event names one (none means any); returns the unsubscribe.
   */
  onChange(callback: (sessionId?: string) => void): () => void;
}

/**
 * Reads one Session's overview at most once at a time: asked again while a read is out, it reads
 * once more after that read ends, however often it was asked (review F-3 on #1281).
 */
function overviewReader(source: SessionWorkerSource, sessionId: string, onOverview: (overview: SessionWorkersOverview) => void): () => void {
  let reading = false;
  let again = false;
  const read = (): void => {
    if (reading) { again = true; return; }
    reading = true;
    source.overview(sessionId)
      .then(overview => { if (overview) onOverview(overview); }, () => undefined)
      .finally(() => {
        reading = false;
        if (again) { again = false; read(); }
      });
  };
  return read;
}

/**
 * Keeps a Session's worker lines current from Pane's own overview (never from what
 * the agent wrote). A failed or empty read keeps the last lines. Returns the stop.
 */
export function watchSessionWorkers(source: SessionWorkerSource, sessionId: string, onWorkers: (workers: ChatWorkerLine[]) => void, burstMs = 300): () => void {
  return watchManySessionWorkers(source, [sessionId], onWorkers, burstMs);
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

/**
 * Keeps the worker lines of several Sessions current, such as the ones Autopilot walks
 * (D-276), and arrives merged in the order of `sessionIds`. One subscription serves them all:
 * a change read again only the Session it names, and a change naming none reads every one
 * (review F-3 on #1281). A failed or empty read keeps that Session's last lines. Returns the stop.
 */
export function watchManySessionWorkers(source: SessionWorkerSource, sessionIds: readonly string[], onWorkers: (workers: ChatWorkerLine[]) => void, burstMs = 300): () => void {
  const ids = [...new Set(sessionIds)];
  let live = true;
  const bySession = new Map<string, ChatWorkerLine[]>();
  const readers = new Map(ids.map(id => [id, overviewReader(source, id, overview => {
    if (!live) return;
    const attached = new Map(overview.session.associations.map(association => [association.paneId, association.attachedAt]));
    bySession.set(id, workerLines(overview.panes, attached));
    onWorkers(ids.flatMap(sessionId => bySession.get(sessionId) ?? []));
  })]));
  // Status changes arrive in bursts; one read per changed Session covers each burst.
  const due = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    for (const id of due) readers.get(id)?.();
    due.clear();
  };
  const unsubscribe = source.onChange(sessionId => {
    if (sessionId !== undefined && !readers.has(sessionId)) return;
    for (const id of sessionId === undefined ? ids : [sessionId]) due.add(id);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, burstMs);
  });
  readers.forEach(read => read());
  return () => { live = false; if (timer) clearTimeout(timer); unsubscribe(); };
}

/** The worker lines of several Sessions; `sessionIds` is compared by value, so a new array with the same ids keeps the watches. */
export function useManySessionWorkers(source: SessionWorkerSource, sessionIds: readonly string[]): ChatWorkerLine[] {
  const key = sessionIds.join('\n');
  const [workers, setWorkers] = useState<ChatWorkerLine[]>([]);
  useEffect(() => {
    setWorkers([]);
    if (!key) return;
    return watchManySessionWorkers(source, key.split('\n'), setWorkers);
  }, [source, key]);
  return workers;
}
