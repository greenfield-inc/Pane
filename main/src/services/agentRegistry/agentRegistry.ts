import { createHash } from 'crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { RegistryAgent, RegistryAgentList } from '../../../../shared/types/agentRegistry';
import { hostCommand } from '../agentChat/hostCommand';

const execFileAsync = promisify(execFile);

/** The registry's bot publishes new versions hourly; Pane reads it at most that often, unless Refresh in Settings > Agents asks now. */
const REFRESH_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Written last in a version folder: a folder without it is an install that did not finish. */
const INSTALL_RECORD = 'pane-install.json';

/** A registry id, as the registry's schema requires: one safe folder name. */
const ID = /^[a-z][a-z0-9-]*$/;
/**
 * A version used as a folder name: one path segment, never `.` or `..` (review F-1), with no
 * trailing dot and no Windows device name, which Windows would rename or refuse. Folders are named
 * by the lowercased version, so versions differing only in case share one on any file system.
 */
const VERSION = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[0-9A-Za-z][0-9A-Za-z.+_-]*(?<!\.)$/i;
const versionFolder = (version: string) => version.toLowerCase();
/** An npm spec pinned to an exact version (`name@1.2.3`, `@scope/name@1.2.3`), so npm's integrity check applies. */
const PINNED_PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const target = boundary.object({ archive: boundary.refine(boundary.string, url => url.startsWith('https://'), 'expected an https download'), cmd: boundary.string, sha256: boundary.optional(boundary.string), args: boundary.optional(boundary.array(boundary.string)), env: boundary.optional(boundary.record(boundary.string)) });
const packageRun = boundary.object({ package: boundary.refine(boundary.string, spec => PINNED_PACKAGE.test(spec), 'expected a package pinned to an exact version'), args: boundary.optional(boundary.array(boundary.string)), env: boundary.optional(boundary.record(boundary.string)) });
const entrySchema = boundary.object({
  id: boundary.refine(boundary.string, id => ID.test(id), 'expected a registry id'),
  name: boundary.string, version: boundary.refine(boundary.string, version => VERSION.test(version), 'expected a version that is one folder name'), description: boundary.optional(boundary.string), icon: boundary.optional(boundary.string),
  distribution: boundary.object({ binary: boundary.optional(boundary.record(target)), npx: boundary.optional(packageRun), uvx: boundary.optional(boundary.json) }),
});
type RegistryEntry = typeof entrySchema extends BoundarySchema<infer T> ? T : never;
/** Entries that do not decode are skipped, so one malformed agent never hides the rest. */
const indexSchema = boundary.object({ agents: boundary.array(boundary.json) });

/** What a finished install records: how to start that version, and whether the person accepted it without a checksum. */
interface InstallRecord { id: string; name: string; version: string; description?: string; iconUrl: string; kind: 'binary' | 'npx'; command: string; args: string[]; env?: Record<string, string>; verified: boolean }
const recordSchema: BoundarySchema<InstallRecord> = boundary.object({
  id: boundary.string, name: boundary.string, version: boundary.string, description: boundary.optional(boundary.string), iconUrl: boundary.string,
  kind: boundary.enumeration('binary', 'npx'), command: boundary.string, args: boundary.array(boundary.string), env: boundary.optional(boundary.record(boundary.string)), verified: boundary.boolean,
});

/** How to start an installed registry agent, and which version that is. */
export interface ResolvedRegistryAgent { executable: string; args: string[]; env?: Record<string, string>; version: string }

export interface AgentRegistryOptions {
  /** Where installed agents and the cached index live (one folder per agent, one per version). */
  root: string;
  /** The ACP Registry index (agents config `registryUrl`). */
  url: string;
  /** Registry ids a configured agent already covers; they are never listed. */
  hidden: () => ReadonlySet<string>;
  /** A program on the person's PATH (npm, node, tar, unzip), or null. Used when installing or starting an agent. */
  findExecutable: (name: string) => string | null;
  /** Whether a program is on PATH, without blocking the main process; used to list agents. */
  onPath: (name: string) => Promise<boolean>;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
}

/**
 * Agents from the ACP Registry (D-15): lists the index, installs binary and npx agents into
 * per-version folders, and moves each installed agent to the registry's current version on
 * its next launch. uvx agents are left out (Pane ships no Python toolchain).
 */
export class AgentRegistry {
  private index?: { agents: RegistryEntry[]; fetchedAt: number };
  private readonly installing = new Map<string, Promise<InstallRecord>>();

  constructor(private readonly options: AgentRegistryOptions) {}

