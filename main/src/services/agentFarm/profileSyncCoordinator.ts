import { PaneError, reasonOf } from '../../../../shared/paneError';
import {
  PROFILE_SYNC_CHANNELS,
  PROFILE_SYNC_OFF_CODE,
  isNewerSave,
  profileSyncApplyResultSchema,
  profileSyncChunkSchema,
  profileSyncExportSchema,
  profileSyncStateSchema,
  sameSave,
  type ProfileSyncApplyRequest,
  type ProfileSyncApplyResult,
  type ProfileSyncComputer,
  type ProfileSyncRecord,
  type ProfileSyncState,
  type ProfileSyncStatus,
} from '../../../../shared/types/profileSync';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import type { PaneCommandValue } from '../../daemon/commandRegistry';
import { sendFile, writeResultSchema, type WriteRequest } from '../sessionMove/transfer';
import type { ProfileSyncHost } from './profileSync';
import type { ProfileSyncPeerMemory } from './profileSyncFile';

/** Waits after a trigger, so a burst of saves or reconnects syncs once. */
const DEBOUNCE_MS = 500;
/** How long a computer has to answer for its records before it counts as offline for this sync. */
const STATE_TIMEOUT_MS = 5_000;
/** How long one transfer call (a pack chunk, an install) may take. */
const TRANSFER_TIMEOUT_MS = 120_000;

/** One of your other computers, as the desktop reaches it: a saved machine, or a loopback test peer. */
export interface ProfileSyncPeer {
  /** The desktop's stable key for it (a saved machine's id). */
  key: string;
  name: string;
  /** False: known to be offline, so not asked; undefined: ask and see. */
  online?: boolean;
  invoke(channel: string, args: PaneCommandValue[], timeoutMs: number): Promise<PaneCommandValue>;
}

export interface ProfileSyncCoordinatorOptions {
  local: ProfileSyncHost;
  peers: () => ProfileSyncPeer[];
  /** This computer's install id, sent so a computer can tell who asks. */
  machine: () => string;
  onStatus?: (status: ProfileSyncStatus) => void;
  /** The Profiles switch (D-474): while it is off nothing syncs. Absent: always on. */
  enabled?: () => boolean;
}

interface SyncRun {
  /** Only these plugins (a Session about to start or reload); all when absent. */
  plugins?: Set<string>;
  /** Only this computer. */
  only?: string;
  /** Sync now: send every plugin to every computer again. */
  force?: boolean;
}

interface Reached {
  peer: ProfileSyncPeer;
  state: ProfileSyncState;
}

const codedSchema = boundary.object({ code: boundary.string });

/** The Profiles switch went off (or the coordinator stopped) mid-run: the rest of the run is dropped (review F-11). */
class SyncStopped extends Error {}

async function call<T>(peer: ProfileSyncPeer, channel: string, args: PaneCommandValue[], schema: BoundarySchema<T>, timeoutMs = TRANSFER_TIMEOUT_MS): Promise<T> {
  return decodeBoundary(await peer.invoke(channel, args, timeoutMs), schema);
}

/**
 * The desktop's side of profile sync (T-63 PR 6), on the shared-key pattern (sharedCredentialSync.ts):
 * it reads every computer's records over the machine connection, brings this computer up to the
 * newest save of each plugin, then sends that save to every computer that is behind. Computers never
 * contact each other. Runs on start, after a save here, when a computer reconnects or reports a change,
 * and for one plugin before a Session starts or reloads it; Sync now sends everything again.
 * A computer that can't be reached keeps what it had and gets the changes when it is next reached.
 */
