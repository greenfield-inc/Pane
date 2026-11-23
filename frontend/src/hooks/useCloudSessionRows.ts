import { useEffect, useMemo, useState } from 'react';
import { usePaneCloudStore } from '../stores/paneCloudStore';
import { sessionWaitingCount, useNotifyStore } from '../stores/notifyStore';
import { visibleOrchestrationSessions } from '../components/orchestrationSessionVisibility';
import type { PaneCloudSnapshot } from '../../../shared/types/paneCloud';
import { useActiveMachineStore } from '../stores/activeMachineStore';
import { LOCAL_MACHINE_ID, type MachineConnectionsEvent } from '../../../shared/types/machineConnections';
import { LEGACY_ORCHESTRATION_SESSION_ID, type OrchestrationSessionRecord, type SessionActivity } from '../../../shared/types/orchestrationSession';

/** One row the Sessions list shows for a Session on another machine: a cloud Session, or this computer's while the window is on a cloud Session. */
export interface CloudSessionRow {
  key: string;
  /** The machine it lives on; null for a cloud Session not paired with this desktop. */
  machineId: string | null;
  /** The cloud Session's VM; null for this computer's Sessions. */
  vmId: string | null;
  /** The cloud Session's own name, which Delete names: a VM is one cloud Session, whatever runs on it. */
  cloudName: string | null;
  /** The Session on that machine; null before its list has been read (a stopped cloud Session). */
  sessionId: string | null;
  name: string;
  activity: SessionActivity['state'];
  workingPanes: number;
  /** A cloud Session that isn't running: it starts when opened. */
  stopped: boolean;
  underReview: boolean;
  /** A stop, start or delete is in flight. */
  busy: boolean;
  isPinned: boolean;
}

export interface MachineLists {
  sessions: OrchestrationSessionRecord[];
  activity: SessionActivity[];
  /** Sessions that belong to that machine's loops. */
  loopSessionIds: string[];
}

const REREAD_MS = 300;
const LIST_EVENTS = new Set(['orchestration-sessions:changed', 'orchestration-sessions:activity']);

async function readLists(machineId: string): Promise<MachineLists> {
  const machines = window.electronAPI.machines;
  const [list, activity, loops] = await Promise.all([
    machines.read(machineId, 'orchestration-sessions:list'),
    machines.read(machineId, 'orchestration-sessions:activity-list').catch(() => null),
    // An older Pane can't serve its loops: its loop Sessions then list as plain rows.
    machines.read(machineId, 'loops:list').catch(() => null),
  ]);
  return {
    sessions: list.data?.data?.sessions ?? [],
    activity: activity?.data?.data ?? [],
    loopSessionIds: (loops?.data?.data ?? []).flatMap((loop) => loop.orchestrationSessionId ? [loop.orchestrationSessionId] : []),
  };
}

/**
 * The Sessions the window's own list can't show: each cloud Session (its VM is a saved machine), and
 * this computer's Sessions while the window is on a cloud Session, so local and cloud Sessions read as
 * one list whichever machine the window is on. Their lists come over the saved machines' connections.
 */
