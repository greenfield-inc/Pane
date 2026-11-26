import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';
import yaml from 'js-yaml';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { PROFILE_NAME_PATTERN } from '../../../../shared/types/profileEditor';
import {
  PROFILE_SYNC_CHANNELS,
  PROFILE_SYNC_OFF_CODE,
  isNewerSave,
  profileSyncApplyRequestSchema,
  profileSyncRecordSchema,
  sameSave,
  type ProfileSyncApplyRequest,
  type ProfileSyncApplyResult,
  type ProfileSyncChunk,
  type ProfileSyncExport,
  type ProfileSyncRecord,
  type ProfileSyncRecordState,
  type ProfileSyncState,
} from '../../../../shared/types/profileSync';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { fileDigest } from '../../../../packages/runpane/src/checkedCopy';
import { MoveReceiver, writeRequestSchema, type WriteRequest, type WriteResult } from '../sessionMove/transfer';
import type { PaneCommandValue } from '../../daemon/commandRegistry';
import {
  BUNDLED_AGENT_FARM_PLUGINS,
  agentFarmConfigRoot,
  bundledAgentFarm,
  bundledAgentFarmProcess,
  installedState,
  reinstallBundledPlugin,
  runAgentFarm,
  type AgentFarmRunner,
  type BundledAgentFarm,
} from './bundledAgentFarm';
import { agentFarmReason, checkRelative, writeAtomic } from './profileEditor';
import { readProfileSync, writeProfileSync, type ProfileSyncFileData } from './profileSyncFile';

const gzip = promisify(zlib.gzip);
const BUNDLED: readonly string[] = BUNDLED_AGENT_FARM_PLUGINS;
/** Compressed bytes per read; base64 keeps an answer well under the 4 MiB a machine call returns. */
const READ_CHUNK_BYTES = 2 * 1024 * 1024;
/** An export nobody finished reading is removed after this long. */
const STALE_TRANSFER_MS = 30 * 60_000;
/** A display override file Agent Farm's `profiles set` writes: `<profile>.json`, and its photo `<profile>.svg`. */
const OVERRIDE_FILE = /^[a-z][a-z0-9_-]*\.(json|svg)$/;
/** Largest override file sync carries; Agent Farm takes a photo of at most 64 KB. */
const MAX_OVERRIDE_BYTES = 64 * 1024;
const TRANSFER_ID = /^[A-Za-z0-9-]{8,64}$/;
/** Largest pack Pane sends or takes (review F-10); greenfield, the largest shipped plugin, packs to about 2 MB. */
const MAX_PACK_BYTES = 64 * 1024 * 1024;
/** The folders of a plugin Agent Farm reads, besides plugin.yaml (Agent Farm's plugins.js). */
const SECTIONS = ['profiles', 'agents', 'skills', 'instructions', 'references'];
/**
 * Pane's own files in a plugin, which Agent Farm ignores and its install doesn't copy: the Profiles
 * tab's cover pages. Sync carries them itself and writes them after the install.
 */
const PANE_FILE = /^covers\/[a-z][a-z0-9_-]*\.(html|md)$/;
/** Written by a bundled reinstall while it runs (bundledAgentFarm.ts); a failed one is cleared on rollback. */
const INSTALLING_FILE = 'pane-installing.json';
const receiptSchema = boundary.object({ name: boundary.string, layout: boundary.optional(boundary.number) });

/** An error that means the path isn't there, as opposed to a read that failed. */
function notThere(error: NodeJS.ErrnoException | null | undefined): boolean {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function linkRefused(what: string): PaneError {
  return new PaneError('PROFILE_PATH_INVALID', `${what} is a link, which Pane doesn't follow, so it wasn't synced.`, 'Replace the link with the folder itself, then sync again.');
}

/** Whether an override file is one sync carries: an Agent Farm override name, of at most 64 KiB. */
function isOverride(name: string, bytes: Buffer): boolean {
  return OVERRIDE_FILE.test(name) && bytes.length <= MAX_OVERRIDE_BYTES;
}

/** A plugin's newest save, as it travels: its files (for `saved`) and your display overrides of its profiles, base64. */
interface ProfilePack {
  plugin: string;
  record: ProfileSyncRecord;
  files: Record<string, string>;
  /** The files of `profile-overrides/<plugin>/` (titles, descriptions and photos you set), by file name. */
  overrides: Record<string, string>;
}

const packSchema = boundary.object({
  plugin: boundary.nonEmptyString,
  record: profileSyncRecordSchema,
  files: boundary.record(boundary.string),
  overrides: boundary.record(boundary.string),
});

const profileSyncReadRequestSchema = boundary.object({ transferId: boundary.nonEmptyString, offset: boundary.refine(boundary.number, value => Number.isInteger(value) && value >= 0, 'expected a byte offset') });
const stderrSchema = boundary.object({ stderr: boundary.string });

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with every object's keys sorted, so two parses of the same YAML hash the same. */
function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = decodeOptionalBoundary(value, boundary.jsonObject);
  if (!object) return JSON.stringify(value);
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key] ?? null)}`).join(',')}}`;
}

/** plugin.yaml without the checksums and source a pack adds, so a packed copy hashes like the original. */
function manifestWithoutPack(content: string): JsonObject | undefined {
  let data: JsonObject | undefined;
  try { data = decodeOptionalBoundary(yaml.load(content), boundary.jsonObject); }
  catch { return undefined; }
  if (!data) return undefined;
  const { checksums: _checksums, source: _source, ...rest } = data;
  return rest;
}

