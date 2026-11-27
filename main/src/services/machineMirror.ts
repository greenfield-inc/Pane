import { promises } from 'fs';
import path from 'path';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { MachineConnectionsEvent, MachineResult, MachineState } from '../../../shared/types/machineConnections';
import type { MachineMirrorFile, MachineMirrorState } from '../../../shared/types/machineMirror';
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

/** Notices from one machine that arrive within this long are read together (the All machines feed's pace). */
const BATCH_MS = 250;
/** The fewest milliseconds between two saves of one machine's file. */
const SAVE_INTERVAL_MS = 2000;
/** A machine's mirror never holds more than this; the Sessions changed longest ago are left out first. */
const DEFAULT_CAP_BYTES = 25 * 1024 * 1024;
/** The file of a machine that hasn't answered for this long is removed. */
const UNSEEN_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Room for the file's own fields beside its Sessions when counting its size. */
const FILE_OVERHEAD_BYTES = 256;

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
  sessions: Map<string, { snapshot: SessionSnapshot; bytes: number }>;
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
const fileSchema = boundary.object({
  version: boundary.literal(1),
  machineId: boundary.nonEmptyString,
  epoch: boundary.nullable(boundary.string),
  revision: boundary.number,
  lastSeenAt: boundary.nullable(boundary.string),
  sessions: boundary.array(boundary.json),
});
const noticeSchema = boundary.object({ sessionId: boundary.nonEmptyString, revision: boundary.number });

/**
 * The desktop mirror (T-116 PR 5): a copy of the chat Sessions on each of the owner's other
 * machines, read from their host snapshots (`orchestration-sessions:snapshots`) and kept in
 * `<PANE_DIR>/machine-mirror/<machine id>.json` (mode 0600, D-4). It reads once when a machine
 * connects or resyncs, and after its `session-snapshot:changed` notices, 250 ms at a time. A
 * machine this computer only watches, or whose host refuses it as not the owner, is never copied
 * (D-5); its file is removed, as is a forgotten machine's and one not seen for 30 days.
 */
