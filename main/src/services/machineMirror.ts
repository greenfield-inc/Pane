import { promises } from 'fs';
import path from 'path';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { PaneError } from '../../../shared/paneError';
import { RemoteRequestError } from '../../../shared/remoteClient/remoteDaemonClient';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { MachineConnectionsEvent, MachineResult, MachineState } from '../../../shared/types/machineConnections';
import type { MachineMirrorIndexEntry, MachineMirrorIndexFile, MachineMirrorState } from '../../../shared/types/machineMirror';
import {
  SESSION_SNAPSHOT_CHANGED_CHANNEL,
  SESSION_SNAPSHOT_MESSAGE_LIMIT,
  SESSION_SNAPSHOTS_CHANNEL,
  type SessionSnapshot,
  type SessionSnapshotHeld,
  type SessionSnapshotsRequest,
  type SessionSnapshotsResult,
} from '../../../shared/types/sessionSnapshot';
import type { ChatTabTranscript } from '../../../shared/types/chatTab';
import { projectSnapshot } from './sessionSnapshots';

/** Notices from one machine that arrive within this long are read together (the All machines feed's pace). */
const BATCH_MS = 250;
/** The fewest milliseconds between two saves of one machine's file. */
const SAVE_INTERVAL_MS = 2000;
/** A machine's mirror never holds more than this; the Sessions changed longest ago are left out first. */
const DEFAULT_CAP_BYTES = 25 * 1024 * 1024;
/** The file of a machine that hasn't answered for this long is removed. */
const UNSEEN_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Snapshots kept in memory across every machine, most recently read or changed (matching the renderer's `KEPT_SESSIONS`); the rest are read from their files. */
export const MIRROR_MEMORY_SESSIONS = 30;
const INDEX_FILE = 'index.json';

/** What the mirror needs of the desktop's machine connections (`MachineConnections`). */
export interface MirrorMachines {
  list(): MachineState[];
  subscribe(listener: (event: MachineConnectionsEvent) => void): () => void;
  read(machineId: string, channel: string, args: PaneCommandValue[]): Promise<MachineResult>;
}

export interface MachineMirrorOptions {
  /** `<PANE_DIR>/machine-mirror`. */
  directory: string;
  machines: MirrorMachines;
  capBytes?: number;
}

interface Mirror {
  machineId: string;
  /** The host run (`epoch`) the copy was read from; `revision` and `held` mean something only to it. */
  epoch: string | null;
  revision: number;
  lastSeenAt: string | null;
  /** Every Session copied, without its content: what `requestOf`, the cap and the notices need. */
  index: Map<string, MachineMirrorIndexEntry>;
  /** Snapshots changed since the last save; each leaves once its file is written. */
  pending: Map<string, SessionSnapshot>;
  /** Sessions dropped since the last save, whose files the next save deletes. */
  removed: Set<string>;
  /** Ask for every Session next time, not only those changed since `revision`: a held copy was lost and must be sent whole. */
  whole: boolean;
  /** The connection (its `onlineSince`) this mirror last read on connect. */
  connectedAt?: string;
  reading: boolean;
  /** Read again once the read under way ends. */
  again: boolean;
  /** A change was announced, or the last read failed: not caught up. */
  due: boolean;
  batch?: ReturnType<typeof setTimeout>;
  save?: ReturnType<typeof setTimeout>;
  savedAt: number;
  /** Saves and the removal of this machine's file run one after another. */
  writes: Promise<void>;
}

const answerSchema = boundary.object({
  success: boundary.boolean,
  data: boundary.optional(boundary.json),
  error: boundary.optional(boundary.string),
  code: boundary.optional(boundary.string),
});
const snapshotSchema = boundary.object({
  sessionId: boundary.nonEmptyString,
  revision: boundary.number,
  session: boundary.object({ updatedAt: boundary.string }),
  chat: boundary.object({
    transcript: boundary.optional(boundary.object({ generation: boundary.number, start: boundary.number, messages: boundary.array(boundary.json) })),
  }),
});
const resultSchema = boundary.object({
  revision: boundary.number,
  epoch: boundary.string,
  sessionIds: boundary.array(boundary.string),
  snapshots: boundary.array(boundary.json),
});
const heldSchema = boundary.object({ generation: boundary.number, count: boundary.number, revision: boundary.number });
const indexSchema = boundary.object({
  version: boundary.literal(2),
  machineId: boundary.nonEmptyString,
  epoch: boundary.nullable(boundary.string),
  revision: boundary.number,
  lastSeenAt: boundary.nullable(boundary.string),
  sessions: boundary.record(boundary.object({ revision: boundary.number, bytes: boundary.number, held: boundary.optional(heldSchema) })),
});
const noticeSchema = boundary.object({ sessionId: boundary.nonEmptyString, revision: boundary.number });

/**
 * The desktop mirror (T-116 PR 5): a copy of the chat Sessions on each of the owner's other
 * machines, read from their host snapshots (`orchestration-sessions:snapshots`) and kept in
 * `<PANE_DIR>/machine-mirror/<machine id>/` (folder 0700): an `index.json` and one file per Session,
 * each 0600 (D-4). Main holds each machine's index and the 30 Sessions read or changed most
 * recently (D-12); any other Session is read from its file. It reads once when a machine connects
 * or resyncs, and after its `session-snapshot:changed` notices, 250 ms at a time. Only machines
 * this computer marks as the person's own are copied (D-5, D-13); a machine it only watches, or
 * whose host refuses it as not the owner, is never copied and its folder is removed, as is a
 * forgotten machine's and one not seen for 30 days.
 */
export class MachineMirror {
  private readonly mirrors = new Map<string, Mirror>();
  /** Machines left alone until they reconnect: by the connection (`onlineSince`) that refused or lacked snapshots. */
  private readonly ignored = new Map<string, string | undefined>();
  private readonly listeners = new Set<(change: { machineId: string }) => void>();
  private readonly removals = new Set<Promise<void>>();
  /** The snapshots kept in memory, every machine together, least recently used first; keyed `machine\0session`. */
  private readonly recent = new Map<string, SessionSnapshot>();
  private readonly capBytes: number;
  private unsubscribe?: () => void;
  private sweep?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly options: MachineMirrorOptions) {
    this.capBytes = options.capBytes ?? DEFAULT_CAP_BYTES;
  }

  /** Loads the saved indexes of the owner's machines, removes the rest, and follows the machines from now on. */
  async start(): Promise<void> {
    await this.loadSaved();
    // A folder made by an earlier build, or by hand, is made readable only by this user too.
    if (process.platform !== 'win32') await promises.chmod(this.options.directory, 0o700).catch(() => undefined);
    this.unsubscribe = this.options.machines.subscribe(event => this.onEvent(event));
    this.sweep = setInterval(() => this.removeUnseen(), DAY_MS);
    this.sweep.unref?.();
    this.reconcile(this.options.machines.list());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    clearInterval(this.sweep);
    for (const mirror of this.mirrors.values()) clearTimeout(mirror.batch);
    await this.flush();
  }

  /** Saves every machine with unsaved changes now, and waits for removals under way. */
  async flush(): Promise<void> {
    for (const mirror of this.mirrors.values()) {
      if (!mirror.save) continue;
      clearTimeout(mirror.save);
      mirror.save = undefined;
      this.saveNow(mirror);
    }
    await Promise.all([...[...this.mirrors.values()].map(mirror => mirror.writes), ...this.removals]);
  }

  /** How current a machine's copy is; undefined for a machine that isn't copied. */
  state(machineId: string): MachineMirrorState | undefined {
    const mirror = this.mirrors.get(machineId);
    if (!mirror) return undefined;
    const machine = this.options.machines.list().find(entry => entry.id === machineId);
    const sync = machine?.status !== 'online' ? 'offline' : mirror.reading || mirror.due ? 'catching-up' : 'live';
    return { machineId, sync, lastSeenAt: mirror.lastSeenAt, sessionCount: mirror.index.size };
  }

  /** The Sessions a machine's copy holds and their host revisions, from memory (for the arrow keys, PR 6). */
  index(machineId: string): Array<{ sessionId: string; revision: number }> {
    return [...(this.mirrors.get(machineId)?.index ?? [])].map(([sessionId, entry]) => ({ sessionId, revision: entry.revision }));
  }

  /** One Session's copy: from memory when it was read or changed lately, else from its file. */
  async session(machineId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
    const mirror = this.mirrors.get(machineId);
    return mirror ? this.load(mirror, sessionId) : undefined;
  }

  /** A machine's copy or its state changed. Returns the unsubscribe. */
  subscribe(listener: (change: { machineId: string }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private onEvent(event: MachineConnectionsEvent): void {
    if (this.stopped) return;
    if (event.type === 'machines') {
      this.reconcile(event.machines);
      return;
    }
    const mirror = this.mirrors.get(event.machineId);
    if (!mirror) return;
    if (event.type === 'resync') {
      void this.read(mirror);
      return;
    }
    if (event.channel !== SESSION_SNAPSHOT_CHANGED_CHANNEL) return;
    const notice = decodeOptionalBoundary(event.args[0], noticeSchema);
    if (!notice || (mirror.index.get(notice.sessionId)?.revision ?? -1) >= notice.revision) return;
    mirror.due = true;
    mirror.batch ??= setTimeout(() => {
      mirror.batch = undefined;
      void this.read(mirror);
    }, BATCH_MS);
    this.changed(mirror.machineId);
  }

  /** Follows the saved machines: copies the owner's, reads one that has just connected, and removes the rest. */
  private reconcile(machines: MachineState[]): void {
    const wanted = new Map(machines.filter(isMine).map(machine => [machine.id, machine]));
    for (const machineId of [...this.mirrors.keys()]) {
      if (!wanted.has(machineId)) this.forget(machineId);
    }
    for (const machine of wanted.values()) {
      if (this.ignored.has(machine.id)) {
        if (this.ignored.get(machine.id) === machine.onlineSince || machine.status !== 'online') continue;
        this.ignored.delete(machine.id);
      }
      let mirror = this.mirrors.get(machine.id);
      if (!mirror) {
        mirror = emptyMirror(machine.id);
        this.mirrors.set(machine.id, mirror);
      }
      if (machine.status === 'online' && machine.onlineSince !== mirror.connectedAt) {
        mirror.connectedAt = machine.onlineSince;
        void this.read(mirror);
      }
      this.changed(machine.id);
    }
  }

  /** One `snapshots {since, held}` read, applied; a read asked for during another runs once it ends. */
  private async read(mirror: Mirror): Promise<void> {
    if (mirror.reading) {
      mirror.again = true;
      return;
    }
    mirror.reading = true;
    mirror.due = false;
    this.changed(mirror.machineId);
    try {
      const result = await this.options.machines.read(mirror.machineId, SESSION_SNAPSHOTS_CHANNEL, [requestOf(mirror)]);
      const answer = decodeBoundary(result.data, answerSchema);
      if (!answer.success) {
        if (answer.code === 'SESSION_SNAPSHOTS_OWNER_ONLY' || answer.code === 'ERR_UNKNOWN_CHANNEL') {
          this.ignore(mirror.machineId);
          return;
        }
        throw new Error(answer.error ?? 'The machine refused the read');
      }
      if (this.mirrors.get(mirror.machineId) !== mirror) return;
      const checked = decodeBoundary(answer.data, resultSchema);
      for (const snapshot of checked.snapshots) decodeBoundary(snapshot, snapshotSchema);
      // SAFETY: the host's SessionSnapshotService wrote the answer, and its fields and each snapshot's identifying and merged fields were just checked.
      await this.apply(mirror, (result.data as { data: SessionSnapshotsResult }).data);
    } catch (error) {
      // A Pane without snapshots keeps opening its Sessions with Enter, as today.
      if (error instanceof Error && withoutSnapshots(error)) {
        this.ignore(mirror.machineId);
        return;
      }
      mirror.due = true;
      console.warn(`[Machine mirror] Could not read ${mirror.machineId}'s Sessions; keeping the last copy:`, error instanceof Error ? error.message : error);
    } finally {
      mirror.reading = false;
      if (this.mirrors.get(mirror.machineId) === mirror) {
        if (mirror.again) {
          mirror.again = false;
          void this.read(mirror);
        }
        this.changed(mirror.machineId);
      }
    }
  }

  private async apply(mirror: Mirror, result: SessionSnapshotsResult): Promise<void> {
    if (this.stopped) return;
    // A new run of the host sends each Session whole: nothing held from the old run is joined to it.
    const sameRun = mirror.epoch === result.epoch;
    const joined = await Promise.all(result.snapshots.map(async (sent): Promise<SessionSnapshot | undefined> => {
      // The host projects what it sends; the desktop projects it again, so it never stores more than the plan allows.
      const projected = projectSnapshot(sent);
      // A host that can't read the chat yet (it restarted) says nothing of its messages: the held ones stay, in any run.
      if (projected.transcriptUnknown === true) return withHeldMessages(mirror.index.has(sent.sessionId) ? await this.load(mirror, sent.sessionId) : undefined, projected);
      if (!sameRun || !joinsHeld(mirror.index.get(sent.sessionId), projected)) return merged(undefined, projected);
      // Only the messages after the held ones came: without the held copy they are not the chat. Read it whole again.
      const held = await this.load(mirror, sent.sessionId);
      return held ? merged(held, projected) : undefined;
    }));
    if (this.stopped || this.mirrors.get(mirror.machineId) !== mirror) return;
    const listed = new Set(result.sessionIds);
    for (const sessionId of [...mirror.index.keys()]) {
      if (!listed.has(sessionId)) this.drop(mirror, sessionId);
    }
    mirror.whole = false;
    for (const [at, snapshot] of joined.entries()) {
      if (snapshot) {
        this.store(mirror, snapshot);
        continue;
      }
      const entry = mirror.index.get(result.snapshots[at].sessionId);
      if (entry) delete entry.held;
      mirror.whole = true;
      mirror.again = true;
    }
    mirror.revision = result.revision;
    mirror.epoch = result.epoch;
    mirror.lastSeenAt = new Date().toISOString();
    this.keepUnderCap(mirror);
    this.scheduleSave(mirror);
  }

  /** A Session's copy, newest first from memory, then its unsaved change, then its file. */
  private async load(mirror: Mirror, sessionId: string): Promise<SessionSnapshot | undefined> {
    const key = recentKey(mirror.machineId, sessionId);
    const inMemory = (): SessionSnapshot | undefined => this.recent.get(key) ?? mirror.pending.get(sessionId);
    if (!mirror.index.has(sessionId)) return undefined;
    const held = inMemory();
    if (held) {
      this.remember(key, held);
      return held;
    }
    const read = await this.readSession(mirror.machineId, sessionId);
    // A change applied, or the Session dropped, while the file was read.
    if (this.mirrors.get(mirror.machineId) !== mirror || !mirror.index.has(sessionId)) return undefined;
    const newer = inMemory();
    if (newer) return newer;
    if (read) this.remember(key, read);
    return read;
  }

  private async readSession(machineId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
    try {
      const parsed = JSON.parse(await promises.readFile(this.sessionFileOf(machineId, sessionId), 'utf8'));
      if (decodeBoundary(parsed, snapshotSchema).sessionId !== sessionId) throw new Error('it holds another Session');
      // SAFETY: this mirror wrote the file from a projected snapshot, and its identifying and merged fields were just checked.
      return parsed as SessionSnapshot;
    } catch (error) {
      console.warn(`[Machine mirror] Could not read ${machineId}'s copy of ${sessionId}; it loads from the machine instead:`, error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  /** Puts a snapshot at the recent end of the memory list, dropping the least recent past 30. */
  private remember(key: string, snapshot: SessionSnapshot): void {
    this.recent.delete(key);
    this.recent.set(key, snapshot);
    for (const oldest of this.recent.keys()) {
      if (this.recent.size <= MIRROR_MEMORY_SESSIONS) break;
      this.recent.delete(oldest);
    }
  }

  private store(mirror: Mirror, snapshot: SessionSnapshot): void {
    const transcript = snapshot.chat.transcript;
    const entry: MachineMirrorIndexEntry = { revision: snapshot.revision, bytes: Buffer.byteLength(JSON.stringify(snapshot)) };
    if (transcript) entry.held = { generation: transcript.generation, count: transcript.start + transcript.messages.length, revision: transcript.revision };
    mirror.index.set(snapshot.sessionId, entry);
    mirror.pending.set(snapshot.sessionId, snapshot);
    mirror.removed.delete(snapshot.sessionId);
    this.remember(recentKey(mirror.machineId, snapshot.sessionId), snapshot);
  }

  private drop(mirror: Mirror, sessionId: string): void {
    mirror.index.delete(sessionId);
    mirror.pending.delete(sessionId);
    mirror.removed.add(sessionId);
    this.recent.delete(recentKey(mirror.machineId, sessionId));
  }

  /** Leaves out the Sessions whose snapshot changed longest ago (lowest host revision) until the copy fits its cap. */
  private keepUnderCap(mirror: Mirror): void {
    let total = [...mirror.index.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    if (total <= this.capBytes) return;
    const oldestFirst = [...mirror.index].sort(([, left], [, right]) => left.revision - right.revision);
    for (const [sessionId, entry] of oldestFirst) {
      if (total <= this.capBytes) break;
      this.drop(mirror, sessionId);
      total -= entry.bytes;
    }
  }

  private scheduleSave(mirror: Mirror): void {
    if (mirror.save || this.stopped) return;
    mirror.save = setTimeout(() => {
      mirror.save = undefined;
      this.saveNow(mirror);
    }, Math.max(0, mirror.savedAt + SAVE_INTERVAL_MS - Date.now()));
  }

  /** Writes each changed Session's file, deletes the dropped ones', then the index, so the index never names a file not yet written. */
  private saveNow(mirror: Mirror): void {
    mirror.savedAt = Date.now();
    const written = [...mirror.pending];
    const files = written.map(([sessionId, snapshot]) => ({ sessionId, contents: JSON.stringify(snapshot) }));
    const removed = [...mirror.removed];
    mirror.removed.clear();
    const index: MachineMirrorIndexFile = {
      version: 2, machineId: mirror.machineId, epoch: mirror.epoch, revision: mirror.revision, lastSeenAt: mirror.lastSeenAt,
      sessions: Object.fromEntries(mirror.index),
    };
    const indexContents = JSON.stringify(index);
    const folder = this.folderOf(mirror.machineId);
    mirror.writes = mirror.writes.then(async () => {
      await promises.mkdir(folder, { recursive: true, mode: 0o700 });
      for (const { sessionId, contents } of files) await writeAtomically(this.sessionFileOf(mirror.machineId, sessionId), contents);
      for (const sessionId of removed) await promises.rm(this.sessionFileOf(mirror.machineId, sessionId), { force: true });
      await writeAtomically(path.join(folder, INDEX_FILE), indexContents);
      // Only what this save wrote leaves memory; a change since stays for the next save.
      for (const [sessionId, snapshot] of written) {
        if (mirror.pending.get(sessionId) === snapshot) mirror.pending.delete(sessionId);
      }
    }).catch(error => {
      for (const sessionId of removed) if (!mirror.index.has(sessionId)) mirror.removed.add(sessionId);
      console.warn(`[Machine mirror] Could not save ${mirror.machineId}'s copy:`, error instanceof Error ? error.message : error);
    });
  }

  /** Drops a machine's copy and its folder. */
  private forget(machineId: string): void {
    const mirror = this.mirrors.get(machineId);
    this.mirrors.delete(machineId);
    if (mirror) {
      clearTimeout(mirror.batch);
      clearTimeout(mirror.save);
    }
    const prefix = recentKey(machineId, '');
    for (const key of [...this.recent.keys()]) if (key.startsWith(prefix)) this.recent.delete(key);
    const removal = (mirror?.writes ?? Promise.resolve())
      .then(() => promises.rm(this.folderOf(machineId), { recursive: true, force: true }))
      .catch(error => console.warn(`[Machine mirror] Could not remove ${machineId}'s copy:`, error instanceof Error ? error.message : error))
      .finally(() => this.removals.delete(removal));
    this.removals.add(removal);
    this.changed(machineId);
  }

  /** Not copied until it reconnects: its host refused this computer, or has no snapshots. */
  private ignore(machineId: string): void {
    this.ignored.set(machineId, this.options.machines.list().find(machine => machine.id === machineId)?.onlineSince);
    this.forget(machineId);
  }

  /** Reads each saved machine's index; removes the folders of machines not copied, and files no index names. */
  private async loadSaved(): Promise<void> {
    let names: string[];
    try {
      names = await promises.readdir(this.options.directory);
    } catch {
      return;
    }
    const mine = new Set(this.options.machines.list().filter(isMine).map(machine => machine.id));
    for (const name of names) {
      const entry = path.join(this.options.directory, name);
      const stat = await promises.lstat(entry).catch(() => undefined);
      if (!stat?.isDirectory()) {
        // A whole-machine file from before the per-Session layout, or a save interrupted part-way.
        await promises.rm(entry, { force: true });
        continue;
      }
      const saved = await this.readIndex(entry);
      if (!saved || !mine.has(saved.machineId) || unseenTooLong(saved.lastSeenAt) || entry !== this.folderOf(saved.machineId)) {
        await promises.rm(entry, { recursive: true, force: true });
        continue;
      }
      const mirror = emptyMirror(saved.machineId);
      mirror.revision = saved.revision;
      mirror.epoch = saved.epoch;
      mirror.lastSeenAt = saved.lastSeenAt;
      mirror.index = new Map(Object.entries(saved.sessions));
      const present = new Set(await promises.readdir(entry));
      const fileOf = (sessionId: string) => path.basename(this.sessionFileOf(saved.machineId, sessionId));
      for (const sessionId of [...mirror.index.keys()]) {
        // A Session whose file is gone (removed outside Pane) is read whole on the next connect.
        if (present.has(fileOf(sessionId))) continue;
        mirror.index.delete(sessionId);
        mirror.whole = true;
      }
      const files = new Set([INDEX_FILE, ...[...mirror.index.keys()].map(fileOf)]);
      for (const file of present) {
        // A Session written before a crash kept the index from naming it, or a save interrupted part-way.
        if (!files.has(file)) await promises.rm(path.join(entry, file), { recursive: true, force: true });
      }
      this.mirrors.set(saved.machineId, mirror);
    }
  }

  private async readIndex(folder: string): Promise<MachineMirrorIndexFile | undefined> {
    try {
      const parsed = decodeBoundary(JSON.parse(await promises.readFile(path.join(folder, INDEX_FILE), 'utf8')), indexSchema);
      return { ...parsed, version: 2 };
    } catch (error) {
      console.warn(`[Machine mirror] Removing an unreadable copy (${path.basename(folder)}):`, error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  private removeUnseen(): void {
    for (const mirror of [...this.mirrors.values()]) {
      if (unseenTooLong(mirror.lastSeenAt) && this.state(mirror.machineId)?.sync === 'offline') this.forget(mirror.machineId);
    }
  }

  private folderOf(machineId: string): string {
    return path.join(this.options.directory, encodeURIComponent(machineId));
  }

  private sessionFileOf(machineId: string, sessionId: string): string {
    return path.join(this.folderOf(machineId), `${encodeURIComponent(sessionId)}.json`);
  }

  private changed(machineId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener({ machineId });
      } catch (error) {
        console.warn('[Machine mirror] A listener failed:', error);
      }
    }
  }
}

/**
 * The person's own saved machines, as this computer establishes them (D-13): never this computer,
 * never one it only watches, and never one it has not marked as theirs (a teammate's, even with Full access).
 */
function isMine(machine: MachineState): boolean {
  return machine.kind === 'remote' && machine.access !== 'read' && machine.mine === true;
}

function unseenTooLong(lastSeenAt: string | null): boolean {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  return Number.isNaN(seen) || Date.now() - seen > UNSEEN_LIMIT_MS;
}

function recentKey(machineId: string, sessionId: string): string {
  return `${machineId}\0${sessionId}`;
}

/** A temporary file readable only by this user, then renamed over the file, so a reader sees the old copy or the new one. */
async function writeAtomically(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await promises.writeFile(temporary, contents, { mode: 0o600 });
  await promises.rename(temporary, file);
}

function emptyMirror(machineId: string): Mirror {
  return {
    machineId, epoch: null, revision: 0, lastSeenAt: null, index: new Map(), pending: new Map(), removed: new Set(), whole: false,
    reading: false, again: false, due: false, savedAt: -Infinity, writes: Promise.resolve(),
  };
}

/** Everything changed since the last read, with only the messages changed since the ones held; everything after a host restart. */
function requestOf(mirror: Mirror): SessionSnapshotsRequest {
  const request: SessionSnapshotsRequest = {};
  if (!mirror.epoch) return request;
  request.epoch = mirror.epoch;
  // After a lost copy, every Session is listed again; `held` still keeps the others to their changes.
  if (!mirror.whole) request.since = mirror.revision;
  const held: Record<string, SessionSnapshotHeld> = {};
  for (const [sessionId, entry] of mirror.index) if (entry.held) held[sessionId] = entry.held;
  if (Object.keys(held).length > 0) request.held = held;
  return request;
}

/** The host has no snapshots channel: an older Pane (`ERR_HOST_OUTDATED`), or one that answers it as unknown. */
function withoutSnapshots(error: Error): boolean {
  if (error instanceof PaneError) return error.code === 'ERR_HOST_OUTDATED' || error.code === 'ERR_UNKNOWN_CHANNEL';
  return error instanceof RemoteRequestError && error.code === 'ERR_UNKNOWN_CHANNEL';
}

/** A snapshot whose messages the host doesn't know yet, carrying the messages and count held for it, when any. */
function withHeldMessages(held: SessionSnapshot | undefined, next: SessionSnapshot): SessionSnapshot {
  const transcript = held?.chat.transcript;
  if (!held || !transcript) return next;
  return { ...next, chat: { ...next.chat, transcript, messageCount: held.chat.messageCount } };
}

/** Whether the held copy is needed to fill a window the host sent short: same conversation, fewer than 30 messages. */
function joinsHeld(entry: MachineMirrorIndexEntry | undefined, next: SessionSnapshot): boolean {
  const window = next.chat.transcript;
  return entry?.held !== undefined && window !== undefined && window.generation === entry.held.generation && window.messages.length < SESSION_SNAPSHOT_MESSAGE_LIMIT;
}

/**
 * A snapshot whose window joins the held one: the held messages before it, then its own (which
 * replace any held ones they overlap), newest 30 kept. A window that doesn't join replaces the held one.
 */
function merged(held: SessionSnapshot | undefined, next: SessionSnapshot): SessionSnapshot {
  const window = next.chat.transcript;
  const kept = held?.chat.transcript;
  if (!window) return next;
  const joins = kept && kept.generation === window.generation && window.start >= kept.start && window.start <= kept.start + kept.messages.length;
  const transcript: ChatTabTranscript = joins
    ? { ...window, start: kept.start, messages: [...kept.messages.slice(0, window.start - kept.start), ...window.messages] }
    : window;
  const extra = transcript.messages.length - SESSION_SNAPSHOT_MESSAGE_LIMIT;
  const newest = extra > 0 ? { ...transcript, start: transcript.start + extra, messages: transcript.messages.slice(extra) } : transcript;
  return { ...next, chat: { ...next.chat, transcript: newest } };
}

