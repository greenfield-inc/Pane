import { create } from 'zustand';
import { machineMirrorApi, mirrorListing, useMachineMirrorStore } from './machineMirrorStore';
import { useAllMachinesStore } from './allMachinesStore';
import { switchMark } from '../../../shared/switchMarks';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { ChatTabClient, ChatTabView } from '../../../shared/types/chatTab';
import { decodeChatMessages, decodeChatTabEvent, decodeChatTabView } from '../../../shared/types/chatTabDecoders';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import type { OrchestrationSessionOpenResult } from '../../../shared/types/orchestrationSession';
import type { SessionSnapshot } from '../../../shared/types/sessionSnapshot';
import { firstPaintWindow } from '../../../shared/chatTabViewer';
import type { Session } from '../types/session';

/**
 * Another machine's Session under the sidebar cursor (T-116 PR 6): shown read-only, with no host
 * switch, no agent start and nothing written there. A Session the desktop mirror holds paints from
 * it at once (`machine-mirror:session`, local IPC). Once the cursor rests on it, one read of the host
 * (`orchestration-sessions:peek`, alternative b) brings the newest 200 messages; that same read is all
 * a Session the mirror lacks has. While shown, its chat follows the host's events.
 *
 * Every entry is keyed by machine and Session, so a Session id another machine also has never shows
 * this computer's copy. Loads never hold the cursor (D-6): the target changes at once, a read for a
 * Session the cursor has left is dropped or never started, and the newest target wins.
 */
export interface RemoteSessionTarget {
  machineId: string;
  sessionId: string;
}

export interface RemoteSessionEntry {
  /** The mirror's copy: summary record, tabs, layout and newest 30 messages. */
  snapshot?: SessionSnapshot;
  /** The host's one-call read: its view, tabs, layout and newest 200 messages. */
  read?: OrchestrationSessionOpenResult<Session>;
  /** When `read` arrived (performance.now()). */
  readAt: number;
  /** Why the host's read failed, kept until the next one. */
  error?: string;
}

interface RemoteSessionViewState {
  target?: RemoteSessionTarget;
  entries: Record<string, RemoteSessionEntry>;
  /** By machine and panel: the chat run (generation) in which its host said earlier messages aren't readable until it runs. */
  earlierUnavailable: Record<string, number>;
}

export const useRemoteSessionView = create<RemoteSessionViewState>(() => ({ entries: {}, earlierUnavailable: {} }));

/** How long the cursor stays on a row before its host is read: rows passed over at key-repeat speed are never read. */
const REMOTE_READ_REST_MS = 150;
/** A host read this recent needs no second one: the mirror and the followed chat keep a shown Session current. */
const FRESH_READ_MS = 30_000;
/** Entries kept, the least recently shown first out (as the Session view cache's 30). */
const KEPT_ENTRIES = 30;
/** What `peek` takes after the selector: a desktop shows chat tabs and every chat agent. */
const PEEK_OPTIONS = { chatTabs: true, chatAgents: true };

export function remoteSessionKey(machineId: string, sessionId: string): string {
  return `${machineId}\u0000${sessionId}`;
}

export function cachedRemoteSession(machineId: string, sessionId: string): RemoteSessionEntry | undefined {
  return useRemoteSessionView.getState().entries[remoteSessionKey(machineId, sessionId)];
}

const order: string[] = [];
const mirrorReads = new Map<string, Promise<void>>();
const hostReads = new Map<string, Promise<RemoteSessionEntry | undefined>>();

/** The newest live event heard for each remote chat (by panel id): how far ahead of what is held the host is. */
const liveRevisions = new Map<string, { generation: number; revision: number }>();
/** Counts live events and views heard; a read records the count when it starts, so it covers every one heard before. */
let heardSeq = 0;
const heardAtSeq = new Map<string, number>();
const readStartSeq = new Map<string, number>();

function heardLive(panelId: string, generation: number, revision: number): void {
  heardSeq += 1;
  heardAtSeq.set(panelId, heardSeq);
  const known = liveRevisions.get(panelId);
  if (!known || generation > known.generation || (generation === known.generation && revision > known.revision)) liveRevisions.set(panelId, { generation, revision });
}