  /** The registry's agents for Settings > Agents. `refresh` reads the index again now. */
  async list(refresh = false): Promise<RegistryAgentList> {
    let error: string | undefined;
    try { await this.load(refresh); }
    catch (cause) { error = reasonOf(cause); }
    const installed = new Map(this.installed().map(record => [record.id, record]));
    const hasNpm = await this.options.onPath('npm');
    const agents = (this.index?.agents ?? []).flatMap(entry => {
      const how = this.distribution(entry);
      if (!how || this.options.hidden().has(entry.id)) return [];
      const agent: RegistryAgent = { id: entry.id, name: entry.name, version: entry.version, iconUrl: this.iconUrl(entry), verified: how.kind === 'npx' || !!how.target?.sha256, kind: how.kind };
      if (entry.description) agent.description = entry.description;
      const record = installed.get(entry.id);
      if (record) agent.installedVersion = record.version;
      if (how.kind === 'npx' && !hasNpm) agent.needs = 'Node.js';
      return [agent];
    });
    // An installed agent the list no longer offers (delisted, no download for this computer, or now
    // covered by a built-in agent) still runs, so it stays here with Remove (review F-5).
    // With no index at all, Pane can't tell whether they are still listed, so it doesn't say so.
    const listed = new Set(agents.map(agent => agent.id));
    for (const record of installed.values()) {
      if (listed.has(record.id)) continue;
      const agent: RegistryAgent = { id: record.id, name: record.name, version: record.version, iconUrl: record.iconUrl, kind: record.kind, verified: record.verified, installedVersion: record.version };
      if (this.index) agent.listed = false;
      if (record.description) agent.description = record.description;
      agents.push(agent);
    }
    return error ? { agents, error } : { agents };
  }

  /**
   * Installs the registry's current version of `id`. A binary with no checksum is refused
   * unless the person accepted that (`allowUnverified`); the refusal's code says to ask.
   */
  async install(id: string, { allowUnverified = false } = {}): Promise<InstallRecord> {
    await this.load(false);
    const entry = this.entry(id);
    const existing = this.installedVersion(id, entry.version);
    if (existing) return existing;
    const how = this.distribution(entry);
    if (!how) throw new PaneError('AGENT_REGISTRY_UNSUPPORTED', `${entry.name} has no download Pane can run on this computer.`, 'Pick another agent. Pane installs agents published as a download or an npm package.');
    if (how.kind === 'binary' && !how.target?.sha256 && !allowUnverified) {
      throw new PaneError('AGENT_REGISTRY_UNVERIFIED', `${entry.name} publishes no checksum, so Pane cannot check the download is the one its maker published. Nothing was installed.`, 'Install it again and confirm you trust it to run without that check.');
    }
    const key = `${id}@${entry.version}`;
    let pending = this.installing.get(key);
    if (!pending) {
      pending = this.installVersion(entry, how).finally(() => this.installing.delete(key));
      this.installing.set(key, pending);
    }
    return pending;
  }

  /** Removes every installed version of `id`. */
  remove(id: string): void {
    this.assertId(id);
    rmSync(this.folder(id), { recursive: true, force: true });
  }

  /** Every installed agent, at its newest finished version. Read from disk each time. */
  installed(): InstallRecord[] {
    const agents = path.join(this.options.root, 'agents');
    if (!existsSync(agents)) return [];
    return readdirSync(agents).filter(id => ID.test(id)).flatMap(id => {
      const records = this.versions(id);
      return records.length ? [records[records.length - 1]] : [];
    });
  }

  /**
   * How to start `id` now: the registry's current version, installed first when the installed
   * one is older (D-15). When the index cannot be read or the update fails, the installed
   * version runs. Undefined when the agent is not installed.
   */
  async resolve(id: string): Promise<ResolvedRegistryAgent | undefined> {
    if (!ID.test(id)) return undefined;
    let record = this.versions(id).at(-1);
    if (!record) return undefined;
    try {
      await this.load(false);
      const current = this.index?.agents.find(entry => entry.id === id);
      if (current && current.version !== record.version) {
        record = await this.install(id, { allowUnverified: !record.verified });
        console.log(`[AgentRegistry] ${id} moved to ${record.version}, the registry's current version.`);
      }
    } catch (error) {
      // Re-read: another tab's update may have removed the version read above while this one waited.
      record = this.versions(id).at(-1) ?? record;
      console.warn(`[AgentRegistry] ${id} stays at ${record.version}: ${reasonOf(error)}`);
    }
    // An npm agent starts through npm's own bin link, which runs Node.js (or the native program a postinstall put there).
    if (record.kind === 'npx' && !this.options.findExecutable('node')) throw new PaneError('AGENT_REGISTRY_NEEDS_NODE', `${record.name} runs on Node.js, which is not on this computer's PATH.`, 'Install Node.js, then press Retry.');
    const resolved: ResolvedRegistryAgent = { executable: record.command, args: record.args, version: record.version };
    if (record.env) resolved.env = record.env;
    return resolved;
  }

