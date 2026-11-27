import type { IpcMain, WebContents } from 'electron';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { MachineConnections } from '../services/machineConnections';
import type { MachineMirror } from '../services/machineMirror';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { MACHINE_MIRROR_CHANNELS, type MachineChatEvent, type MachineMirrorListing } from '../../../shared/types/machineMirror';
import type { SessionSnapshot } from '../../../shared/types/sessionSnapshot';

const followSchema = boundary.nullable(boundary.object({ machineId: boundary.nonEmptyString, panelId: boundary.nonEmptyString }));

/**
 * The renderer's reads of the desktop mirror (T-116 PR 6, D-12): `machine-mirror:list` (each mirrored
 * machine's state and Session revisions, from memory) and `machine-mirror:session` (one Session's
 * snapshot, from memory or its file), with `machine-mirror:changed` pushed to each window that
 * subscribed. And `machine-chat:follow`: the one chat on another machine a window shows, whose
 * `chat-tab:event` and `chat-tab:view` it then gets on `machine-chat:event`, and no other chat's.
 * The mirror starts after the windows can call, so it is read through `mirror()`; before then every
 * list is empty and every Session missing.
 */
export function registerMachineMirrorHandlers(ipcMain: IpcMain, mirror: () => MachineMirror | null, machines: MachineConnections): void {
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

  // Each window follows at most one chat; naming another (or null) replaces it.
  const followed = new Map<WebContents, () => void>();
  ipcMain.on(MACHINE_MIRROR_CHANNELS.followChat, (event, target: PaneCommandValue) => {
    const contents = event.sender;
    followed.get(contents)?.();
    followed.delete(contents);
    const chat = decodeBoundary(target ?? null, followSchema);
    if (!chat) return;
    const stop = machines.followChat(chat.machineId, chat.panelId, (channel, payload) => {
      if (contents.isDestroyed()) {
        followed.get(contents)?.();
        followed.delete(contents);
        return;
      }
      const message: MachineChatEvent = { machineId: chat.machineId, channel, payload };
      contents.send(MACHINE_MIRROR_CHANNELS.chatEvent, message);
    });
    followed.set(contents, stop);
    contents.once('destroyed', () => {
      if (followed.get(contents) !== stop) return;
      stop();
      followed.delete(contents);
    });
  });
}