/**
 * The host read for a gap in a shown chat's live events: the one under way, a new one, or none when
 * a read already started after the newest event was heard (it covers it). The viewer waits for it.
 */
function readForLive(machineId: string, sessionId: string, panelId: string): Promise<void> | undefined {
  const key = remoteSessionKey(machineId, sessionId);
  const pending = hostReads.get(key);
  if (pending) return pending.then(() => undefined);
  if ((readStartSeq.get(key) ?? -1) > (heardAtSeq.get(panelId) ?? 0)) return undefined;
  readStartSeq.set(key, heardSeq + 1);
  return readRemoteSession(machineId, sessionId).then(() => undefined);
}

/** Whether the live events heard for a chat are ahead of the copy held: a gap only the host can close. */
function behindLive(panelId: string, chat: ChatTabView): boolean {
  const live = liveRevisions.get(panelId);
  const held = chat.transcript;
  if (!live || !held) return false;
  return live.generation > held.generation || (live.generation === held.generation && live.revision > held.revision);
}

/** Which copy of a chat is held: its panel, conversation, revision and window. */
function heldVersion(chat: ChatTabView | undefined): string {
  const transcript = chat?.transcript;
  return chat && transcript ? `${chat.panelId}:${transcript.generation}:${transcript.revision}:${transcript.start}:${transcript.messages.length}` : '';
}
let restTimer: ReturnType<typeof setTimeout> | undefined;
let followingMirror = false;

function sameTarget(a: RemoteSessionTarget | undefined, b: RemoteSessionTarget | undefined): boolean {
  return a?.machineId === b?.machineId && a?.sessionId === b?.sessionId;
}

function isTarget(machineId: string, sessionId: string): boolean {
  return sameTarget(useRemoteSessionView.getState().target, { machineId, sessionId });
}

function patch(machineId: string, sessionId: string, change: Partial<RemoteSessionEntry>): void {
  const key = remoteSessionKey(machineId, sessionId);
  const at = order.indexOf(key);
  if (at >= 0) order.splice(at, 1);
  order.push(key);
  const dropped = order.length > KEPT_ENTRIES ? order.splice(0, order.length - KEPT_ENTRIES) : [];
  useRemoteSessionView.setState(state => {
    const entries = { ...state.entries, [key]: { ...state.entries[key], readAt: state.entries[key]?.readAt ?? 0, ...change } };
    for (const old of dropped) delete entries[old];
    return { entries };
  });
}

/** Whether the machine answers now; an offline machine shows what the mirror last had. */
function machineOnline(machineId: string): boolean {
  return useAllMachinesStore.getState().machines.find(machine => machine.id === machineId)?.status === 'online';
}

/** The mirror's copy of one Session, read again whenever the mirror holds a newer revision of it. */
function readMirror(machineId: string, sessionId: string): void {
  const revision = mirrorListing(machineId)?.sessions[sessionId];
  if (revision === undefined) return;
  const key = remoteSessionKey(machineId, sessionId);
  if (cachedRemoteSession(machineId, sessionId)?.snapshot?.revision === revision || mirrorReads.has(key)) return;
  const api = machineMirrorApi();
  if (!api) return;
  switchMark('remote:mirror:start', { machineId, sessionId });
  const read = api.session(machineId, sessionId)
    .then(snapshot => {
      switchMark('remote:mirror:end', { machineId, sessionId, status: snapshot ? 'found' : 'missing' });
      if (snapshot) patch(machineId, sessionId, { snapshot });
    })
    .catch(error => console.warn('[Remote Session] Could not read the mirror:', error))
    .finally(() => {
      mirrorReads.delete(key);
      // A newer copy arrived while this one was read.
      if (isTarget(machineId, sessionId) && mirrorListing(machineId)?.sessions[sessionId] !== revision) readMirror(machineId, sessionId);
    });
  mirrorReads.set(key, read);
}

const answerSchema = boundary.object({ success: boundary.boolean, error: boundary.optional(boundary.string) });

/**
 * The host's one-call read of a Session: view, tabs, layout and newest 200 messages, read-only
 * (`peek` creates no tab and starts no agent). At most one per Session at a time.
 */
