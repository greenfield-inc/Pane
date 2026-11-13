import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs';
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

/** The registry's bot publishes new versions hourly; Pane reads it at most that often unless Settings > Agents opens. */
const REFRESH_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Written last in a version folder: a folder without it is an install that did not finish. */
const INSTALL_RECORD = 'pane-install.json';

const target = boundary.object({ archive: boundary.string, cmd: boundary.string, sha256: boundary.optional(boundary.string), args: boundary.optional(boundary.array(boundary.string)), env: boundary.optional(boundary.record(boundary.string)) });
const packageRun = boundary.object({ package: boundary.string, args: boundary.optional(boundary.array(boundary.string)), env: boundary.optional(boundary.record(boundary.string)) });
const entrySchema = boundary.object({
  id: boundary.refine(boundary.string, id => /^[a-z][a-z0-9-]*$/.test(id), 'expected a registry id'),
  name: boundary.string, version: boundary.string, description: boundary.optional(boundary.string), icon: boundary.optional(boundary.string),
  distribution: boundary.object({ binary: boundary.optional(boundary.record(target)), npx: boundary.optional(packageRun), uvx: boundary.optional(packageRun) }),
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

export interface AgentRegistryOptions {
  /** Where installed agents and the cached index live (one folder per agent, one per version). */
  root: string;
  /** The ACP Registry index (agents config `registryUrl`). */
  url: string;
  /** Registry ids a configured agent already covers; they are never listed. */
  hidden: () => ReadonlySet<string>;
  /** A program on the person's PATH (npm, node, tar, unzip), or null. */
  findExecutable: (name: string) => string | null;
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
    const agents = (this.index?.agents ?? []).flatMap(entry => {
      const how = this.distribution(entry);
      if (!how || this.options.hidden().has(entry.id)) return [];
      const agent: RegistryAgent = { id: entry.id, name: entry.name, version: entry.version, iconUrl: this.iconUrl(entry), verified: how.kind === 'npx' || !!how.target?.sha256, kind: how.kind };
      if (entry.description) agent.description = entry.description;
      const record = installed.get(entry.id);
      if (record) agent.installedVersion = record.version;
      if (how.kind === 'npx' && !this.options.findExecutable('npm')) agent.needs = 'Node.js';
      return [agent];
    });
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
    rmSync(path.join(this.options.root, 'agents', id), { recursive: true, force: true });
  }

  /** Every installed agent, at its newest finished version. Read from disk each time. */
  installed(): InstallRecord[] {
    const agents = path.join(this.options.root, 'agents');
    if (!existsSync(agents)) return [];
    return readdirSync(agents).flatMap(id => {
      const records = this.versions(id);
      return records.length ? [records[records.length - 1]] : [];
    });
  }

  /**
   * How to start `id` now: the registry's current version, installed first when the installed
   * one is older (D-15). When the index cannot be read or the update fails, the installed
   * version runs. Undefined when the agent is not installed.
   */
  async resolve(id: string): Promise<{ executable: string; args: string[]; env?: Record<string, string> } | undefined> {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) return undefined;
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
      console.warn(`[AgentRegistry] ${id} stays at ${record.version}: ${reasonOf(error)}`);
    }
    const env = record.env;
    if (record.kind === 'npx') {
      const node = this.options.findExecutable('node');
      if (!node) throw new PaneError('AGENT_REGISTRY_NEEDS_NODE', `${record.name} runs on Node.js, which is not on this computer's PATH.`, 'Install Node.js, then press Retry.');
      return env ? { executable: node, args: [record.command, ...record.args], env } : { executable: node, args: [record.command, ...record.args] };
    }
    return env ? { executable: record.command, args: record.args, env } : { executable: record.command, args: record.args };
  }

  /** After a version started, the older ones are not needed. */
  removeOlderVersions(id: string, running: string): void {
    for (const record of this.versions(id)) if (record.version !== running) rmSync(path.join(this.options.root, 'agents', id, record.version), { recursive: true, force: true });
  }

  /** The installed version `id` launches with, for the catalog. */
  installedRecord(id: string): InstallRecord | undefined { return this.versions(id).at(-1); }

  private versions(id: string): InstallRecord[] {
    const folder = path.join(this.options.root, 'agents', id);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !existsSync(folder)) return [];
    return readdirSync(folder).flatMap(version => {
      const file = path.join(folder, version, INSTALL_RECORD);
      try { const record = decodeOptionalBoundary(JSON.parse(readFileSync(file, 'utf8')), recordSchema); return record ? [{ record, at: statSync(file).mtimeMs }] : []; }
      catch { return []; }
    }).sort((a, b) => a.at - b.at).map(entry => entry.record);
  }

  private installedVersion(id: string, version: string): InstallRecord | undefined {
    return this.versions(id).find(record => record.version === version);
  }

  private async installVersion(entry: RegistryEntry, how: NonNullable<ReturnType<AgentRegistry['distribution']>>): Promise<InstallRecord> {
    const folder = path.join(this.options.root, 'agents', entry.id, entry.version);
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

  /** Installs an npm package with the person's own npm into the version folder. Returns the script its bin runs. */
  private async installPackage(entry: RegistryEntry, spec: string, folder: string): Promise<string> {
    const npm = this.options.findExecutable('npm');
    if (!npm) throw new PaneError('AGENT_REGISTRY_NEEDS_NODE', `${entry.name} is an npm package, and npm is not on this computer's PATH.`, 'Install Node.js (it includes npm), then install the agent again.');
    const command = hostCommand(npm, ['install', '--prefix', folder, '--no-audit', '--no-fund', spec]);
    await execFileAsync(command.executable, command.args, { timeout: INSTALL_TIMEOUT_MS, windowsVerbatimArguments: command.windowsVerbatimArguments, maxBuffer: 16 * 1024 * 1024 });
    const name = spec.startsWith('@') ? `@${spec.slice(1).split('@')[0]}` : spec.split('@')[0];
    const root = path.join(folder, 'node_modules', ...name.split('/'));
    const { bin: declared } = decodeBoundary(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')), boundary.object({ bin: boundary.optional(boundary.json) }));
    // package.json `bin` is one script, or scripts by command name.
    const only = decodeOptionalBoundary(declared, boundary.string);
    const named = decodeOptionalBoundary(declared, boundary.record(boundary.string)) ?? {};
    const scripts = Object.values(named);
    const bin = only ?? named[name.split('/').pop() ?? ''] ?? (scripts.length === 1 ? scripts[0] : undefined);
    if (!bin) throw new Error(`${spec} names no program to run`);
    return path.join(root, bin);
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

  private assertId(id: string): void {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new PaneError('AGENT_REGISTRY_UNKNOWN', `"${id}" is not an agent id.`, 'Open Settings > Agents to see the installed agents.');
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
      if (this.index) throw new PaneError('AGENT_REGISTRY_UNREACHABLE', `Pane could not read the ACP Registry: ${reasonOf(error)}.`, 'Check the internet connection, then open Settings > Agents again.');
      throw new PaneError('AGENT_REGISTRY_UNREACHABLE', `Pane could not read the ACP Registry: ${reasonOf(error)}.`, 'Check the internet connection, then open Settings > Agents again.');
    }
    const agents = this.decode(JSON.parse(text));
    mkdirSync(this.options.root, { recursive: true });
    writeFileSync(`${cache}.tmp`, text);
    renameSync(`${cache}.tmp`, cache);
    this.index = { agents, fetchedAt: now };
  }

  private decode(value: JsonValue): RegistryEntry[] {
    const { agents } = decodeBoundary(value, indexSchema);
    return agents.flatMap(agent => { const entry = decodeOptionalBoundary(agent, entrySchema); return entry ? [entry] : []; });
  }
}