  /**
   * Removes the versions of `id` no tab runs from: after a launch moved to a newer version, the older
   * ones are not needed. A folder that can't be removed now (a file still in use) is left for next time.
   */
  removeVersionsExcept(id: string, keep: ReadonlySet<string>): void {
    for (const record of this.versions(id)) {
      if ([...keep].some(version => versionFolder(version) === versionFolder(record.version))) continue;
      try { rmSync(this.folder(id, record.version), { recursive: true, force: true }); }
      catch (error) { console.warn(`[AgentRegistry] ${id} ${record.version} is not needed but could not be removed yet: ${reasonOf(error)}`); }
    }
  }

  /** The installed version `id` launches with, for the catalog. */
  installedRecord(id: string): InstallRecord | undefined { return this.versions(id).at(-1); }

  private versions(id: string): InstallRecord[] {
    if (!ID.test(id) || !existsSync(this.folder(id))) return [];
    const folder = this.folder(id);
    return readdirSync(folder).flatMap(version => {
      if (!VERSION.test(version)) return [];
      const file = path.join(folder, version, INSTALL_RECORD);
      // A record whose version is not its own folder's name is not trusted.
      try { const record = decodeOptionalBoundary(JSON.parse(readFileSync(file, 'utf8')), recordSchema); return record && record.id === id && versionFolder(record.version) === version ? [{ record, at: statSync(file).mtimeMs }] : []; }
      catch { return []; }
    }).sort((a, b) => a.at - b.at).map(entry => entry.record);
  }

  private installedVersion(id: string, version: string): InstallRecord | undefined {
    return this.versions(id).find(record => versionFolder(record.version) === versionFolder(version));
  }

  private async installVersion(entry: RegistryEntry, how: NonNullable<ReturnType<AgentRegistry['distribution']>>): Promise<InstallRecord> {
    const folder = this.folder(entry.id, entry.version);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    try {
      let record: InstallRecord;
      let env: Record<string, string> | undefined;
      if (how.kind === 'binary' && how.target) {
        const command = await this.installBinary(entry, how.target, folder);
        record = { id: entry.id, name: entry.name, version: entry.version, iconUrl: this.iconUrl(entry), kind: 'binary', command, args: how.target.args ?? [], verified: !!how.target.sha256 };
        env = how.target.env;
      } else if (how.kind === 'npx' && how.run) {
        const script = await this.installPackage(entry, how.run.package, folder);
      // `script` is npm's bin link for the package, which npm made executable.
        record = { id: entry.id, name: entry.name, version: entry.version, iconUrl: this.iconUrl(entry), kind: 'npx', command: script, args: how.run.args ?? [], verified: true };
        env = how.run.env;
      } else throw new PaneError('AGENT_REGISTRY_UNSUPPORTED', `${entry.name} has no download Pane can run on this computer.`, 'Pick another agent.');
      if (entry.description) record.description = entry.description;
      if (env) record.env = env;
      writeFileSync(path.join(folder, INSTALL_RECORD), JSON.stringify(record));
      console.log(`[AgentRegistry] Installed ${entry.id} ${entry.version} (${record.kind}${record.verified ? '' : ', no checksum'}).`);
      return record;
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      const agentFolder = path.dirname(folder);
      if (existsSync(agentFolder) && readdirSync(agentFolder).length === 0) rmSync(agentFolder, { recursive: true, force: true });
      if (error instanceof PaneError) throw error;
      throw new PaneError('AGENT_REGISTRY_INSTALL_FAILED', `Pane could not install ${entry.name} ${entry.version}: ${reasonOf(error)}. Nothing was installed.`, 'Check the internet connection and try again.');
    }
  }