function readRemoteSession(machineId: string, sessionId: string): Promise<RemoteSessionEntry | undefined> {
  const key = remoteSessionKey(machineId, sessionId);
  const pending = hostReads.get(key);
  if (pending) return pending;
  switchMark('remote:peek:start', { machineId, sessionId });
  const read = window.electronAPI.machines.read(machineId, 'orchestration-sessions:peek', [{ sessionId }, PEEK_OPTIONS])
    .then(result => {
      const answer = decodeOptionalBoundary(result.data, answerSchema);
      switchMark('remote:peek:end', { machineId, sessionId, status: answer?.success === true ? 'ok' : 'failed' });
      if (!answer?.success) throw new Error(answer?.error ?? 'The machine could not show this Session');
      // SAFETY: a successful `peek` answers an OrchestrationSessionOpenResult, which the host's own handler built; its success was just checked.
      const data = (result.data as { data: OrchestrationSessionOpenResult<Session> }).data;
      patch(machineId, sessionId, { read: data, readAt: performance.now(), error: undefined });
      return cachedRemoteSession(machineId, sessionId);
    })
    .catch((error: Error) => {
      patch(machineId, sessionId, { error: error.message });
      return cachedRemoteSession(machineId, sessionId);
    })
    .finally(() => { hostReads.delete(key); });
  hostReads.set(key, read);
  return read;
}

/** A newer mirror copy of the Session on screen is read at once. */
function followMirror(): void {
  if (followingMirror) return;
  followingMirror = true;
  useMachineMirrorStore.subscribe(() => {
    const target = useRemoteSessionView.getState().target;
    if (target) readMirror(target.machineId, target.sessionId);
  });
}

/**
 * The cursor moved onto another machine's Session row: show it now. The mirror's copy is read at
 * once (local); a Session the mirror lacks is read from its host only if the cursor stays on it.
 */
export function showRemoteSession(target: RemoteSessionTarget): void {
  followMirror();
  clearTimeout(restTimer);
  restTimer = undefined;
  if (!sameTarget(useRemoteSessionView.getState().target, target)) {
    switchMark('remote:cursor', { machineId: target.machineId, sessionId: target.sessionId });
    useRemoteSessionView.setState({ target: { ...target } });
  }
  const { machineId, sessionId } = target;
  // The mirror's copy paints at once; the host's read (its newest 200 messages, or all a Session
  // the mirror lacks has) waits until the cursor stays.
  readMirror(machineId, sessionId);
  const held = cachedRemoteSession(machineId, sessionId);
  if (held?.read && performance.now() - held.readAt < FRESH_READ_MS) return;
  restTimer = setTimeout(() => {
    restTimer = undefined;
    if (isTarget(machineId, sessionId) && machineOnline(machineId)) void readRemoteSession(machineId, sessionId);
  }, REMOTE_READ_REST_MS);
}

/** Nothing of another machine shows under the cursor any more. */
export function clearRemoteSession(): void {
  clearTimeout(restTimer);
  restTimer = undefined;
  if (useRemoteSessionView.getState().target) useRemoteSessionView.setState({ target: undefined });
}

/** Which Session of a machine a chat tab belongs to, from what is held. */
function sessionOfChat(machineId: string, panelId: string): string | undefined {
  const target = useRemoteSessionView.getState().target;
  const entries = useRemoteSessionView.getState().entries;
  const owns = (entry: RemoteSessionEntry | undefined) => entry?.read?.chat?.panelId === panelId || entry?.snapshot?.chat.panelId === panelId;
  if (target?.machineId === machineId && owns(entries[remoteSessionKey(machineId, target.sessionId)])) return target.sessionId;
  const prefix = remoteSessionKey(machineId, '');
  const found = Object.entries(entries).find(([key, entry]) => key.startsWith(prefix) && owns(entry));
  return found?.[0].slice(prefix.length);
}

/** The newest chat window held for the Session: the host's read when it is the newer, else the mirror's. */
export function heldRemoteChat(entry: RemoteSessionEntry | undefined): ChatTabView | undefined {
  const read = entry?.read?.chat;
  const mirrored = entry?.snapshot?.chat;
  if (!read) return mirrored;
  if (!mirrored || mirrored.panelId !== read.panelId) return read;
  return (read.transcript?.revision ?? -1) >= (mirrored.transcript?.revision ?? -1) || read.generation > mirrored.generation ? read : mirrored;
}

