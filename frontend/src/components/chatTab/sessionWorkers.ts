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

/** One Session's overview reads, shared by every watch of it through the same source. */
interface SharedOverview {
  listeners: Set<(overview: SessionWorkersOverview) => void>;
  reading: boolean;
  again: boolean;
}
/** One watch's hold on a Session's overview reads. */
interface OverviewFollow {
  /** Reads when no read is out; otherwise waits for that one. */
  join(): void;
  /** Reads, or reads once more after the read that is out. */
  refresh(): void;
  stop(): void;
}
const sharedOverviews = new WeakMap<SessionWorkerSource, Map<string, SharedOverview>>();

/**
 * Follows one Session's overview with at most one read out at a time per source and Session,
 * however many watches there are, so a watch replaced mid-read (Autopilot's walk changing) joins
 * the read already out instead of starting another (review F-3 on #1281). `refresh` asks for a
 * read: during one, it reads once more after it. `join` reads only when none is out. Reads still
 * queued when the last watch stops are dropped.
 */
function followOverview(source: SessionWorkerSource, sessionId: string, listener: (overview: SessionWorkersOverview) => void): OverviewFollow {
  let bySession = sharedOverviews.get(source);
  if (!bySession) { bySession = new Map(); sharedOverviews.set(source, bySession); }
  const sessions = bySession;
  let shared = sessions.get(sessionId);
  if (!shared) { shared = { listeners: new Set(), reading: false, again: false }; sessions.set(sessionId, shared); }
  const entry = shared;
  entry.listeners.add(listener);
  const read = (): void => {
    entry.reading = true;
    source.overview(sessionId).then(overview => {
      if (!overview) return;
      for (const each of [...entry.listeners]) {
        // One watch's failure must not stop the others or the next read.
        try { each(overview); } catch (error) { console.warn('[sessionWorkers] Could not apply a Session overview:', error); }
      }
    }, () => undefined).finally(() => {
      entry.reading = false;
      if (entry.again && entry.listeners.size) { entry.again = false; read(); }
      else if (!entry.listeners.size) sessions.delete(sessionId);
    });
  };
  return {
    join: () => { if (!entry.reading) read(); },
    refresh: () => { if (entry.reading) entry.again = true; else read(); },
    stop: () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size) return;
      entry.again = false;
      if (!entry.reading) sessions.delete(sessionId);
    },
  };
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
  const follows = new Map(ids.map(id => [id, followOverview(source, id, overview => {
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
    for (const id of due) follows.get(id)?.refresh();
    due.clear();
  };
  const unsubscribe = source.onChange(sessionId => {
    if (sessionId !== undefined && !follows.has(sessionId)) return;
    for (const id of sessionId === undefined ? ids : [sessionId]) due.add(id);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, burstMs);
  });
  follows.forEach(follow => follow.join());
  return () => { live = false; if (timer) clearTimeout(timer); unsubscribe(); follows.forEach(follow => follow.stop()); };
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