export class MachineMirror {
  private readonly mirrors = new Map<string, Mirror>();
  /** Machines left alone until they reconnect: by the connection (`onlineSince`) that refused or lacked snapshots. */
  private readonly ignored = new Map<string, string | undefined>();
  private readonly listeners = new Set<(change: { machineId: string }) => void>();
  private readonly removals = new Set<Promise<void>>();
  private readonly capBytes: number;
  private unsubscribe?: () => void;
  private sweep?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly options: MachineMirrorOptions) {
    this.capBytes = options.capBytes ?? DEFAULT_CAP_BYTES;
  }

  /** Loads the saved copies of the owner's machines, removes the rest, and follows the machines from now on. */
  async start(): Promise<void> {
    await this.loadSaved();
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
    return { machineId, sync, lastSeenAt: mirror.lastSeenAt, sessionCount: mirror.sessions.size };
  }

  session(machineId: string, sessionId: string): SessionSnapshot | undefined {
    return this.mirrors.get(machineId)?.sessions.get(sessionId)?.snapshot;
  }

  sessions(machineId: string): SessionSnapshot[] {
    return [...(this.mirrors.get(machineId)?.sessions.values() ?? [])].map(entry => entry.snapshot);
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
    if (!notice || (mirror.sessions.get(notice.sessionId)?.snapshot.revision ?? -1) >= notice.revision) return;
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
        if (answer.code === 'SESSION_SNAPSHOTS_OWNER_ONLY') {
          this.ignore(mirror.machineId);
          return;
        }
        throw new Error(answer.error ?? 'The machine refused the read');
      }
      if (this.mirrors.get(mirror.machineId) !== mirror) return;
      const checked = decodeBoundary(answer.data, resultSchema);
      for (const snapshot of checked.snapshots) decodeBoundary(snapshot, snapshotSchema);
      // SAFETY: the host's SessionSnapshotService wrote the answer, and its fields and each snapshot's identifying and merged fields were just checked.
      this.apply(mirror, (result.data as { data: SessionSnapshotsResult }).data);
    } catch (error) {
      // A Pane without snapshots keeps opening its Sessions with Enter, as today.
      if (error instanceof PaneError && error.code === 'ERR_HOST_OUTDATED') {
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

  private apply(mirror: Mirror, result: SessionSnapshotsResult): void {
    // A new run of the host sends each Session whole: nothing held from the old run is joined to it.
    const sameRun = mirror.epoch === result.epoch;
    const listed = new Set(result.sessionIds);
    for (const sessionId of [...mirror.sessions.keys()]) {
      if (!listed.has(sessionId)) mirror.sessions.delete(sessionId);
    }
    for (const sent of result.snapshots) {
      const snapshot = merged(sameRun ? mirror.sessions.get(sent.sessionId)?.snapshot : undefined, sent);
      mirror.sessions.set(snapshot.sessionId, { snapshot, bytes: Buffer.byteLength(JSON.stringify(snapshot)) });
    }
    mirror.revision = result.revision;
    mirror.epoch = result.epoch;
    mirror.lastSeenAt = new Date().toISOString();
    this.keepUnderCap(mirror);
    this.scheduleSave(mirror);
  }

  /** Leaves out the Sessions changed longest ago until the copy fits its cap. */
  private keepUnderCap(mirror: Mirror): void {
    let total = FILE_OVERHEAD_BYTES + [...mirror.sessions.values()].reduce((sum, entry) => sum + entry.bytes + 1, 0);
    if (total <= this.capBytes) return;
    const oldestFirst = [...mirror.sessions.values()].sort((left, right) => left.snapshot.session.updatedAt.localeCompare(right.snapshot.session.updatedAt));
    for (const entry of oldestFirst) {
      if (total <= this.capBytes) break;
      mirror.sessions.delete(entry.snapshot.sessionId);
      total -= entry.bytes + 1;
    }
  }

  private scheduleSave(mirror: Mirror): void {
    if (mirror.save) return;
    mirror.save = setTimeout(() => {
      mirror.save = undefined;
      this.saveNow(mirror);
    }, Math.max(0, mirror.savedAt + SAVE_INTERVAL_MS - Date.now()));
  }

  private saveNow(mirror: Mirror): void {
    mirror.savedAt = Date.now();
    const file: MachineMirrorFile = {
      version: 1, machineId: mirror.machineId, epoch: mirror.epoch, revision: mirror.revision, lastSeenAt: mirror.lastSeenAt,
      sessions: [...mirror.sessions.values()].map(entry => entry.snapshot),
    };
    const contents = JSON.stringify(file);
    mirror.writes = mirror.writes.then(() => this.write(mirror.machineId, contents)).catch(error => {
      console.warn(`[Machine mirror] Could not save ${mirror.machineId}'s copy:`, error instanceof Error ? error.message : error);
    });
  }

  private async write(machineId: string, contents: string): Promise<void> {
    await promises.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const file = this.fileOf(machineId);
    const temporary = `${file}.${process.pid}.tmp`;
    await promises.writeFile(temporary, contents, { mode: 0o600 });
    await promises.rename(temporary, file);
  }

  /** Drops a machine's copy and its file. */
  private forget(machineId: string): void {
    const mirror = this.mirrors.get(machineId);
    this.mirrors.delete(machineId);
    if (mirror) {
      clearTimeout(mirror.batch);
      clearTimeout(mirror.save);
    }
    const removal = (mirror?.writes ?? Promise.resolve())
      .then(() => promises.rm(this.fileOf(machineId), { force: true }))
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

  private async loadSaved(): Promise<void> {
    let names: string[];
    try {
      names = await promises.readdir(this.options.directory);
    } catch {
      return;
    }
    const mine = new Set(this.options.machines.list().filter(isMine).map(machine => machine.id));
    for (const name of names) {
      const file = path.join(this.options.directory, name);
      if (!name.endsWith('.json')) {
        // A save interrupted part-way.
        if (name.endsWith('.tmp')) await promises.rm(file, { force: true });
        continue;
      }
      const saved = await this.readSaved(file);
      if (!saved || !mine.has(saved.machineId) || unseenTooLong(saved.lastSeenAt) || file !== this.fileOf(saved.machineId)) {
        await promises.rm(file, { force: true });
        continue;
      }
      const mirror = emptyMirror(saved.machineId);
      mirror.revision = saved.revision;
      mirror.epoch = saved.epoch;
      mirror.lastSeenAt = saved.lastSeenAt;
      for (const snapshot of saved.sessions) mirror.sessions.set(snapshot.sessionId, { snapshot, bytes: Buffer.byteLength(JSON.stringify(snapshot)) });
      this.mirrors.set(saved.machineId, mirror);
    }
  }

  private async readSaved(file: string): Promise<MachineMirrorFile | undefined> {
    try {
      const parsed = JSON.parse(await promises.readFile(file, 'utf8'));
      for (const session of decodeBoundary(parsed, fileSchema).sessions) decodeBoundary(session, snapshotSchema);
      // SAFETY: this mirror wrote the file, and its fields and each Session's identifying fields were just checked.
      return parsed as MachineMirrorFile;
    } catch (error) {
      console.warn(`[Machine mirror] Removing an unreadable copy (${path.basename(file)}):`, error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  private removeUnseen(): void {
    for (const mirror of [...this.mirrors.values()]) {
      if (unseenTooLong(mirror.lastSeenAt) && this.state(mirror.machineId)?.sync === 'offline') this.forget(mirror.machineId);
    }
  }

  private fileOf(machineId: string): string {
    return path.join(this.options.directory, `${encodeURIComponent(machineId)}.json`);
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

/** The owner's own saved machines: never this computer, and never one it only watches (D-5). */
function isMine(machine: MachineState): boolean {
  return machine.kind === 'remote' && machine.access !== 'read';
}

function unseenTooLong(lastSeenAt: string | null): boolean {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  return Number.isNaN(seen) || Date.now() - seen > UNSEEN_LIMIT_MS;
}

function emptyMirror(machineId: string): Mirror {
  return { machineId, epoch: null, revision: 0, lastSeenAt: null, sessions: new Map(), reading: false, again: false, due: false, savedAt: -Infinity, writes: Promise.resolve() };
}

/** Everything changed since the last read, with only the messages changed since the ones held; everything after a host restart. */
function requestOf(mirror: Mirror): SessionSnapshotsRequest {
  const request: SessionSnapshotsRequest = {};
  if (!mirror.epoch) return request;
  request.epoch = mirror.epoch;
  request.since = mirror.revision;
  const held: Record<string, SessionSnapshotHeld> = {};
  for (const [sessionId, { snapshot }] of mirror.sessions) {
    const transcript = snapshot.chat.transcript;
    if (transcript) held[sessionId] = { generation: transcript.generation, count: transcript.start + transcript.messages.length, revision: transcript.revision };
  }
  if (Object.keys(held).length > 0) request.held = held;
  return request;
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