/**
 * A plugin's sync hash: what a computer must hold for the save to be there. For `saved`, each file
 * Agent Farm reads (plugin.yaml as its data, without pack checksums) and your display overrides;
 * for `pane`, Pane's own version is each computer's own, so only your display overrides.
 */
export function packHash(state: ProfileSyncRecordState, files: Record<string, Buffer>, overrides: Record<string, Buffer>): string {
  if (state === 'deleted') return '';
  const lines: string[] = [];
  if (state === 'saved') {
    for (const [file, content] of Object.entries(files)) {
      const manifest = file === 'plugin.yaml' ? manifestWithoutPack(content.toString('utf8')) : undefined;
      lines.push(`file:${file}\t${manifest ? sha256(stableJson(manifest)) : sha256(content)}`);
    }
  }
  for (const [name, content] of Object.entries(overrides)) lines.push(`override:${name}\t${sha256(content)}`);
  return sha256(`${state}\n${lines.sort().join('\n')}`);
}

/** The checksums Agent Farm's pack writes into plugin.yaml: each section file's SHA-256 (plugins.js `inventory`). */
function packManifest(manifest: string, files: Record<string, Buffer>): string {
  const data = manifestWithoutPack(manifest) ?? {};
  const checksums = Object.fromEntries(Object.entries(files).filter(([file]) => SECTIONS.includes(file.split('/')[0])).sort(([a], [b]) => a.localeCompare(b)).map(([file, content]) => [file, sha256(content)]));
  return yaml.dump({ ...data, checksums }, { lineWidth: -1 });
}

/**
 * One change to this computer's profiles at a time: a save in the tab, an arriving save, a refresh of
 * the records. Work already holding the lock (a save inside a save) runs at once instead of waiting
 * for itself.
 */
class Lock {
  private tail: Promise<void> = Promise.resolve();
  private readonly held = new AsyncLocalStorage<true>();
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.held.getStore()) return work();
    const result = this.tail.then(() => this.held.run(true, work));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface ProfileSyncHostOptions {
  paneDir: string;
  /** This computer's Pane install id, which records name and ties settle on. */
  machine: () => string;
  /** The name the sidebar gives this computer. */
  name: () => string;
  /** The bundled Agent Farm; undefined finds it, null means this build has none. */
  bundle?: BundledAgentFarm | null;
  run?: AgentFarmRunner;
  now?: () => number;
  /** A plugin changed here because a save arrived from another computer. */
  onApplied?: (plugin: string) => void;
  /** Another computer asked for this one's records (`from` is its install id). */
  onPeerSeen?: (machine: string) => void;
  /** Largest pack sent or taken, in bytes; tests lower it. */
  maxPackBytes?: number;
  /** Called each time a plugin's receipt or files are read; tests count them. */
  onRead?: (kind: 'receipt' | 'files', plugin: string) => void;
  /**
   * The Profiles switch (D-474), checked again once work has the lock: a call that waited behind a
   * change here is refused if the switch went off meanwhile (review F-11). Absent: always on.
   */
  enabled?: () => boolean;
}

/** What a computer whose Profiles switch is off answers to every profile sync call. */
export function profilesOffError(): PaneError {
  return new PaneError(PROFILE_SYNC_OFF_CODE, 'Profiles is off on this computer, so it doesn\'t sync profiles. Nothing was changed.', 'Turn it on in Settings > Advanced > Experimental > Profiles on this computer.');
}

/** Whether a path is there; any error besides "not there" is thrown, not taken for absence (review F-3). */
async function present(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (notThere(error)) return false; throw error; });
}

/**
 * One computer's side of profile sync (T-63 PR 6): its records in sync.json, kept current with its
 * plugins; packs of its newest saves for another computer to read; and arriving packs, checked
 * (Session move's SHA-256 transfer, then `agent-farm plugin install`, which refuses a pack whose
 * files don't match its checksums) and installed. Every file it writes is inside
 * `<PANE_DIR>/agent-farm/{plugins,drafts,profile-overrides}`, besides sync.json and Agent Farm's own receipts.
 */
export class ProfileSyncHost {
  private readonly configRoot: string;
  private readonly lock = new Lock();
  private readonly receiver: MoveReceiver;

  constructor(private readonly options: ProfileSyncHostOptions) {
    this.configRoot = agentFarmConfigRoot(options.paneDir);
    this.receiver = new MoveReceiver(path.join(this.configRoot, 'drafts', '.incoming'), { maxFileBytes: this.maxPackBytes() });
  }

