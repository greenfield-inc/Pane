import { create } from 'zustand';
import { EMPTY_TODO_SCOPE, inTodoScope, type TodoApprovalScope } from '../components/todos/sessionTodos';
import { isOpenForSession } from '../../../shared/approvalOpen';
import type { NotifyCommand, NotifyItem, NotifySnapshot } from '../../../shared/types/notify';
import { showActionError } from './errorStore';

/**
 * The renderer's copy of main's Notify queue. Main owns every decision (what the
 * strip shows, where, what is docked); surfaces render this snapshot and send
 * commands back.
 */
interface NotifyState {
  /** Main's latest snapshot, less the items archived and still held for Undo. */
  snapshot: NotifySnapshot | null;
  archived: ArchiveHold | null;
}

/** Approvals archived from the list: gone from every count, their close sent when the Undo toast ends. */
interface ArchiveHold {
  ids: string[];
  /** The archived item's title, or how many were archived. */
  message: string;
}

export const useNotifyStore = create<NotifyState>(() => ({ snapshot: null, archived: null }));

/** What main last sent, before held archives are taken out. */
let received: NotifySnapshot | null = null;
/** Archived items whose close was sent: out of the list until a snapshot shows them closed, or the close is refused. */
const closing = new Set<string>();

function publish(snapshot: NotifySnapshot | null): void {
  received = snapshot;
  for (const id of closing) {
    if (!snapshot?.items.some((item) => item.id === id && item.state === 'waiting')) closing.delete(id);
  }
  const held = new Set([...closing, ...useNotifyStore.getState().archived?.ids ?? []]);
  useNotifyStore.setState({ snapshot: snapshot && held.size > 0 ? { ...snapshot, items: snapshot.items.filter((item) => !held.has(item.id)) } : snapshot });
}

/** One read from the machine that holds an item: a linked document or its Summary. */
export type NotifyMachineRead = (machineId: string, channel: string, args: unknown[]) => Promise<{ data: unknown }>;

/**
 * Where approvals are read and answered (P7). The desktop's is the preload's `notify` API; the web
 * app installs one over its daemon connection (`notify:remote-snapshot`, `notify:remote-command`).
 */
export interface NotifyApi {
  getSnapshot: () => Promise<NotifySnapshot>;
  onSnapshot: (listener: (snapshot: NotifySnapshot) => void) => () => void;
  run: (command: NotifyCommand) => Promise<void>;
  read: NotifyMachineRead;
  /** The desktop shows this machine's linked files in its own viewer; the web app reads them from the host. */
  readsFilesHere: boolean;
}

function electronNotifyApi(): NotifyApi | null {
  const api = window.electronAPI;
  if (!api) return null;
  return {
    getSnapshot: () => api.notify.getSnapshot(),
    onSnapshot: (listener) => api.notify.onSnapshot(listener),
    run: (command) => api.notify.run(command),
    // SAFETY: main refuses a channel it doesn't serve, and every caller treats that refusal as a failed read.
    read: (machineId, channel, args) => (api.machines.read as NotifyMachineRead)(machineId, channel, args),
    readsFilesHere: true,
  };
}

let installedApi: NotifyApi | null = null;

/** The web app's API, installed while it is connected to a host; null puts the desktop's back. */
export function installNotifyApi(api: NotifyApi | null): void {
  installedApi = api;
}

/** Whether this machine's linked files open in the app's own viewer: on the desktop, not in the web app. */
export function notifyReadsFilesHere(): boolean {
  return installedApi?.readsFilesHere ?? true;
}

/** The API approvals use now: the installed one, else the desktop's, else none. */
export function notifyApi(): NotifyApi | null {
  return installedApi ?? electronNotifyApi();
}

const NO_ITEMS: readonly NotifyItem[] = [];

/** Every item, or one shared empty list before the first snapshot: a fresh `[]` per read would re-render forever. */
export function selectNotifyItems(state: Pick<NotifyState, 'snapshot'>): readonly NotifyItem[] {
  return state.snapshot?.items ?? NO_ITEMS;
}

/** Keeps the store in step with main. Returns the unsubscribe. */
export function subscribeNotify(): () => void {
  const api = installedApi ?? (window.electronAPI?.notify ? electronNotifyApi() : null);
  if (!api) return () => undefined;
  let pushed = false;
  const unsubscribe = api.onSnapshot((snapshot) => {
    pushed = true;
    publish(snapshot);
  });
  void api.getSnapshot()
    .then((snapshot) => {
      // A push that arrived first is newer than this read.
      if (!pushed) publish(snapshot);
    })
    .catch((error) => console.error('Failed to read the Notify queue:', error));
  return unsubscribe;
}

/** The title a refused card command shows under; commands nobody waits on fail quietly. */
function failedTitle(type: NotifyCommand['type']): string | undefined {
  switch (type) {
    case 'answer': return 'Your answer was not sent';
    case 'override': return 'Your correction was not sent';
    case 'close': return 'Could not close this approval';
    case 'reopen': return 'Could not reopen this approval';
    case 'undo': return 'Could not undo your answer';
    default: return undefined;
  }
}