export function useCloudSessionRows(): CloudSessionRow[] {
  const cloud = usePaneCloudStore((state) => state.snapshot);
  const activeId = useActiveMachineStore((state) => state.machine?.id ?? LOCAL_MACHINE_ID);
  useEffect(() => usePaneCloudStore.getState().follow(), []);

  const onCloud = cloud.sessions.some((session) => session.machineId !== null && session.machineId === activeId);
  const readIds = useMemo(() => {
    const ids = cloud.sessions.filter((session) => session.awake && session.machineId && session.machineId !== activeId).map((session) => session.machineId ?? '');
    return onCloud ? [LOCAL_MACHINE_ID, ...ids] : ids;
  }, [activeId, cloud.sessions, onCloud]);
  const readKey = readIds.join('\n');

  const [lists, setLists] = useState<Record<string, MachineLists>>({});
  useEffect(() => {
    const ids = readKey ? readKey.split('\n') : [];
    if (ids.length === 0 || !window.electronAPI?.machines) return undefined;
    let stopped = false;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const read = (machineId: string) => {
      readLists(machineId).then((answer) => {
        if (!stopped) setLists((current) => ({ ...current, [machineId]: answer }));
      }).catch((error) => console.warn(`[cloudSessions] Could not read the Sessions of ${machineId}:`, error));
    };
    const onEvent = (event: MachineConnectionsEvent) => {
      if (event.type === 'machines') return;
      if (!ids.includes(event.machineId)) return;
      if (event.type === 'event' && !LIST_EVENTS.has(event.channel)) return;
      clearTimeout(timers.get(event.machineId));
      timers.set(event.machineId, setTimeout(() => read(event.machineId), REREAD_MS));
    };
    const unsubscribe = window.electronAPI.machines.onEvent(onEvent);
    for (const id of ids) read(id);
    return () => {
      stopped = true;
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [readKey]);

  const waiting = useNotifyStore((state) => state.snapshot);
  return useMemo(() => cloudSessionRows({
    cloud,
    activeId,
    lists,
    waitingCount: (machineId, sessionId) => sessionWaitingCount(waiting, sessionId, machineId),
  }), [activeId, cloud, lists, waiting]);
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The rows for Sessions on other machines, filtered as the Sessions list filters its own: a to-do's
 * Session never shows (its record carries the to-do's number), a loop's only while a card waits.
 * A machine's Pane Chat shows only in its own window's list, as for any paired machine (D-88). A cloud
 * Session not read yet is one row named for it.
 */
export function cloudSessionRows({ cloud, activeId, lists, waitingCount }: {
  cloud: Pick<PaneCloudSnapshot, 'sessions' | 'busy'>;
  activeId: string;
  lists: Readonly<Record<string, MachineLists>>;
  waitingCount: (machineId: string, sessionId: string) => number;
}): CloudSessionRow[] {
  const rows: CloudSessionRow[] = [];
  const fromLists = (machineId: string, vmId: string | null, extra: Pick<CloudSessionRow, 'underReview' | 'busy' | 'cloudName'>): CloudSessionRow[] | null => {
    const read = lists[machineId];
    if (!read) return null;
    const visible = visibleOrchestrationSessions(read.sessions, { todoSessionIds: NO_IDS, loopSessionIds: new Set(read.loopSessionIds), waitingCount: (sessionId) => waitingCount(machineId, sessionId) })
      .filter((session) => session.id !== LEGACY_ORCHESTRATION_SESSION_ID);
    return visible.map((session) => {
      const activity = read.activity.find((entry) => entry.sessionId === session.id);
      return {
        key: `${machineId}:${session.id}`,
        machineId,
        vmId,
        sessionId: session.id,
        name: session.name || 'Pane Chat',
        activity: activity?.state ?? 'idle',
        workingPanes: activity?.workingPanes ?? 0,
        stopped: false,
        isPinned: session.isPinned === true,
        ...extra,
      };
    });
  };
  const onCloud = cloud.sessions.some((session) => session.machineId !== null && session.machineId === activeId);
  if (onCloud) rows.push(...(fromLists(LOCAL_MACHINE_ID, null, { underReview: false, busy: false, cloudName: null }) ?? []));
  for (const session of cloud.sessions) {
    // Not paired with this computer and not running: an archived cloud Session (D-94), listed under Archived.
    // One being created, or unlinked by hand while it runs, keeps its row with Stop and Delete.
    if ((session.machineId === null && !session.awake) || (session.machineId !== null && session.machineId === activeId)) continue;
    const extra = { underReview: session.underReview, busy: cloud.busy.includes(session.vmId), cloudName: session.name };
    const read = session.awake && session.machineId ? fromLists(session.machineId, session.vmId, extra) : null;
    if (read && read.length > 0) {
      rows.push(...read);
      continue;
    }
    rows.push({
      key: `vm:${session.vmId}`,
      machineId: session.machineId,
      vmId: session.vmId,
      sessionId: null,
      name: session.name,
      activity: 'idle',
      workingPanes: 0,
      stopped: !session.awake,
      isPinned: false,
      ...extra,
    });
  }
  return rows;
}
