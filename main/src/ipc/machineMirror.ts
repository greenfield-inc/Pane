import type { IpcMain, WebContents } from 'electron';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { MachineConnections } from '../services/machineConnections';
import type { MachineMirror } from '../services/machineMirror';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { MACHINE_MIRROR_CHANNELS, type MachineChatEvent, type MachineMirrorListing } from '../../../shared/types/machineMirror';
import type { SessionSnapshot } from '../../../shared/types/sessionSnapshot';

/** What main tells the mirror's handlers. */
export interface MachineMirrorHandlers {
  /** The mirror exists now: follow it, and have windows that listed before list again. */
  mirrorReady(): void;
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
export function registerMachineMirrorHandlers(ipcMain: IpcMain, mirror: () => MachineMirror | null, machines: MachineConnections): MachineMirrorHandlers {
  const subscribers = new Set<WebContents>();
  let unsubscribe: (() => void) | undefined;
  const follow = () => {
    const current = mirror();
    if (unsubscribe || !current) return;
    unsubscribe = current.subscribe(change => {
      for (const contents of subscribers) {
        if (contents.isDestroyed()) subscribers.delete(contents);
        else contents.send(MACHINE_MIRROR_CHANNELS.changed, change);
      }
    });
  };
  ipcMain.on(MACHINE_MIRROR_CHANNELS.subscribe, (event, on: PaneCommandValue) => {
    if (decodeBoundary(on, boundary.boolean)) subscribers.add(event.sender);
    else subscribers.delete(event.sender);
    follow();
  });
  ipcMain.handle(MACHINE_MIRROR_CHANNELS.list, (): MachineMirrorListing[] => {
    follow();
    return mirror()?.listings() ?? [];
  });
  ipcMain.handle(MACHINE_MIRROR_CHANNELS.session, async (_event, machineId: PaneCommandValue, sessionId: PaneCommandValue): Promise<SessionSnapshot | null> => {
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
      for (const contents of subscribers) {
        if (contents.isDestroyed()) subscribers.delete(contents);
        else contents.send(MACHINE_MIRROR_CHANNELS.changed, { machineId: '' });
      }
    },
  };
}