/** A host event that doesn't decode is dropped (the viewer reads the window again on the next gap). */
function decodeOrDrop<Value>(decode: () => Value): Value | undefined {
  try {
    return decode();
  } catch (error) {
    console.warn('[Remote Session] Dropped a chat event that did not decode:', error);
    return undefined;
  }
}

function refused(machineName: string): Promise<never> {
  return Promise.reject(new Error(`This Session is on ${machineName}. Press Enter or click it to continue there; nothing was sent.`));
}

const clients = new Map<string, ChatTabClient>();
/**
 * The same, for the view held over the main area while an engage switches (T-132): its own
 * viewers, which draw the newest 30 messages only, so holding the view never draws 200 again.
 */
const heldClients = new Map<string, ChatTabClient>();
/** Earlier-message reads under way, by machine, panel and page: a second ask for the same page shares the first. */
const historyReads = new Map<string, Promise<AgentChatMessage[]>>();
const historyStatusSchema = boundary.object({ messages: boundary.json, unavailable: boundary.optional(boundary.boolean) });

/** The newest status each remote chat's live view reported, by panel id. */
const liveStatuses = new Map<string, string>();

/** Whether the held copy or the live view says the chat is starting on its host. */
function startingThere(machineId: string, panelId: string): boolean {
  const sessionId = sessionOfChat(machineId, panelId);
  const held = sessionId ? heldRemoteChat(cachedRemoteSession(machineId, sessionId)) : undefined;
  return held?.status === 'starting' || liveStatuses.get(panelId) === 'starting';
}

/** The conversation run (generation) of the chat held for a panel of this machine. */
function heldGeneration(machineId: string, panelId: string): number | undefined {
  const sessionId = sessionOfChat(machineId, panelId);
  return sessionId ? heldRemoteChat(cachedRemoteSession(machineId, sessionId))?.generation : undefined;
}

/** Whether the host said this chat's earlier messages can't be read until it runs, in this run (`generation`) of it (D-19). */
export function earlierUnavailable(machineId: string, panelId: string, generation: number): boolean {
  return useRemoteSessionView.getState().earlierUnavailable[remoteSessionKey(machineId, panelId)] === generation;
}
/** Remote chats the cursor has stayed on, keyed by machine and panel: their reads answer every message held. */
const fullChats = new Set<string>();

/** The cursor stayed on the chat (`full`), or left it: its next read answers everything held, or the newest 30 again. */
export function showFullRemoteChat(machineId: string, panelId: string, full: boolean): void {
  const key = remoteSessionKey(machineId, panelId);
  if (full) fullChats.add(key);
  else fullChats.delete(key);
}


/**
 * A read-only chat client for one machine's Sessions shown under the cursor: reads answer at once
 * from what is held (the mirror's copy, or the host's one `peek` once it landed); events come from the one chat this
 * window follows on that machine (`machine-chat:follow`). Anything that acts on the chat is refused:
 * engaging (typing, Enter, a click) switches the window first, in PR 7.
 */
