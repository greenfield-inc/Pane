import type { IpcMain, WebContents } from 'electron';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { MachineConnections } from '../services/machineConnections';
import type { MachineMirror } from '../services/machineMirror';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { MACHINE_MIRROR_CHANNELS, type MachineChatEvent, type MachineMirrorListing } from '../../../shared/types/machineMirror';
import { SESSION_SNAPSHOT_CHANGED_CHANNEL, type SessionSnapshot } from '../../../shared/types/sessionSnapshot';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';

/** What main tells the mirror's handlers. */
export interface MachineMirrorHandlers {
  /** The mirror exists now: follow it, and have windows that listed before list again. */
  mirrorReady(): void;
}

/**
 * This computer's own Session snapshots (`SessionSnapshotService`, PR 4), read as one more listing
 * (T-116 D-20): a window showing another machine shows this computer's rows read-only from them, as
 * it does every other machine of the owner's, with no copy kept on disk.
 */
export interface LocalSessionSnapshots {
  index(): Promise<Array<{ sessionId: string; revision: number }>>;
  snapshot(sessionId: string): Promise<SessionSnapshot | undefined>;
}

const followSchema = boundary.nullable(boundary.object({ machineId: boundary.nonEmptyString, panelId: boundary.nonEmptyString }));

/**
 * The renderer's reads of the desktop mirror (T-116 PR 6, D-12): `machine-mirror:list` (each mirrored
 * machine's state and Session revisions, from memory) and `machine-mirror:session` (one Session's
 * snapshot, from memory or its file), with `machine-mirror:changed` pushed to each window that
 * subscribed. And `machine-chat:follow`: the one chat on another machine a window shows, whose
 * `chat-tab:event` and `chat-tab:view` it then gets on `machine-chat:event`, and no other chat's.
 * The mirror starts after the windows can call, so it is read through `mirror()`; before then every
 * list is empty and every Session missing. Main calls the returned `mirrorReady` once it exists, so
 * a window that subscribed before then hears its changes, and lists again (review SF-2).
 */
export function registerMachineMirrorHandlers(ipcMain: IpcMain, mirror: () => MachineMirror | null, machines: MachineConnections, local?: LocalSessionSnapshots): MachineMirrorHandlers {
  const subscribers = new Set<WebContents>();
  const notify = (change: { machineId: string }) => {
    for (const contents of subscribers) {
      if (contents.isDestroyed()) subscribers.delete(contents);
      else contents.send(MACHINE_MIRROR_CHANNELS.changed, change);
    }
  };
  // This computer's snapshot notices (forwarded as its machine events) are its listing's changes.
  if (local) {
    machines.subscribe(event => {
      if (event.type === 'event' && event.machineId === LOCAL_MACHINE_ID && event.channel === SESSION_SNAPSHOT_CHANGED_CHANNEL) notify({ machineId: LOCAL_MACHINE_ID });
    });
  }
  let unsubscribe: (() => void) | undefined;
  const follow = () => {
    const current = mirror();
    if (unsubscribe || !current) return;
    unsubscribe = current.subscribe(notify);
  };
  ipcMain.on(MACHINE_MIRROR_CHANNELS.subscribe, (event, on: PaneCommandValue) => {
    if (decodeBoundary(on, boundary.boolean)) subscribers.add(event.sender);
    else subscribers.delete(event.sender);
    follow();
  });
  ipcMain.handle(MACHINE_MIRROR_CHANNELS.list, async (): Promise<MachineMirrorListing[]> => {
    follow();
    const listings = mirror()?.listings() ?? [];
    const own = await local?.index().catch(() => undefined);
    if (!own) return listings;
    const state = { machineId: LOCAL_MACHINE_ID, sync: 'live' as const, lastSeenAt: new Date().toISOString(), sessionCount: own.length };
    return [...listings, { state, sessions: Object.fromEntries(own.map(entry => [entry.sessionId, entry.revision])) }];
  });
  ipcMain.handle(MACHINE_MIRROR_CHANNELS.session, async (_event, machineId: PaneCommandValue, sessionId: PaneCommandValue): Promise<SessionSnapshot | null> => {
    const id = decodeBoundary(machineId, boundary.nonEmptyString);
    if (id === LOCAL_MACHINE_ID) return (await local?.snapshot(decodeBoundary(sessionId, boundary.nonEmptyString))) ?? null;
    const current = mirror();
    if (!current) return null;
    return (await current.session(decodeBoundary(machineId, boundary.nonEmptyString), decodeBoundary(sessionId, boundary.nonEmptyString))) ?? null;
  });

  // Each window follows at most one chat; naming another (or null) replaces it. One `destroyed`
  // listener per window stops whatever it follows then (review SF-3).
  const followed = new Map<WebContents, () => void>();
  const watched = new WeakSet<WebContents>();
  const unfollow = (contents: WebContents) => {
    followed.get(contents)?.();
    followed.delete(contents);
  };
  ipcMain.on(MACHINE_MIRROR_CHANNELS.followChat, (event, target: PaneCommandValue) => {
    const contents = event.sender;
    unfollow(contents);
    const chat = decodeBoundary(target ?? null, followSchema);
    if (!chat) return;
    if (!watched.has(contents)) {
      watched.add(contents);
      contents.once('destroyed', () => unfollow(contents));
    }
    const stop = machines.followChat(chat.machineId, chat.panelId, (channel, payload) => {
      if (contents.isDestroyed()) {
        unfollow(contents);
        return;
      }
      const message: MachineChatEvent = { machineId: chat.machineId, channel, payload };
      contents.send(MACHINE_MIRROR_CHANNELS.chatEvent, message);
    });
    followed.set(contents, stop);
  });

  return {
    mirrorReady: () => {
      follow();
      // Windows that listed before the mirror existed got nothing: they list again.
      notify({ machineId: '' });
    },
  };
}