  private maxPackBytes(): number {
    return this.options.maxPackBytes ?? MAX_PACK_BYTES;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private bundle(): BundledAgentFarm {
    const bundle = this.options.bundle === undefined ? bundledAgentFarm() : this.options.bundle;
    if (!bundle) throw new PaneError('AGENT_FARM_MISSING', 'This Pane build does not include Agent Farm, so it can\'t install profiles from your other computers.', 'Reinstall Pane from runpane.com.');
    return bundle;
  }

  private pluginRoot(name: string): string {
    return path.join(this.configRoot, 'plugins', name);
  }

  /** Where Agent Farm's `profiles set` keeps your display overrides of a plugin's profiles. */
  private overridesFolder(plugin: string): string {
    return path.join(this.configRoot, 'profile-overrides', plugin);
  }

  /**
   * Whether `profile-overrides/<plugin>/` is there; throws when it, or `profile-overrides` itself,
   * is a link (review F-5) or can't be read, so a failed read is never taken for no overrides.
   */
  private async overridesThere(plugin: string): Promise<boolean> {
    const lstat = (folder: string) => fs.lstat(folder).catch((error: NodeJS.ErrnoException) => { if (notThere(error)) return undefined; throw error; });
    const parent = await lstat(path.dirname(this.overridesFolder(plugin)));
    if (!parent) return false;
    if (!parent.isDirectory()) throw linkRefused('The profile-overrides folder');
    const folder = await lstat(this.overridesFolder(plugin));
    if (!folder) return false;
    if (!folder.isDirectory()) throw linkRefused(`profile-overrides/${plugin}`);
    return true;
  }

  /**
   * Your display overrides of a plugin here, by file name, with the newest one's time. Only regular
   * files with an override name of at most 64 KiB are read; anything else (a link, a folder, another
   * name, a larger file) is left out and not synced.
   */
  private async readOverrides(plugin: string): Promise<{ overrides: Record<string, Buffer>; changedAt: number }> {
    const overrides: Record<string, Buffer> = {};
    let changedAt = 0;
    if (!await this.overridesThere(plugin)) return { overrides, changedAt };
    const folder = this.overridesFolder(plugin);
    for (const child of await fs.readdir(folder, { withFileTypes: true })) {
      if (!child.isFile() || !OVERRIDE_FILE.test(child.name)) continue;
      const file = path.join(folder, child.name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_OVERRIDE_BYTES) continue;
      const bytes = await fs.readFile(file);
      if (!isOverride(child.name, bytes)) continue;
      overrides[child.name] = bytes;
      changedAt = Math.max(changedAt, stat.mtimeMs);
    }
    return { overrides, changedAt };
  }

  /**
   * The plugin's files and your display overrides here, as they would travel. Strict: any file or
   * folder that can't be read throws, so a failed read is never taken for a missing file (review
   * F-1); a plugin, section or overrides folder that is a link is refused, so nothing outside Pane's
   * Agent Farm folder is read (F-5). Links inside a section are left out, as the Profiles tab leaves them out.
   */
  private async contents(name: string): Promise<{ files: Record<string, Buffer>; overrides: Record<string, Buffer>; changedAt: number }> {
    this.options.onRead?.('files', name);
    const root = this.pluginRoot(name);
    if (!(await fs.lstat(root)).isDirectory()) throw linkRefused(`plugins/${name}`);
    const files: Record<string, Buffer> = {};
    let changedAt = 0;
    const read = async (file: string, relative: string) => {
      files[relative] = await fs.readFile(file);
      changedAt = Math.max(changedAt, (await fs.stat(file)).mtimeMs);
    };
    const visit = async (folder: string): Promise<void> => {
      for (const child of await fs.readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, child.name);
        if (child.isDirectory()) await visit(full);
        else if (child.isFile()) await read(full, path.relative(root, full).split(path.sep).join('/'));
      }
    };
    for (const section of SECTIONS) {
      const folder = path.join(root, section);
      const stat = await fs.lstat(folder).catch((error: NodeJS.ErrnoException) => { if (notThere(error)) return undefined; throw error; });
      if (!stat) continue;
      if (!stat.isDirectory()) throw linkRefused(`plugins/${name}/${section}`);
      await visit(folder);
    }
    const manifest = path.join(root, 'plugin.yaml');
    const manifestStat = await fs.lstat(manifest).catch((error: NodeJS.ErrnoException) => { if (notThere(error)) return undefined; throw error; });
    if (manifestStat?.isFile()) await read(manifest, 'plugin.yaml');
    const covers = path.join(root, 'covers');
    const coversStat = await fs.lstat(covers).catch((error: NodeJS.ErrnoException) => { if (notThere(error)) return undefined; throw error; });
    if (coversStat && !coversStat.isDirectory()) throw linkRefused(`plugins/${name}/covers`);
    if (coversStat) {
      for (const child of await fs.readdir(covers, { withFileTypes: true })) {
        if (child.isFile() && PANE_FILE.test(`covers/${child.name}`)) await read(path.join(covers, child.name), `covers/${child.name}`);
      }
    }
    const { overrides, changedAt: overridesChangedAt } = await this.readOverrides(name);
    return { files, overrides, changedAt: Math.floor(Math.max(changedAt, overridesChangedAt)) };
  }

  /**
   * The plugins Agent Farm has receipts for, read strictly (review F-1): undefined when the receipts
   * folder can't be read; `unsure` holds plugins whose receipt couldn't be read, which are neither
   * refreshed nor taken for deleted. Pane's own plain plugin is left out. With `only`, just those
   * receipts are read, by name, so a Session's preflight never opens the others (review F-4).
   */
  private async receipts(only?: ReadonlySet<string>): Promise<{ names: string[]; unsure: Set<string> } | undefined> {
    const folder = path.join(this.configRoot, '.plugins');
    let entries: string[];
    if (only) {
      if (!(await fs.stat(folder).catch(() => undefined))?.isDirectory()) return undefined;
      // A receipt that can't even be looked at is read below, fails, and counts as unsure.
      entries = [...only].map(name => `${name}.json`);
    } else {
      try { entries = await fs.readdir(folder); }
      catch { return undefined; }
    }
    const names: string[] = [];
    const unsure = new Set<string>();
    for (const file of entries.filter(entry => entry.endsWith('.json')).sort()) {
      const name = file.slice(0, -'.json'.length);
      if (!PROFILE_NAME_PATTERN.test(name) || name === 'pane') continue;
      this.options.onRead?.('receipt', name);
      if (only && !await present(path.join(folder, file)).catch(() => true)) continue;
      try {
        const receipt = decodeOptionalBoundary(JSON.parse(await fs.readFile(path.join(this.configRoot, '.plugins', file), 'utf8')), receiptSchema);
        if (receipt?.layout === 2 && receipt.name === name) names.push(name);
        else unsure.add(name);
      } catch {
        unsure.add(name);
      }
    }
    return { names, unsure };
  }