export function remoteChatClient(machineId: string, machineName: string, { held = false }: { held?: boolean } = {}): ChatTabClient {
  const cache = held ? heldClients : clients;
  const known = cache.get(machineId);
  if (known) return known;
  const no = () => refused(machineName);
  const client: ChatTabClient = {
    // What is held, at once: the newest 30 messages until the cursor has stayed on the chat
    // (`showFullRemoteChat`), so a chat passed over never draws 200; everything held after that.
    async get(panelId) {
      const sessionId = sessionOfChat(machineId, panelId);
      const chat = heldRemoteChat(sessionId ? cachedRemoteSession(machineId, sessionId) : undefined);
      if (!chat || chat.panelId !== panelId) throw new Error(`Pane has nothing of this chat from ${machineName} yet.`);
      const full = !held && fullChats.has(remoteSessionKey(machineId, panelId));
      return full ? chat : firstPaintWindow(chat);
    },
    // A newer copy of a chat held for this machine (the mirror caught up, a host read landed): its viewer reads it.
    // A gap in a shown chat's live events, or a new run (its agent started on the host): the held copies
    // can't close it, so the host is read, unless a read started since the newest event was heard.
    resync(panelId) {
      const sessionId = sessionOfChat(machineId, panelId);
      if (!sessionId || !isTarget(machineId, sessionId) || !machineOnline(machineId)) return undefined;
      return readForLive(machineId, sessionId, panelId);
    },
    // Only the shown Session's copy, and only one carrying more than its live events already did (a
    // copy behind them would draw nothing new: the viewer keeps the newer window anyway).
    onReconnect(callback) {
      const shownChat = () => {
        const { target, entries } = useRemoteSessionView.getState();
        return target?.machineId === machineId ? heldRemoteChat(entries[remoteSessionKey(machineId, target.sessionId)]) : undefined;
      };
      let seen = heldVersion(shownChat());
      return useRemoteSessionView.subscribe(() => {
        const chat = shownChat();
        const now = heldVersion(chat);
        const changed = now !== '' && now !== seen;
        seen = now;
        if (changed && chat && !behindLive(chat.panelId, chat)) callback();
      });
    },
    // "Earlier messages" (D-19): the host's own `chat-tab:history`, which reads saved messages and starts
    // nothing, served only for your own machines (OWNER_ONLY_MACHINE_READS). One read per chat at a time.
    history(panelId, before, limit) {
      if (!machineOnline(machineId)) return Promise.reject(new Error(`${machineName} is offline: its earlier messages load once it is back.`));
      // The host said earlier messages can't be read until this chat runs there: not again in this run.
      const generation = heldGeneration(machineId, panelId);
      if (generation !== undefined && earlierUnavailable(machineId, panelId, generation)) return Promise.resolve([]);
      const key = `${remoteSessionKey(machineId, panelId)}\u0000${before}:${limit}`;
      const pending = historyReads.get(key);
      if (pending) return pending;
      const read = window.electronAPI.machines.read(machineId, 'chat-tab:history', [panelId, before, limit, { withStatus: true }])
        .then(result => {
          // A host from before D-19's status answers the bare list.
          const status = decodeOptionalBoundary(result.data, historyStatusSchema);
          if (!status) return decodeChatMessages(result.data);
          // Not while the chat is starting there: it can read them once it has (review of da3ce7c).
          if (status.unavailable === true && generation !== undefined && !startingThere(machineId, panelId)) {
            useRemoteSessionView.setState(state => ({ earlierUnavailable: { ...state.earlierUnavailable, [remoteSessionKey(machineId, panelId)]: generation } }));
          }
          return decodeChatMessages(status.messages);
        })
        .finally(() => { historyReads.delete(key); });
      historyReads.set(key, read);
      return read;
    },
    send: no, receipt: async () => undefined, unqueue: no, sendNow: no, editQueued: no, clear: no, stopTask: no,
    configure: no, cancel: no, permission: no, answer: no, restart: no, conversations: async () => [], resume: no,
    dismissBanner: no, files: async () => [], signIn: no,
    agents: () => window.electronAPI?.chatTab?.agents() ?? Promise.resolve([]),
    onEvent(callback) {
      return machineMirrorApi()?.onChatEvent(event => {
        if (event.machineId !== machineId || event.channel !== 'chat-tab:event') return;
        const decoded = decodeOrDrop(() => decodeChatTabEvent(event.payload));
        if (!decoded) return;
        heardLive(decoded.panelId, decoded.generation, decoded.revision);
        callback(decoded);
      }) ?? (() => undefined);
    },
    onState(callback) {
      return machineMirrorApi()?.onChatEvent(event => {
        if (event.machineId !== machineId || event.channel !== 'chat-tab:view') return;
        const decoded = decodeOrDrop(() => decodeChatTabView(event.payload));
        if (!decoded) return;
        heardLive(decoded.panelId, decoded.generation, 0);
        liveStatuses.set(decoded.panelId, decoded.status);
        callback(decoded);
      }) ?? (() => undefined);
    },
  };
  cache.set(machineId, client);
  return client;
}
