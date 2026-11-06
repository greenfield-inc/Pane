import type { NotifyItem } from '../../../../shared/types/notify';
import type { RunpaneWorkspaceEntry } from '../../../../shared/types/runpaneOrchestration';
import type { WorkspaceAgentStatus, WorkspaceJournal } from '../workspaceJournal';

/** A Session as Autopilot's events need it: `paneId` is its own workspace Pane (the orchestrator's). */
export interface AutopilotEventSession {
  id: string;
  name: string;
  archived?: boolean;
  paneId: string;
}

export interface AutopilotEventsDeps {
  journal: Pick<WorkspaceJournal, 'append' | 'onAgentStatus'>;
  notify: {
    /** The questions waiting on the person now. */
    waiting(): NotifyItem[];
    /** Every item the queue still holds (waiting, answered, expired), to say how one ended. */
    items(): NotifyItem[];
    subscribe(listener: () => void): () => void;
  };
  /** Absent when this Pane has no Sessions (a headless daemon without them). */
  sessions?: {
    list(): Promise<AutopilotEventSession[]>;
    subscribe(listener: () => void): () => void;
  };
}

type JournalEntry = Omit<RunpaneWorkspaceEntry, 'gen' | 'at'>;

/**
 * Autopilot's watch kinds (package 2e), journalled for `runpane watch --as autopilot --kinds ...`:
 * `item.created` and `item.answered` when an approval or question starts or stops waiting on the
 * person (an item that expired unanswered has a `reason` starting with NO_ANSWER), `session.created` and `session.archived`, and `orchestrator.turn_ended` when a Session
 * orchestrator goes from working to idle. The journal delivers them only to watches that list them
 * in `--kinds`, so orchestrators' watches are unchanged. Returns the disconnect function.
 */
export function connectAutopilotEvents(deps: AutopilotEventsDeps): () => void {
  const { journal, notify, sessions } = deps;
  const append = (entry: JournalEntry) => { journal.append(entry); };

  // ---- Items: diff the waiting ids on every queue change ----
  let waiting = new Map(notify.waiting().map(item => [item.id, item]));
  const onNotifyChange = () => {
    const now = new Map(notify.waiting().map(item => [item.id, item]));
    for (const [id, item] of now) {
      // Autopilot's own questions are not news to Autopilot; their answers are.
      if (!waiting.has(id) && !item.source.autopilot) append(itemEntry('item.created', item));
    }
    if ([...waiting.keys()].some(id => !now.has(id))) {
      const all = new Map(notify.items().map(item => [item.id, item]));
      for (const [id, item] of waiting) {
        if (!now.has(id)) append(itemEntry('item.answered', all.get(id) ?? item));
      }
    }
    waiting = now;
  };
  const stopNotify = notify.subscribe(onNotifyChange);

  // ---- Sessions: diff the list on every change, after a baseline read ----
  let known: Map<string, AutopilotEventSession> | undefined;
  let byPane = new Map<string, AutopilotEventSession>();
  let reading: Promise<void> = Promise.resolve();
  let disposed = false;
  const readSessions = () => {
    if (!sessions) return;
    reading = reading.then(async () => {
      let list: AutopilotEventSession[];
      try {
        list = await sessions.list();
      } catch (error) {
        // The next change reads them again.
        console.warn('[Autopilot] Could not read the Sessions for its events:', error);
        return;
      }
      if (disposed) return;
      const next = new Map(list.map(session => [session.id, session]));
      if (known) {
        for (const session of list) {
          const before = known.get(session.id);
          if (!before && session.archived !== true) append(sessionEntry('session.created', session));
          else if (before && before.archived !== true && session.archived === true) append(sessionEntry('session.archived', session));
        }
      }
      known = next;
      byPane = new Map(list.map(session => [session.paneId, session]));
    });
  };
  const stopSessions = sessions?.subscribe(readSessions);
  readSessions();

  // ---- Orchestrator turns: working → idle in a Session's own Pane ----
  const lastState = new Map<string, WorkspaceAgentStatus['state']>();
  const stopStatus = journal.onAgentStatus((status) => {
    const session = byPane.get(status.paneId);
    if (!session || session.archived === true) return;
    // A process starting or ending is not a finished turn.
    if (status.reason === 'terminal_start' || status.reason === 'exit' || status.reason === 'destroyed') {
      lastState.delete(status.panelId);
      return;
    }
    const previous = lastState.get(status.panelId);
    lastState.set(status.panelId, status.state);
    if (previous === 'working' && status.state === 'idle') {
      append({
        kind: 'orchestrator.turn_ended',
        paneId: session.paneId,
        paneName: session.name,
        panelId: status.panelId,
        sessionId: session.id,
        sessionName: session.name,
        from: 'working',
        to: 'idle',
        source: 'agent',
        reason: status.reason ?? null,
      });
    }
  });

  return () => {
    disposed = true;
    stopNotify();
    stopSessions?.();
    stopStatus();
  };
}

/** The title is the reason, so a lines watch shows it; `itemId` is what `stack push --item` takes. */
/** Starts the `reason` of an `item.answered` entry whose item expired unanswered (its asker stopped waiting). */
export const NO_ANSWER = 'No answer (the asker stopped waiting): ';

function itemEntry(kind: 'item.created' | 'item.answered', item: NotifyItem): JournalEntry {
  const { source } = item;
  const entry: JournalEntry = {
    kind,
    paneId: source.paneId ?? source.session?.paneId ?? '',
    paneName: source.name,
    source: kind === 'item.created' ? 'agent' : 'session',
    // An item stops waiting when it is answered or when its asker stops (expired): only the first is an answer.
    reason: kind === 'item.answered' && item.state === 'expired' ? `${NO_ANSWER}${item.title}` : item.title,
    itemId: item.id,
  };
  if (source.panelId) entry.panelId = source.panelId;
  if (source.session) {
    entry.sessionId = source.session.id;
    entry.sessionName = source.session.name;
  }
  return entry;
}

function sessionEntry(kind: 'session.created' | 'session.archived', session: AutopilotEventSession): JournalEntry {
  return {
    kind,
    paneId: session.paneId,
    paneName: session.name,
    sessionId: session.id,
    sessionName: session.name,
    source: 'session',
    reason: null,
  };
}