  /** Whether a plugin's receipt is certainly gone: removed, not merely unreadable (review F-1). */
  private async receiptGone(name: string): Promise<boolean> {
    return fs.lstat(path.join(this.configRoot, '.plugins', `${name}.json`)).then(() => false, (error: NodeJS.ErrnoException) => notThere(error));
  }

  /** Whether a Pane plugin here is your copy: edited here, or an edited copy that arrived from another computer. */
  private async isYours(name: string, record: ProfileSyncRecord | undefined): Promise<boolean> {
    if (!BUNDLED.includes(name)) return true;
    return record?.state === 'saved' || await installedState(this.configRoot, name) === 'edited' || await this.hasPaneFiles(name);
  }

  /**
   * Whether a Pane plugin has a title (pane.yaml) or a cover page here. Pane's plugins ship neither,
   * and Agent Farm's receipt doesn't cover them, so one is an edit of yours (review F-13).
   */
  private async hasPaneFiles(name: string): Promise<boolean> {
    const root = this.pluginRoot(name);
    if ((await fs.lstat(path.join(root, 'pane.yaml')).catch(() => undefined))?.isFile()) return true;
    const covers = await fs.readdir(path.join(root, 'covers'), { withFileTypes: true }).catch(() => []);
    return covers.some(child => child.isFile() && PANE_FILE.test(`covers/${child.name}`));
  }

  /**
   * Brings sync.json up to date with the plugins here: a plugin whose files changed since its record
   * (a save, Restore, a title, description or photo, or an edit outside Pane) gets a new record; one with no record yet
   * gets one dated by its newest file; and a plugin of yours whose Agent Farm receipt is gone (removed
   * with `agent-farm plugin uninstall`) is recorded as deleted. A Pane plugin is never recorded as
   * deleted: a missing one is a Pane install that hasn't finished.
   *
   * `justSaved` is a save Pane made a moment ago, dated now. Any other change was made outside Pane,
   * perhaps while it was closed, so it is dated by its newest file (a deletion by when the receipt
   * went): a newer save on another computer still wins over it (QA F-1).
   */
  private async refreshUnlocked(justSaved = false, only?: ReadonlySet<string>): Promise<ProfileSyncFileData> {
    const data = await readProfileSync(this.configRoot);
    // What isn't certainly known is left as it is: a read that failed is never taken for a removal (review F-1).
    const receipts = await this.receipts(only);
    if (!receipts) {
      console.warn('[ProfileSync] Pane couldn\'t read Agent Farm\'s receipts folder, so no profile records were changed this time.');
      return data;
    }
    const wanted = (name: string) => !only || only.has(name);
    const names = receipts.names.filter(wanted);
    const machine = this.options.machine();
    let changed = false;
    for (const name of names) {
      const record = data.plugins[name];
      const state: ProfileSyncRecordState = await this.isYours(name, record) ? 'saved' : 'pane';
      let contents: Awaited<ReturnType<ProfileSyncHost['contents']>>;
      try { contents = await this.contents(name); }
      catch (error) {
        console.warn(`[ProfileSync] Pane couldn't read ${name} (${reasonOf(error)}), so its record was left as it was.`);
        receipts.unsure.add(name);
        continue;
      }
      const hash = packHash(state, contents.files, contents.overrides);
      if (!record) {
        // Pane's own plugins sync only once you change them or their display (A-3).
        if (state === 'pane' && !Object.keys(contents.overrides).length) continue;
        data.plugins[name] = { state, hash, savedAt: contents.changedAt || this.now(), machine };
        changed = true;
      } else if (record.state === 'deleted' || record.hash !== hash || record.state !== state) {
        data.plugins[name] = { state, hash, savedAt: Math.max(justSaved ? this.now() : contents.changedAt || this.now(), record.savedAt + 1), machine };
        changed = true;
      }
    }
    // The receipts folder changes when a receipt is removed: when an uninstall outside Pane happened.
    const receiptsChangedAt = Math.floor((await fs.stat(path.join(this.configRoot, '.plugins')).catch(() => undefined))?.mtimeMs ?? 0);
    for (const [name, record] of Object.entries(data.plugins)) {
      if (!wanted(name) || receipts.names.includes(name) || receipts.unsure.has(name) || record.state === 'deleted' || BUNDLED.includes(name)) continue;
      // Positive evidence only: the receipt itself is gone, not just missing from a listing.
      if (!await this.receiptGone(name)) continue;
      data.plugins[name] = { state: 'deleted', hash: '', savedAt: Math.max(justSaved ? this.now() : receiptsChangedAt || this.now(), record.savedAt + 1), machine };
      changed = true;
    }
    if (changed) await writeProfileSync(this.configRoot, data);
    return data;
  }

  private on(): boolean {
    return this.options.enabled?.() ?? true;
  }

  /** Throws the off answer when the switch went off while this call waited for the lock (review F-11). */
  private requireOn(): void {
    if (!this.on()) throw profilesOffError();
  }