  /** Downloads the archive, checks its sha256 when the registry gives one, and unpacks it. Returns the command's path. */
  private async installBinary(entry: RegistryEntry, binary: { archive: string; cmd: string; sha256?: string }, folder: string): Promise<string> {
    const name = new URL(binary.archive).pathname.split('/').pop() || 'download';
    const download = path.join(folder, `.download-${name}`);
    const response = await (this.options.fetch ?? fetch)(binary.archive, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error(`the download answered HTTP ${response.status}`);
    const hash = createHash('sha256');
    // SAFETY: a fetch Response body is a web ReadableStream of bytes, which Readable.fromWeb accepts.
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', chunk => hash.update(chunk));
    await pipeline(body, createWriteStream(download));
    const digest = hash.digest('hex');
    if (binary.sha256 && digest.toLowerCase() !== binary.sha256.toLowerCase()) {
      throw new PaneError('AGENT_REGISTRY_CHECKSUM_MISMATCH', `${entry.name} ${entry.version}'s download does not match the checksum the registry publishes (expected ${binary.sha256}, got ${digest}). Nothing was installed.`, 'Try again later; if it keeps failing, the download may have been tampered with.');
    }
    await this.unpack(download, name, folder);
    rmSync(download, { force: true });
    const command = path.resolve(folder, binary.cmd);
    if (!command.startsWith(folder + path.sep) || !existsSync(command)) throw new Error(`the download has no ${binary.cmd}`);
    // A link could point the command (and the chmod below) outside the folder (review S-10).
    if (lstatSync(command).isSymbolicLink()) throw new PaneError('AGENT_REGISTRY_UNSAFE_PATH', `${entry.name}'s download makes ${binary.cmd} a link, which Pane does not run. Nothing was installed.`, 'Report it to the ACP Registry; Pane installs only a plain program file.');
    if (process.platform !== 'win32') chmodSync(command, 0o755);
    return command;
  }

  private async unpack(file: string, name: string, folder: string): Promise<void> {
    const lower = name.toLowerCase();
    if (lower.endsWith('.zip')) {
      // bsdtar (macOS, Windows) reads zip; Linux tar does not, so unzip is used there.
      const unzip = this.platform() === 'linux' ? this.options.findExecutable('unzip') : null;
      if (this.platform() === 'linux' && !unzip) throw new PaneError('AGENT_REGISTRY_NEEDS_UNZIP', 'This agent ships as a zip file, and unzip is not installed on this computer.', 'Install unzip (for example `sudo apt install unzip`), then install the agent again.');
      if (unzip) await execFileAsync(unzip, ['-q', '-o', file, '-d', folder], { timeout: INSTALL_TIMEOUT_MS });
      else await execFileAsync(this.tar(), ['-xf', file, '-C', folder], { timeout: INSTALL_TIMEOUT_MS });
    } else if (/\.(tar\.gz|tgz|tar\.bz2|tbz2)$/.test(lower)) {
      await execFileAsync(this.tar(), ['-xf', file, '-C', folder], { timeout: INSTALL_TIMEOUT_MS });
    } else {
      // A raw binary: the download is the program.
      renameSync(file, path.join(folder, name));
    }
  }

  private tar(): string {
    const tar = this.options.findExecutable('tar');
    if (!tar) throw new PaneError('AGENT_REGISTRY_NEEDS_TAR', 'Pane needs the system tar program to unpack this agent, and it is not on this computer\'s PATH.', 'Install tar, then install the agent again.');
    return tar;
  }

  /** Installs an npm package with the person's own npm into the version folder. Returns npm's bin link that starts it. */
  private async installPackage(entry: RegistryEntry, spec: string, folder: string): Promise<string> {
    const npm = this.options.findExecutable('npm');
    if (!npm) throw new PaneError('AGENT_REGISTRY_NEEDS_NODE', `${entry.name} is an npm package, and npm is not on this computer's PATH.`, 'Install Node.js (it includes npm), then install the agent again.');
    const npmInstall = hostCommand(npm, ['install', '--prefix', folder, '--no-audit', '--no-fund', spec]);
    await execFileAsync(npmInstall.executable, npmInstall.args, { timeout: INSTALL_TIMEOUT_MS, windowsVerbatimArguments: npmInstall.windowsVerbatimArguments, maxBuffer: 16 * 1024 * 1024 });
    const name = spec.startsWith('@') ? `@${spec.slice(1).split('@')[0]}` : spec.split('@')[0];
    const root = path.join(folder, 'node_modules', ...name.split('/'));
    const { bin: declared } = decodeBoundary(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')), boundary.object({ bin: boundary.optional(boundary.json) }));
    // package.json `bin` is one script, or scripts by command name.
    const only = decodeOptionalBoundary(declared, boundary.string);
    const named = decodeOptionalBoundary(declared, boundary.record(boundary.string)) ?? {};
    const base = name.split('/').pop() ?? name;
    // Several commands for one script count as one program (review F-7).
    const commands = Object.keys(named);
    const command = only ? base : base in named ? base : new Set(Object.values(named)).size === 1 ? commands[0] : undefined;
    if (!command) throw new Error(`${spec} names no program to run`);
    // npm names the link by the key's base name; a key with a path never leaves .bin (review S-20).
    const binName = path.basename(command);
    const binFolder = path.join(folder, 'node_modules', '.bin');
    const link = path.join(binFolder, this.platform() === 'win32' ? `${binName}.cmd` : binName);
    if (path.dirname(link) !== binFolder) throw new Error(`${spec} names an unusable command`);
    if (!existsSync(link)) throw new Error(`npm made no ${command} command for ${spec}`);
    return link;
  }

  private distribution(entry: RegistryEntry): { kind: 'binary'; target?: RegistryEntry['distribution']['binary'] extends Record<string, infer T> | undefined ? T : never; run?: undefined } | { kind: 'npx'; run: NonNullable<RegistryEntry['distribution']['npx']>; target?: undefined } | undefined {
    const binary = entry.distribution.binary?.[this.platformKey()];
    if (binary) return { kind: 'binary', target: binary };
    if (entry.distribution.npx) return { kind: 'npx', run: entry.distribution.npx };
    return undefined;
  }

  private platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }

  /** The registry's platform key for this computer, such as darwin-aarch64. */
  private platformKey(): string {
    const os = this.platform() === 'win32' ? 'windows' : this.platform();
    const arch = (this.options.arch ?? process.arch) === 'arm64' ? 'aarch64' : 'x86_64';
    return `${os}-${arch}`;
  }

  /** The entry's icon: its own URL, or the one the registry serves beside its index. */
  private iconUrl(entry: RegistryEntry): string {
    if (entry.icon && /^https:\/\//.test(entry.icon)) return entry.icon;
    return new URL(`${entry.id}.svg`, this.options.url).toString();
  }

  private entry(id: string): RegistryEntry {
    const entry = this.index?.agents.find(candidate => candidate.id === id);
    if (!entry || this.options.hidden().has(id)) throw new PaneError('AGENT_REGISTRY_UNKNOWN', `The ACP Registry lists no agent "${id}" Pane can install.`, 'Open Settings > Agents to see the agents you can install.');
    return entry;
  }

  /** `<root>/agents/<id>[/<version>]`, checked to stay inside that folder (review F-1). */
  private folder(id: string, version?: string): string {
    const agents = path.join(this.options.root, 'agents');
    if (!ID.test(id) || (version !== undefined && !VERSION.test(version))) throw new PaneError('AGENT_REGISTRY_UNSAFE_PATH', `"${id}${version ? ` ${version}` : ''}" is not a registry agent and version Pane can store. Nothing was changed.`, 'Report it to the ACP Registry; Pane skips such entries.');
    const folder = version === undefined ? path.join(agents, id) : path.join(agents, id, versionFolder(version));
    const relative = path.relative(agents, folder);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new PaneError('AGENT_REGISTRY_UNSAFE_PATH', `The folder for ${id} would be outside Pane's agent folder. Nothing was changed.`, 'Report it to the ACP Registry; Pane skips such entries.');
    return folder;
  }

  private assertId(id: string): void {
    if (!ID.test(id)) throw new PaneError('AGENT_REGISTRY_UNKNOWN', `"${id}" is not an agent id.`, 'Open Settings > Agents to see the installed agents.');
  }

  /** Reads the index from the cache, or from the registry when the cache is older than an hour (or `refresh`). */
  private async load(refresh: boolean): Promise<void> {
    const cache = path.join(this.options.root, 'registry.json');
    const now = (this.options.now ?? Date.now)();
    if (!this.index && existsSync(cache)) {
      try { this.index = { agents: this.decode(JSON.parse(readFileSync(cache, 'utf8'))), fetchedAt: statSync(cache).mtimeMs }; }
      catch { this.index = undefined; }
    }
    if (this.index && !refresh && now - this.index.fetchedAt < REFRESH_MS) return;
    let text: string;
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
    } catch (error) {
      throw new PaneError('AGENT_REGISTRY_UNREACHABLE', `Pane could not read the ACP Registry: ${reasonOf(error)}.`, 'Check the internet connection, then open Settings > Agents again.');
    }
    const agents = this.decode(JSON.parse(text));
    mkdirSync(this.options.root, { recursive: true });
    const temporary = `${cache}.${process.pid}.${now}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, cache);
    this.index = { agents, fetchedAt: now };
  }

  private decode(value: JsonValue): RegistryEntry[] {
    const { agents } = decodeBoundary(value, indexSchema);
    return agents.flatMap(agent => { const entry = decodeOptionalBoundary(agent, entrySchema); return entry ? [entry] : []; });
  }
}
