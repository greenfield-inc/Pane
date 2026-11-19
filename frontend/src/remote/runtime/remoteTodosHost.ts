import { DEFAULT_NOTIFY_SETTINGS, type NotifyCommand, type NotifyRemoteCommand, type NotifySharedState, type NotifySnapshot } from '../../../../shared/types/notify';
import type { AutopilotDocument } from '../../../../shared/types/autopilot';
import type { TodoActionResult, TodoDetail, TodoRecord, TodosSnapshot } from '../../../../shared/types/todos';
import { installNotifyApi, subscribeNotify, useNotifyStore, type NotifyApi } from '../../stores/notifyStore';
import { installTodosApi, resetTodos, watchTodos, type TodosAnswer, type TodosApi } from '../../stores/todosStore';
import type { RemoteRuntimeAdapter } from './remoteRuntimeAdapter';

/** Where a shared state sits in the host's order: a new epoch is a restarted host. */
export interface SharedStateMark {
  epoch: string;
  revision: number;
}

/** Whether `next` is newer than the state already shown, so a slow read never replaces a later event. */
export function isNewerSharedState(shown: SharedStateMark | null, next: SharedStateMark): boolean {
  return shown === null || shown.epoch !== next.epoch || next.revision > shown.revision;
}

/**
 * The host's shared approvals (`notify:remote-snapshot`) as the renderer's Notify snapshot. The
 * strip, its window and the desktop's own settings stay on the desktop: the web app shows none.
 */
export function sharedStateAsSnapshot(state: NotifySharedState): NotifySnapshot {
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS, enabled: state.enabled },
    items: state.items,
    queue: state.queue,
    hidden: state.hidden,
    strip: null,
    stripSurface: null,
    pausedUntil: null,
    shortcutRegistered: false,
    showOutsideSupported: false,
    firstRun: false,
    instructionFiles: [],
    cardsOn: { kind: 'any' },
    thisMachine: null,
  };
}

/**
 * A command from the approval column as the host takes it from a phone (`notify:remote-command`);
 * null for the desktop's own window and strip commands, which mean nothing here.
 */
export function remoteNotifyCommand(command: NotifyCommand): NotifyRemoteCommand | null {
  switch (command.type) {
    case 'answer':
    case 'override':
      return { type: command.type, id: command.id, answer: command.answer };
    case 'undo':
    case 'dismiss':
    case 'skip':
    case 'reopen':
      return { type: command.type, id: command.id };
    case 'close':
      return command.reason === undefined ? { type: 'close', id: command.id } : { type: 'close', id: command.id, reason: command.reason };
    case 'remind':
      return command.after === 'pane' ? null : { type: 'remind', id: command.id, after: command.after };
    case 'fix-reply':
      return { type: 'fix-reply', id: command.id, as: command.as };
    case 'open-link':
      return command.paneId === undefined
        ? { type: 'open-link', id: command.id, index: command.index }
        : { type: 'open-link', id: command.id, index: command.index, paneId: command.paneId };
    default:
      return null;
  }
}

async function answer<T>(work: () => Promise<T>): Promise<TodosAnswer<T>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The to-do screens' API over the daemon connection: the host's `todos:*` channels and its events. */
function remoteTodosApi(adapter: RemoteRuntimeAdapter): TodosApi {
  return {
    snapshot: () => answer(() => adapter.invoke<TodosSnapshot>('todos:snapshot')),
    detail: (number) => answer(() => adapter.invoke<TodoDetail>('todos:detail', [number])),
    create: (input) => answer(() => adapter.invoke<TodoRecord>('todos:create', [input])),
    act: (action) => answer(() => adapter.invoke<TodoActionResult>('todos:act', [action])),
    onChanged: (listener) => {
      const stopEvents = adapter.onEvent((event) => { if (event.channel === 'todos:changed') listener(); });
      // Events missed while the connection was down: read again once it is back.
      const stopStatus = adapter.onStatus((state) => { if (state.status === 'connected') listener(); });
      return () => { stopEvents(); stopStatus(); };
    },
    // Inline: an HTML page comes as its text, since the computer's file URL means nothing here.
    readDoc: (path) => adapter.invoke<AutopilotDocument>('autopilot:read-doc', [path, { inline: true }]),
    openUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    hostIsHere: false,
  };
}

/** Approvals over the daemon connection, as the phone app reads and answers them. */
function remoteNotifyApi(adapter: RemoteRuntimeAdapter): NotifyApi {
  let shown: SharedStateMark | null = null;
  const accept = (state: NotifySharedState | null): NotifySnapshot | null => {
    if (!state || !isNewerSharedState(shown, state)) return null;
    shown = { epoch: state.epoch, revision: state.revision };
    return sharedStateAsSnapshot(state);
  };
  // The host answers null when it has no Notify service.
  const read = () => adapter.invoke<NotifySharedState | null>('notify:remote-snapshot');
  /** Reads the host's state again; pushes it when it is newer than the one shown. */
  const reread = (listener: (snapshot: NotifySnapshot) => void) => {
    void read().then((next) => {
      const snapshot = accept(next);
      if (snapshot) listener(snapshot);
    }).catch(() => undefined);
  };
  return {
    getSnapshot: async () => {
      const snapshot = accept(await read());
      return snapshot ?? useNotifyStore.getState().snapshot ?? sharedStateAsSnapshot({ machine: '', epoch: '', revision: 0, enabled: true, items: [], queue: [], hidden: [] });
    },
    onSnapshot: (listener) => {
      // The event carries the state too; reading it back keeps one typed path, as the phone app does.
      const stopEvents = adapter.onEvent((event) => { if (event.channel === 'notify:shared-changed') reread(listener); });
      // Changes missed while the connection was down: read again once it is back.
      const stopStatus = adapter.onStatus((state) => { if (state.status === 'connected') reread(listener); });
      return () => { stopEvents(); stopStatus(); };
    },
    run: async (command) => {
      const remote = remoteNotifyCommand(command);
      if (!remote) throw new Error('That only works in Pane on the computer. Nothing was changed.');
      await adapter.invoke('notify:remote-command', [remote]);
    },
    // The host is the only machine here: every read goes to it.
    read: async (_machineId, channel, args) => ({ data: await adapter.invoke(channel, args) }),
    readsFilesHere: false,
  };
}

/**
 * Gives the web app To-dos and approvals on `adapter`'s host (P7): installs both APIs, reads them
 * and follows the host's events. Returns the stop, which forgets that host's to-dos and approvals.
 */
export function startRemoteTodos(adapter: RemoteRuntimeAdapter): () => void {
  installTodosApi(remoteTodosApi(adapter));
  installNotifyApi(remoteNotifyApi(adapter));
  const stopNotify = subscribeNotify();
  const stopTodos = watchTodos();
  return () => {
    stopTodos();
    stopNotify();
    installTodosApi(null);
    installNotifyApi(null);
    resetTodos();
    useNotifyStore.setState({ snapshot: null });
  };
}