  /**
   * This computer's records, brought up to date first: all of them, or only `plugins` (a Session
   * about to start reads, and is sent, just its own profile's, review F-4).
   */
  async state(from?: string, plugins?: readonly string[]): Promise<ProfileSyncState> {
    if (from && from !== this.options.machine()) this.options.onPeerSeen?.(from);
    const only = plugins ? new Set(plugins) : undefined;
    const data = await this.lock.run(() => { this.requireOn(); return this.refreshUnlocked(false, only); });
    const records = only ? Object.fromEntries(Object.entries(data.plugins).filter(([name]) => only.has(name))) : data.plugins;
    return { machine: this.options.machine(), name: this.options.name(), plugins: records };
  }

  /** After a save here: records it, so the next sync sends it. Off, nothing is recorded. */
  async recordChange(): Promise<void> {
    await this.lock.run(async () => { if (this.on()) await this.refreshUnlocked(true); });
  }

  /**
   * A change the Profiles tab makes to `plugin` (a save, new file, Restore, a title, description or
   * photo), run under the same lock as an arriving save and recorded before the lock is let go: a save here and one from
   * another computer never interleave, so neither is lost (review F-2). A change that waited while
   * the switch went off is still made, as the person asked for it, but not recorded for sync.
   */
  exclusive<T>(plugin: string, work: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      const result = await work();
      if (this.on()) await this.refreshUnlocked(true, new Set([plugin]));
      return result;
    });
  }

  /** What this computer last knew of its other computers (desktop only). */
  async peerMemory(): Promise<ProfileSyncFileData['computers']> {
    return (await readProfileSync(this.configRoot)).computers;
  }

  async rememberPeers(computers: ProfileSyncFileData['computers']): Promise<void> {
    await this.lock.run(async () => {
      this.requireOn();
      const data = await readProfileSync(this.configRoot);
      await writeProfileSync(this.configRoot, { ...data, computers });
    });
  }

  private outgoing(transferId: string): string {
    if (!TRANSFER_ID.test(transferId)) throw new PaneError('PROFILE_SYNC_TRANSFER', `"${transferId}" isn't a profile transfer, so nothing was read.`, 'Sync profiles again.');
    return path.join(this.configRoot, 'drafts', '.outgoing', transferId);
  }

  /** Packs the newest save of a plugin here into one file for another computer to read. */
  async export(plugin: string): Promise<ProfileSyncExport> {
    if (!PROFILE_NAME_PATTERN.test(plugin)) throw new PaneError('PROFILE_NAME_INVALID', `"${plugin}" isn't a plugin name.`, 'Sync profiles again.');
    await this.removeStale();
    return this.lock.run(async () => {
      this.requireOn();
      const data = await this.refreshUnlocked(false, new Set([plugin]));
      const record = data.plugins[plugin];
      if (!record) throw new PaneError('PROFILE_SYNC_UNKNOWN', `This computer has no save of ${plugin} to send.`, 'Sync profiles again.');
      if (record.state === 'deleted') return { record };
      const contents = await this.contents(plugin);
      const files: Record<string, string> = {};
      if (record.state === 'saved') {
        for (const [file, content] of Object.entries(contents.files)) {
          files[file] = (file === 'plugin.yaml' ? Buffer.from(packManifest(content.toString('utf8'), contents.files)) : content).toString('base64');
        }
      }
      const pack: ProfilePack = { plugin, record, files, overrides: Object.fromEntries(Object.entries(contents.overrides).map(([name, bytes]) => [name, bytes.toString('base64')])) };
      const transferId = randomUUID();
      const folder = this.outgoing(transferId);
      await fs.mkdir(folder, { recursive: true });
      const file = path.join(folder, 'pack.json');
      await fs.writeFile(file, JSON.stringify(pack));
      const digest = await fileDigest(file);
      if (digest.bytes > this.maxPackBytes()) {
        await fs.rm(folder, { recursive: true, force: true });
        throw new PaneError('PROFILE_SYNC_TOO_LARGE', `${plugin} packs to ${Math.ceil(digest.bytes / 1048576)} MB, more than the ${Math.floor(this.maxPackBytes() / 1048576)} MB profiles sync, so it wasn't sent.`, 'Move large files out of the plugin, then sync again.');
      }
      await fs.writeFile(`${file}.gz`, await gzip(await fs.readFile(file)));
      return { record, transferId, pack: { path: 'pack.json', bytes: digest.bytes, sha256: digest.sha256 } };
    });
  }

  /** One compressed chunk of an export; the last one carries the pack's digest, and the export is then removed. */
  async read({ transferId, offset }: { transferId: string; offset: number }): Promise<ProfileSyncChunk> {
    const folder = this.outgoing(transferId);
    const compressed = await fs.readFile(path.join(folder, 'pack.json.gz')).catch(() => {
      throw new PaneError('PROFILE_SYNC_TRANSFER', 'That profile transfer is over or was never started, so nothing was read.', 'Sync profiles again.');
    });
    const chunk = compressed.subarray(offset, offset + READ_CHUNK_BYTES);
    if (offset + chunk.length < compressed.length) return { content: chunk.toString('base64') };
    const digest = await fileDigest(path.join(folder, 'pack.json'));
    await fs.rm(folder, { recursive: true, force: true });
    return { content: chunk.toString('base64'), last: { bytes: digest.bytes, sha256: digest.sha256 } };
  }

  /** The pack file of an export here, which this computer sends itself (Session move's `sendFile`). */
  packFile(transferId: string): string {
    return path.join(this.outgoing(transferId), 'pack.json');
  }

  /** Removes an export once it was sent. */
  async discard(transferId: string): Promise<void> {
    await fs.rm(this.outgoing(transferId), { recursive: true, force: true });
  }

  /** One chunk of a pack arriving here (Session move's checked write), within the size profiles sync (review F-10). */
  write(request: WriteRequest): Promise<WriteResult> {
    const max = this.maxPackBytes();
    if (request.offset + Buffer.byteLength(request.content, 'base64') > max || (request.last && request.last.bytes > max)) {
      return Promise.reject(new PaneError('PROFILE_SYNC_TOO_LARGE', `A profile pack larger than ${Math.floor(max / 1048576)} MB was refused, so nothing was written.`, 'Move large files out of the plugin on the other computer, then sync again.'));
    }
    return this.receiver.write(request);
  }

  private async removeStale(): Promise<void> {
    for (const parent of [path.join(this.configRoot, 'drafts', '.outgoing'), path.join(this.configRoot, 'drafts', '.incoming')]) {
      for (const entry of await fs.readdir(parent).catch(() => [])) {
        const folder = path.join(parent, entry);
        const stat = await fs.stat(folder).catch(() => undefined);
        if (stat && this.now() - stat.mtimeMs > STALE_TRANSFER_MS) await fs.rm(folder, { recursive: true, force: true });
      }
    }
  }

  /**
   * Applies another computer's save of a plugin here when it is newer than this computer's (or, for
   * Sync now, when the files here differ from it): installs its pack, restores Pane's version, or
   * deletes the plugin. Throws, with nothing changed, when the pack is damaged or Agent Farm refuses it.
   */
  async apply(request: ProfileSyncApplyRequest): Promise<ProfileSyncApplyResult> {
    const { plugin } = request;
    if (!PROFILE_NAME_PATTERN.test(plugin) || plugin === 'pane') throw new PaneError('PROFILE_NAME_INVALID', `"${plugin}" isn't a plugin Pane syncs, so nothing was changed.`, 'Sync profiles again.');
    try {
      // An apply that waited behind a change here is refused once the switch is off; one already
      // swapping files finishes, as it holds the lock (review F-11).
      return await this.lock.run(() => { this.requireOn(); return this.applyUnlocked(request); });
    } finally {
      if (request.transferId) await this.receiver.remove(request.transferId).catch(() => undefined);
    }
  }

  private async applyUnlocked({ plugin, record, transferId, pack, force }: ProfileSyncApplyRequest): Promise<ProfileSyncApplyResult> {
    const data = await this.refreshUnlocked(false, new Set([plugin]));
    const current = data.plugins[plugin];
    if (current && !isNewerSave(record, current) && !sameSave(record, current)) return { applied: false, record: current };
    if (sameSave(record, current) && !force) return { applied: false, record: current };
    if (record.state === 'deleted') {
      // Pane's own plugins are never deleted by a sync; a deletion of yours is.
      if (BUNDLED.includes(plugin)) return { applied: false, record: current };
      if (sameSave(record, current)) return { applied: false, record: current };
      return this.replaceLive(plugin, record, { movePlugin: true, overrides: {} }, async () => undefined);
    }
    if (!transferId || !pack) throw new PaneError('PROFILE_SYNC_DAMAGED', `${plugin} arrived without its files, so nothing was changed.`, 'Sync profiles again.');
    if (pack.bytes > this.maxPackBytes()) throw new PaneError('PROFILE_SYNC_TOO_LARGE', `${plugin} arrived as a pack larger than profiles sync, so nothing was changed.`, 'Move large files out of the plugin on the other computer, then sync again.');
    if (!await this.receiver.verify(transferId, pack)) {
      throw new PaneError('PROFILE_SYNC_DAMAGED', `${plugin} arrived damaged (its size or SHA-256 doesn't match the other computer's copy), so nothing was changed.`, 'Sync profiles again.');
    }
    const decoded = decodeOptionalBoundary(JSON.parse(await fs.readFile(this.receiver.filePath(transferId, pack.path), 'utf8')), packSchema);
    if (!decoded || decoded.plugin !== plugin || !sameSave(decoded.record, record)) {
      throw new PaneError('PROFILE_SYNC_DAMAGED', `${plugin} arrived as a pack Pane can't read, so nothing was changed.`, 'Update Pane on both computers, then sync again.');
    }
    const files = Object.fromEntries(Object.entries(decoded.files).map(([file, content]) => [file, Buffer.from(content, 'base64')]));
    const overrides = Object.fromEntries(Object.entries(decoded.overrides).map(([name, content]) => [name, Buffer.from(content, 'base64')]));
    const refused = Object.entries(overrides).find(([name, bytes]) => !isOverride(name, bytes));
    if (refused) {
      throw new PaneError('PROFILE_SYNC_DAMAGED', `${plugin} arrived with a display override "${refused[0]}" that isn't a <profile>.json or <profile>.svg of 64 KB or less, so nothing was changed.`, 'Set the profile\'s title, description or photo again on the other computer, then sync again.');
    }
    if (packHash(record.state, files, overrides) !== record.hash) {
      throw new PaneError('PROFILE_SYNC_DAMAGED', `${plugin} arrived with files that don't match the other computer's save, so nothing was changed.`, 'Sync profiles again.');
    }
    if (force && sameSave(record, current)) {
      const here = await this.contents(plugin).catch(() => undefined);
      if (here && packHash(record.state, here.files, here.overrides) === record.hash) return { applied: false, record: current };
    }
    let result: ProfileSyncApplyResult;
    if (record.state === 'saved') {
      const source = await this.stagePack(plugin, files, transferId);
      result = await this.replaceLive(plugin, record, { movePlugin: true, overrides }, async () => {
        await this.installStaged(plugin, source);
        // Pane's own files, which Agent Farm's install leaves out.
        for (const [file, content] of Object.entries(files)) {
          if (PANE_FILE.test(file)) await writeAtomic(path.join(this.pluginRoot(plugin), ...checkRelative(file)), content);
        }
      });
    } else {
      if (!BUNDLED.includes(plugin)) throw new PaneError('PROFILE_SYNC_DAMAGED', `${plugin} arrived as Pane's own version, but it isn't a plugin that ships with Pane, so nothing was changed.`, 'Sync profiles again.');
      const installed = (await this.receipts(new Set([plugin])))?.names.includes(plugin) === true;
      const reinstall = await this.isYours(plugin, current) || !installed;
      result = await this.replaceLive(plugin, record, { movePlugin: reinstall, overrides }, async () => {
        if (!reinstall) return;
        try { await reinstallBundledPlugin(this.options.paneDir, plugin, this.bundle(), this.options.run); }
        catch (error) {
          if (error instanceof PaneError) throw error;
          const reason = agentFarmReason({ stderr: decodeOptionalBoundary(error, stderrSchema)?.stderr ?? '', fallback: reasonOf(error) });
          throw new PaneError('PROFILE_SYNC_REFUSED', `Pane couldn't restore its version of ${plugin} here: ${reason}. Your copy was kept.`, 'Restart Pane, then sync again.');
        }
      });
    }
    const here = await this.contents(plugin).catch(() => undefined);
    if (here && packHash(record.state, here.files, here.overrides) !== record.hash) {
      console.warn(`[ProfileSync] ${plugin} was installed, but its files here hash differently from the save; the next sync records the difference.`);
    }
    return result;
  }

  /**
   * Replaces a plugin here with an arriving save, keeping the last good copy until the record is
   * written (review F-3): the plugin and its receipt (when `movePlugin`) and your display overrides
   * of it are set aside in drafts/, `change` builds the new copy, the overrides are replaced and the
   * record is written. On any failure the new files go and the old ones come back; if even that
   * fails, the old copy stays in drafts/ and the error names where.
   */
  private async replaceLive(plugin: string, record: ProfileSyncRecord, { movePlugin, overrides }: { movePlugin: boolean; overrides: Record<string, Buffer> }, change: () => Promise<void>): Promise<ProfileSyncApplyResult> {
    const backup = path.join(this.configRoot, 'drafts', `.previous-${plugin}-${randomUUID()}`);
    const root = this.pluginRoot(plugin);
    const receipt = path.join(this.configRoot, '.plugins', `${plugin}.json`);
    const overridesFolder = this.overridesFolder(plugin);
    const moved = { plugin: false, receipt: false };
    const keptOverrides: string[] = [];
    // Nothing live is removed or replaced until both the plugin and its receipt are set aside: a
    // backup that fails puts back only what moved (review F-3).
    let setAside = false;
    try {
      await fs.mkdir(path.join(backup, 'overrides'), { recursive: true });
      for (const entry of await this.overrideEntries(plugin)) {
        await fs.copyFile(path.join(overridesFolder, entry), path.join(backup, 'overrides', entry));
        keptOverrides.push(entry);
      }
      if (movePlugin && await present(root)) { await fs.rename(root, path.join(backup, 'plugin')); moved.plugin = true; }
      if (movePlugin && await present(receipt)) { await fs.rename(receipt, path.join(backup, 'receipt.json')); moved.receipt = true; }
      setAside = true;
      await change();
      await this.replaceOverrides(plugin, overrides);
      const data = await readProfileSync(this.configRoot);
      data.plugins[plugin] = record;
      await writeProfileSync(this.configRoot, data);
    } catch (error) {
      try {
        if (!setAside) {
          // Only the plugin can have moved (the receipt moves last): put it back, and touch nothing else.
          if (moved.plugin) await fs.rename(path.join(backup, 'plugin'), root);
        } else {
          await this.restoreAfterFailure(plugin, backup, movePlugin, moved, keptOverrides);
        }
      } catch (rollback) {
        throw new PaneError('PROFILE_SYNC_ROLLBACK', `${plugin} from your other computer couldn't be installed (${reasonOf(error)}), and putting your copy back failed too (${reasonOf(rollback)}). Your copy is kept in ${backup}.`, `Move ${backup}/plugin back to ${root}, then restart Pane.`);
      }
      await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    this.options.onApplied?.(plugin);
    return { applied: true, record };
  }

  /** After a failed change: removes what it installed and puts back the set-aside plugin, receipt and display overrides. */
  private async restoreAfterFailure(plugin: string, backup: string, movePlugin: boolean, moved: { plugin: boolean; receipt: boolean }, keptOverrides: string[]): Promise<void> {
    const root = this.pluginRoot(plugin);
    const receipt = path.join(this.configRoot, '.plugins', `${plugin}.json`);
    if (movePlugin) {
      // Everything live was set aside first, so what is there now is the failed change's.
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(receipt, { force: true });
      // A reinstall that failed leaves its marker, which would make the next start clear the copy put back here.
      const installing = path.join(this.configRoot, INSTALLING_FILE);
      if ((await fs.readFile(installing, 'utf8').catch(() => '')).includes(`"${plugin}"`)) await fs.rm(installing, { force: true });
    }
    if (moved.plugin) await fs.rename(path.join(backup, 'plugin'), root);
    if (moved.receipt) await fs.rename(path.join(backup, 'receipt.json'), receipt);
    await this.replaceOverrides(plugin, {});
    const overridesFolder = this.overridesFolder(plugin);
    if (keptOverrides.length) await fs.mkdir(overridesFolder, { recursive: true });
    for (const entry of keptOverrides) await fs.copyFile(path.join(backup, 'overrides', entry), path.join(overridesFolder, entry));
  }

  /** Writes a pack's files into the transfer's staging folder, checked to stay inside the plugin. */
  private async stagePack(plugin: string, files: Record<string, Buffer>, transferId: string): Promise<string> {
    const source = path.join(this.configRoot, 'drafts', '.incoming', transferId, 'plugin', plugin);
    for (const [file, content] of Object.entries(files)) {
      const parts = checkRelative(file);
      await writeAtomic(path.join(source, ...parts), content);
    }
    const manifest = decodeOptionalBoundary(yaml.load(files['plugin.yaml']?.toString('utf8') ?? ''), boundary.object({ name: boundary.string }));
    if (manifest?.name !== plugin) throw new PaneError('PROFILE_SYNC_DAMAGED', `${plugin} arrived with a plugin.yaml for ${manifest?.name ?? 'no plugin'}, so nothing was changed.`, 'Sync profiles again.');
    return source;
  }

  /**
   * Installs staged files with `agent-farm plugin install`, which checks them against the checksums
   * in their plugin.yaml. The plugin and its receipt here were set aside first (replaceLive), so the
   * install starts clean: an edited file would make Agent Farm refuse it.
   */
  private async installStaged(plugin: string, source: string): Promise<void> {
    try {
      await (this.options.run ?? runAgentFarm)(bundledAgentFarmProcess(this.bundle(), ['plugin', 'install', source], this.configRoot));
    } catch (error) {
      if (error instanceof PaneError) throw error;
      const reason = agentFarmReason({ stderr: decodeOptionalBoundary(error, stderrSchema)?.stderr ?? '', fallback: reasonOf(error) }, [source], plugin);
      throw new PaneError('PROFILE_SYNC_REFUSED', `Agent Farm refused ${plugin} from your other computer: ${reason}. Nothing was changed here.`, 'Sync profiles again; if it repeats, save the profile again on the other computer.');
    }
  }

  /** The regular files with an override name in `profile-overrides/<plugin>/`, whatever their size: what a replace sets aside. */
  private async overrideEntries(plugin: string): Promise<string[]> {
    if (!await this.overridesThere(plugin)) return [];
    const entries = await fs.readdir(this.overridesFolder(plugin), { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && OVERRIDE_FILE.test(entry.name)).map(entry => entry.name);
  }

  /**
   * Makes `profile-overrides/<plugin>/` hold exactly `overrides`: new and changed files are written
   * atomically, other override files there go, and the folder goes once it is empty. Files without
   * an override name are left alone. A folder that is a link is refused, so nothing is written
   * outside Pane's Agent Farm folder (review F-5).
   */
  private async replaceOverrides(plugin: string, overrides: Record<string, Buffer>): Promise<void> {
    const folder = this.overridesFolder(plugin);
    const there = await this.overridesThere(plugin);
    if (there) {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (OVERRIDE_FILE.test(entry.name) && !entry.isDirectory() && !overrides[entry.name]) await fs.rm(path.join(folder, entry.name), { force: true });
      }
    }
    for (const [name, bytes] of Object.entries(overrides)) {
      if (!isOverride(name, bytes)) continue;
      const file = path.join(folder, name);
      const same = await fs.lstat(file).then(stat => stat.isFile() && stat.size === bytes.length, () => false) && (await fs.readFile(file)).equals(bytes);
      if (same) continue;
      await writeAtomic(file, bytes);
      await fs.chmod(file, 0o600);
    }
    if (!Object.keys(overrides).length && there) {
      await fs.rmdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST' && !notThere(error)) throw error; });
    }
  }
}


