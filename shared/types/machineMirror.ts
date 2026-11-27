import type { JsonValue } from '../validation/boundaryDecoder';
import type { SessionSnapshotHeld } from './sessionSnapshot';

/**
 * The desktop mirror (T-116 PR 5): this computer's copy of the chat Sessions on each of the owner's
 * other machines, kept from their host snapshots so a Session shows at once, and while its
 * machine is offline. One folder per machine in `<PANE_DIR>/machine-mirror/` (0700): its
 * `index.json` and one file per Session, each 0600 (D-4).
 */

/** The folder in the Pane data folder that holds one mirror folder per machine. */
export const MACHINE_MIRROR_FOLDER = 'machine-mirror';

/** How current a machine's mirror is. */
export type MachineMirrorSync =
  /** Connected, and the last read caught up with every change it announced. */
  | 'live'
  /** Connected, and a read is under way or due (just reconnected, or a change was announced). */
  | 'catching-up'
  /** Not connected: the mirror shows what the machine last sent, as of `lastSeenAt`. */
  | 'offline';

export interface MachineMirrorState {
  machineId: string;
  sync: MachineMirrorSync;
  /** When the machine last answered a read (ISO 8601); null before its first. */
  lastSeenAt: string | null;
  sessionCount: number;
}

/** What the mirror knows of one Session without reading its file: enough to ask the host for what changed. */
export interface MachineMirrorIndexEntry {
  /** The snapshot's host revision. */
  revision: number;
  /** The size of its file, counted against the machine's cap. */
  bytes: number;
  /** The transcript window held, sent back to the host as `held`; absent for a Session with no chat. */
  held?: SessionSnapshotHeld;
}

/** A machine's `index.json`, in `<PANE_DIR>/machine-mirror/<machine id>/`, beside one file per Session. */
export interface MachineMirrorIndexFile {
  version: 2;
  machineId: string;
  /** The host run (`epoch`) of the last read; null before the first. */
  epoch: string | null;
  /** The host's `revision` from the last read, sent back as `since`. */
  revision: number;
  lastSeenAt: string | null;
  sessions: Record<string, MachineMirrorIndexEntry>;
}

/** One mirrored machine as the renderer reads it (T-116 PR 6): how current it is, and each Session's host revision. */
export interface MachineMirrorListing {
  state: MachineMirrorState;
  /** Session id → the snapshot revision held. */
  sessions: Record<string, number>;
}

/** The renderer's channels for the mirror and for following a shown chat on another machine. */
export const MACHINE_MIRROR_CHANNELS = {
  /** Every mirrored machine's `MachineMirrorListing`. */
  list: 'machine-mirror:list',
  /** `(machineId, sessionId)` → the Session's `SessionSnapshot`, or null when it isn't mirrored. */
  session: 'machine-mirror:session',
  /** Pushed with `{ machineId }` when a machine's copy or state changed, to windows that sent `subscribe`. */
  changed: 'machine-mirror:changed',
  subscribe: 'machine-mirror:subscribe',
  /** `(machineId, panelId)` or `(null)`: the one chat on another machine this window shows, whose events it gets. */
  followChat: 'machine-chat:follow',
  /** Pushed with `{ machineId, channel, payload }`: one of the followed chat's `chat-tab:event` or `chat-tab:view`. */
  chatEvent: 'machine-chat:event',
} as const;

export interface MachineChatEvent {
  machineId: string;
  channel: 'chat-tab:event' | 'chat-tab:view';
  /** As the host sent it; the renderer checks its fields before applying it. */
  payload: JsonValue;
}