/** Runs a card's command; a refusal (asker gone, machine offline, already answered) shows the person why. */
export function runNotify(command: NotifyCommand): void {
  void sendNotify(command);
}

/** Runs a card's command and says whether it was accepted, so a form keeps what was typed until it was (F-4). */
export async function sendNotify(command: NotifyCommand): Promise<boolean> {
  try {
    const api = notifyApi();
    if (!api) throw new Error('Approvals are not available here.');
    await api.run(command);
    return true;
  } catch (error) {
    console.error(`Notify command ${command.type} failed:`, error);
    const title = failedTitle(command.type);
    if (title) showActionError(title, error);
    return false;
  }
}

/**
 * Archive: the close the approval's own Close sends, with no reason, held while its Undo toast
 * shows. Archiving again joins the hold and starts its toast over, so Undo brings back every one (D-104).
 */
export function archiveApprovals(items: readonly NotifyItem[]): void {
  if (items.length === 0) return;
  const earlier = useNotifyStore.getState().archived?.ids ?? [];
  const ids = [...earlier, ...items.map((item) => item.id).filter((id) => !earlier.includes(id))];
  const message = ids.length === 1 ? `Archived “${items[0].relay?.question ?? items[0].title}”` : `Archived ${ids.length} approvals`;
  useNotifyStore.setState({ archived: { ids, message } });
  publish(received);
  window.addEventListener('beforeunload', sendArchived);
}

/** Undo: the held items wait again, and nothing was sent. */
export function undoArchive(): void {
  window.removeEventListener('beforeunload', sendArchived);
  if (!useNotifyStore.getState().archived) return;
  useNotifyStore.setState({ archived: null });
  publish(received);
}

/** The Undo toast ended (or the screen closed): each held item's asker is told it was closed. */
export function sendArchived(): void {
  window.removeEventListener('beforeunload', sendArchived);
  const held = useNotifyStore.getState().archived;
  if (!held) return;
  // One answered or closed elsewhere during the hold has nothing left to close.
  const waiting = held.ids.filter((id) => received?.items.some((item) => item.id === id && item.state === 'waiting'));
  for (const id of waiting) closing.add(id);
  useNotifyStore.setState({ archived: null });
  // A refused close shows why, and its row comes back at once.
  for (const id of waiting) {
    void sendNotify({ type: 'close', id }).then((accepted) => {
      if (accepted) return;
      closing.delete(id);
      publish(received);
    });
  }
}

export function notifyItem(snapshot: NotifySnapshot | null, id: string | null | undefined): NotifyItem | undefined {
  if (!snapshot || !id) return undefined;
  return snapshot.items.find((item) => item.id === id);
}

/**
 * An item the person can answer now: what every count counts. A stale item waits in its own group,
 * an offline machine's collapses to one row, and a mirror from an older machine takes no answer.
 */
export function countsAsWaiting(item: NotifyItem): boolean {
  return item.state === 'waiting' && !item.unreachable && item.staleSince === undefined && !item.relay;
}

/** Questions still waiting for an answer. Updates never count. */
export function waitingCount(snapshot: NotifySnapshot | null): number {
  return snapshot?.items.filter(countsAsWaiting).length ?? 0;
}

/**
 * How many items from this Session (its orchestrator, worker prompts, fallback items) wait on you;
 * with `machineId`, only that machine's (`local` for this computer). A dismissed item still waits in
 * Approvals but isn't open for its Session (`isOpenForSession`), so the row's count leaves it out.
 */
export function sessionWaitingCount(snapshot: NotifySnapshot | null, sessionId: string, machineId?: string, todos: TodoApprovalScope = EMPTY_TODO_SCOPE): number {
  // With `todos`, the approvals of the to-dos this Session requested count too, each once (T-22).
  return snapshot?.items.filter((item) => countsAsWaiting(item) && isOpenForSession(item) && (item.source.session?.id === sessionId || inTodoScope(item, todos))
    && (machineId === undefined || (item.machineId ?? 'local') === machineId)).length ?? 0;
}

/**
 * How many approvals of a Session's to-dos wait on you, each once: the amber count on its To-dos tab
 * (T-23). The Session's own questions are left out; its sidebar row counts both (`sessionWaitingCount`).
 */
export function todosWaitingCount(snapshot: NotifySnapshot | null, todos: TodoApprovalScope, machineId?: string): number {
  return snapshot?.items.filter((item) => countsAsWaiting(item) && isOpenForSession(item) && inTodoScope(item, todos)
    && (machineId === undefined || (item.machineId ?? 'local') === machineId)).length ?? 0;
}

/** Waiting items from machines other than the one the app is on (`local` for this computer). */
export function waitingElsewhere(snapshot: NotifySnapshot | null, activeMachineId: string): number {
  return snapshot?.items.filter((item) => countsAsWaiting(item) && (item.machineId ?? 'local') !== activeMachineId).length ?? 0;
}

export function paneHasWaitingQuestion(snapshot: NotifySnapshot | null, paneId: string): boolean {
  return snapshot?.items.some((item) => countsAsWaiting(item) && item.source.paneId === paneId) ?? false;
}