/**
 * Runs one `profile-sync:*` call on this computer's host: the daemon's handlers, and tests that
 * stand in for other computers, decode through here.
 */
export async function runProfileSyncCommand(host: ProfileSyncHost, channel: string, request: PaneCommandValue): Promise<PaneCommandValue> {
  switch (channel) {
    case PROFILE_SYNC_CHANNELS.state:
    {
      const asked = decodeOptionalBoundary(request, boundary.object({ from: boundary.optional(boundary.string), plugins: boundary.optional(boundary.array(boundary.string)) }));
      return host.state(asked?.from, asked?.plugins);
    }
    case PROFILE_SYNC_CHANNELS.export:
      return host.export(decodeBoundary(request, boundary.object({ plugin: boundary.nonEmptyString })).plugin);
    case PROFILE_SYNC_CHANNELS.read:
      return host.read(decodeBoundary(request, profileSyncReadRequestSchema));
    case PROFILE_SYNC_CHANNELS.write:
      return host.write(decodeBoundary(request, writeRequestSchema));
    case PROFILE_SYNC_CHANNELS.apply:
      return host.apply(decodeBoundary(request, profileSyncApplyRequestSchema));
    default:
      throw new PaneError('ERR_UNKNOWN_CHANNEL', `"${channel}" isn't a profile sync call.`, 'Update Pane on both computers.');
  }
}