export class ProfileSyncCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private lastSyncAt: number | undefined;
  private readonly computers = new Map<string, ProfileSyncComputer>();
  private stopped = false;

  constructor(private readonly options: ProfileSyncCoordinatorOptions) {}

  /** Syncs everything soon; a burst of requests syncs once. */
  request(): void {
    if (this.stopped || !this.enabled()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue({});
    }, DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Brings one plugin up to date here and on `only` (or every computer), before a Session uses it. Never throws. */
  async syncPlugin(plugin: string, only?: string): Promise<void> {
    await this.enqueue({ plugins: new Set([plugin]), only });
  }

  /** Sync now: sends every profile to every computer again, and answers with each computer's state. */
  async syncNow(): Promise<ProfileSyncStatus> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.enqueue({ force: true });
    return this.status();
  }

  /** A computer asked for this one's records: if it was offline here, it is back, so sync. */
  peerSeen(machine: string): void {
    const known = [...this.computers.values()].some(computer => computer.state === 'up-to-date' && computer.id === machine);
    if (!known) this.request();
  }

  status(): ProfileSyncStatus {
    const unknown = (peer: ProfileSyncPeer): ProfileSyncComputer => ({ key: peer.key, id: '', name: peer.name, state: 'offline', waiting: [] });
    // A saved machine the connection already knows is offline shows so now, not at the next sync (QA F-4).
    const live = (peer: ProfileSyncPeer, computer: ProfileSyncComputer): ProfileSyncComputer =>
      (peer.online === false && computer.state === 'up-to-date' ? { ...computer, state: 'offline', waiting: [] } : computer);
    const status: ProfileSyncStatus = { computers: this.options.peers().map(peer => live(peer, { ...(this.computers.get(peer.key) ?? unknown(peer)), name: peer.name })), running: this.running > 0 };
    if (this.lastSyncAt !== undefined) status.lastSyncAt = this.lastSyncAt;
    return status;
  }

  private enabled(): boolean {
    return this.options.enabled?.() ?? true;
  }

  private enqueue(run: SyncRun): Promise<void> {
    const next = this.queue.then(() => this.run(run)).catch(error => console.warn(`[ProfileSync] Sync failed: ${reasonOf(error)}`));
    this.queue = next;
    return next;
  }

  private announce(): void {
    this.options.onStatus?.(this.status());
  }

  /** Throws SyncStopped once the switch is off: checked before each new call, pull, push and write (review F-11). */
  private check(): void {
    if (this.stopped || !this.enabled()) throw new SyncStopped();
  }

  private async run(run: SyncRun): Promise<void> {
    if (this.stopped || !this.enabled()) return;
    this.running += 1;
    this.announce();
    try {
      await this.reconcile(run);
    } catch (error) {
      // An install already under way on a computer finishes there (it holds that computer's lock); nothing new starts.
      // The host here refuses on its own once the switch is off, which ends the run the same way.
      if (!(error instanceof SyncStopped) && !this.stopped && this.enabled()) throw error;
    } finally {
      this.running -= 1;
      this.lastSyncAt = Date.now();
      this.announce();
    }
  }

  private async reconcile(run: SyncRun): Promise<void> {
    // A Session about to start reads only its own profile's records and files (review F-4).
    const scope = run.plugins ? [...run.plugins] : undefined;
    // A run for one plugin or one computer doesn't learn whole-computer status (review F-14).
    const partial = Boolean(run.plugins || run.only);
    const local = await this.options.local.state(undefined, scope);
    const memory = await this.options.local.peerMemory();
    // Every reachable computer is asked, so the newest save is found wherever it is; `only` limits
    // where it is delivered, not where it is looked for (review F-6).
    const peers = this.options.peers();
    const deliver = (entry: Reached) => !run.only || entry.peer.key === run.only;
    const reached: Reached[] = [];
    const failures = new Map<string, { plugins: Set<string>; error?: string }>();
    const fail = (entry: Reached, plugin: string, error: string) => {
      const failure = failures.get(entry.peer.key) ?? { plugins: new Set<string>() };
      failure.plugins.add(plugin);
      failure.error ??= error;
      failures.set(entry.peer.key, failure);
    };
    let again = false;
    await Promise.all(peers.map(async peer => {
      if (peer.online === false) return partial ? undefined : this.setOffline(peer, memory[peer.key], local);
      try {
        this.check();
        const ask = scope ? { from: this.options.machine(), plugins: scope } : { from: this.options.machine() };
        reached.push({ peer, state: await call(peer, PROFILE_SYNC_CHANNELS.state, [ask], profileSyncStateSchema, STATE_TIMEOUT_MS) });
      } catch (error) {
        // A computer whose Pane has no profile sync commands answers that it doesn't know the channel.
        const code = error instanceof PaneError ? error.code : decodeOptionalBoundary(error, codedSchema)?.code;
        if (code === PROFILE_SYNC_OFF_CODE) {
          this.computers.set(peer.key, { key: peer.key, id: memory[peer.key]?.machine ?? '', name: peer.name, state: 'off', waiting: [], error: `Profiles is off on ${peer.name}. Turn it on there to sync.` });
        } else if (code === 'ERR_UNKNOWN_CHANNEL' || /no pane daemon command registered/i.test(reasonOf(error))) {
          this.computers.set(peer.key, { key: peer.key, id: memory[peer.key]?.machine ?? '', name: peer.name, state: 'outdated', waiting: [], error: `Pane on ${peer.name} is too old to sync profiles. Update Pane there.` });
        } else if (!(error instanceof SyncStopped) && !partial) {
          this.setOffline(peer, memory[peer.key], local);
        }
      }
    }));
    this.check();

    const names = new Set([...Object.keys(local.plugins), ...reached.flatMap(entry => Object.keys(entry.state.plugins))]);
    for (const plugin of [...names].sort()) {
      if (run.plugins && !run.plugins.has(plugin)) continue;
      let newest: ProfileSyncRecord | undefined = local.plugins[plugin];
      let source: Reached | undefined;
      for (const entry of reached) {
        const record = entry.state.plugins[plugin];
        if (record && isNewerSave(record, newest) && !sameSave(record, newest)) { newest = record; source = entry; }
      }
      if (!newest) continue;
      if (source) {
        this.check();
        try {
          await this.pull(source.peer, plugin);
          local.plugins[plugin] = newest;
        } catch (error) {
          if (error instanceof SyncStopped) throw error;
          // This computer doesn't have the newest save, so it can't send it on; the Sync sheet says so (review F-8).
          console.warn(`[ProfileSync] ${plugin} didn't arrive from ${source.peer.name}: ${reasonOf(error)}`);
          fail(source, plugin, `${plugin} couldn't be fetched from ${source.peer.name}: ${reasonOf(error)}`);
          continue;
        }
      }
      const behind = reached.filter(entry => entry !== source && deliver(entry) && (run.force || !sameSave(entry.state.plugins[plugin], newest)));
      if (!behind.length) continue;
      let exported: Awaited<ReturnType<ProfileSyncHost['export']>> | undefined;
      this.check();
      try {
        exported = await this.options.local.export(plugin);
        for (const entry of behind) {
          this.check();
          try {
            const result = await this.push(entry.peer, plugin, exported, run.force === true);
            // A computer that saved meanwhile keeps its newer save and says so: remember that, and sync again to bring it here (review F-8).
            if (result.record && !sameSave(result.record, exported.record) && isNewerSave(result.record, exported.record)) {
              entry.state.plugins[plugin] = result.record;
              again = true;
            } else {
              entry.state.plugins[plugin] = exported.record;
            }
          } catch (error) {
            if (error instanceof SyncStopped) throw error;
            fail(entry, plugin, `${plugin} didn't reach ${entry.peer.name}: ${reasonOf(error)}`);
          }
        }
      } catch (error) {
        if (error instanceof SyncStopped) throw error;
        console.warn(`[ProfileSync] Pane couldn't pack ${plugin} to send: ${reasonOf(error)}`);
        for (const entry of behind) fail(entry, plugin, `${plugin} couldn't be packed to send: ${reasonOf(error)}`);
      } finally {
        if (exported?.transferId) await this.options.local.discard(exported.transferId);
      }
    }

    this.check();
    const now = Date.now();
    const remembered = { ...memory } satisfies Record<string, ProfileSyncPeerMemory>;
    for (const entry of reached) {
      // A partial run was answered with only its plugins' records: the rest are remembered as they were.
      const plugins = partial ? { ...memory[entry.peer.key]?.plugins, ...entry.state.plugins } : entry.state.plugins;
      remembered[entry.peer.key] = { name: entry.state.name || entry.peer.name, machine: entry.state.machine, plugins, seenAt: now };
      const failure = failures.get(entry.peer.key);
      const before = this.computers.get(entry.peer.key);
      if (failure) {
        // A partial run adds its failures to what is already waiting there.
        const waiting = new Set([...(partial && before?.state === 'failed' ? before.waiting : []), ...failure.plugins]);
        this.computers.set(entry.peer.key, { key: entry.peer.key, id: entry.state.machine, name: entry.peer.name, state: 'failed', waiting: [...waiting].sort(), error: failure.error });
      } else if (!partial) {
        // Only a full sync says a computer is up to date.
        this.computers.set(entry.peer.key, { key: entry.peer.key, id: entry.state.machine, name: entry.peer.name, state: 'up-to-date', waiting: [] });
      }
    }
    if (!partial) {
      // Offline computers' waiting lists use this computer's records after the sync.
      const after = await this.options.local.state();
      for (const peer of peers) {
        if (this.computers.get(peer.key)?.state === 'offline') this.setOffline(peer, remembered[peer.key], after);
      }
    }
    for (const key of Object.keys(remembered)) {
      if (!this.options.peers().some(peer => peer.key === key)) delete remembered[key];
    }
    this.check();
    if (reached.length || Object.keys(remembered).length !== Object.keys(memory).length) await this.options.local.rememberPeers(remembered);
    if (again) this.request();
  }

  /** An unreachable computer gets every save it hasn't had when it is next reached. */
  private setOffline(peer: ProfileSyncPeer, memory: ProfileSyncPeerMemory | undefined, local: ProfileSyncState): void {
    const waiting = Object.entries(local.plugins)
      .filter(([plugin, record]) => !sameSave(memory?.plugins[plugin], record) && !(record.state === 'deleted' && !memory?.plugins[plugin]))
      .map(([plugin]) => plugin)
      .sort();
    this.computers.set(peer.key, { key: peer.key, id: memory?.machine ?? '', name: peer.name, state: 'offline', waiting });
  }

  /** Reads a computer's newest save of a plugin in checked chunks, and installs it here. */
  private async pull(peer: ProfileSyncPeer, plugin: string): Promise<void> {
    const exported = await call(peer, PROFILE_SYNC_CHANNELS.export, [{ plugin }], profileSyncExportSchema);
    if (!exported.transferId || !exported.pack) {
      await this.options.local.apply({ plugin, record: exported.record });
      return;
    }
    let offset = 0;
    for (;;) {
      const chunk = await call(peer, PROFILE_SYNC_CHANNELS.read, [{ transferId: exported.transferId, offset }], profileSyncChunkSchema);
      const write: WriteRequest = { moveId: exported.transferId, path: exported.pack.path, offset, content: chunk.content };
      if (chunk.last) write.last = chunk.last;
      await this.options.local.write(write);
      offset += Buffer.byteLength(chunk.content, 'base64');
      if (chunk.last) break;
    }
    await this.options.local.apply({ plugin, record: exported.record, transferId: exported.transferId, pack: exported.pack });
  }

  /** Sends this computer's save of a plugin to a computer in checked chunks, and has it installed there. */
  private async push(peer: ProfileSyncPeer, plugin: string, exported: Awaited<ReturnType<ProfileSyncHost['export']>>, force: boolean): Promise<ProfileSyncApplyResult> {
    const request: ProfileSyncApplyRequest = { plugin, record: exported.record };
    if (force) request.force = true;
    if (exported.transferId && exported.pack) {
      const transferId = exported.transferId;
      const sender = { write: async (write: WriteRequest) => call(peer, PROFILE_SYNC_CHANNELS.write, [write], writeResultSchema) };
      request.pack = await sendFile(sender, transferId, exported.pack.path, this.options.local.packFile(transferId));
      request.transferId = transferId;
    }
    return call(peer, PROFILE_SYNC_CHANNELS.apply, [request], profileSyncApplyResultSchema);
  }
}
