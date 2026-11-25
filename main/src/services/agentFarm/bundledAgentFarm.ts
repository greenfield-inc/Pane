import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { hashDirectory } from '../skillCacheManager';
import { PANE_PROFILE_PLUGIN, panePluginFiles, parseProfileList, writePanePluginSource } from './agentFarmProfiles';
import type { AgentFarmProfileList } from '../../../../shared/types/agentFarmProfiles';

const execFileAsync = promisify(execFile);

/** The npm package Pane ships (pinned in package.json and main/package.json). */
const AGENT_FARM_PACKAGE = '@greenfieldco/agent-farm';
/** Plugins the bundled package carries that Pane installs into its own config root; greenfield first. */
export const BUNDLED_AGENT_FARM_PLUGINS = ['greenfield', 'dcouple'] as const;
const MANIFEST_FILE = 'pane-manifest.json';
/** The telemetry `enabled` Pane last wrote into settings.json while Profiles was on, so turning Profiles off takes back only Pane's own. */
const TELEMETRY_MARKER_FILE = 'pane-telemetry.json';
/** Written while Pane installs one bundled plugin, naming it; still there at the next start means that install never finished. */
const INSTALLING_FILE = 'pane-installing.json';
/** The folders of a plugin Agent Farm's install receipt covers, besides plugin.yaml (Agent Farm's plugins.js). */
const RECEIPT_SECTIONS = ['profiles', 'agents', 'skills', 'instructions', 'references'];
/** Where Pane writes its own plugin's source before installing it (agentFarmProfiles.ts). */
const PANE_PLUGIN_SOURCE = 'pane-plugin';

/** The bundled Agent Farm package: its CLI entry, version and plugin sources. */
export interface BundledAgentFarm {
  root: string;
  entry: string;
  version: string;
}

/**
 * The Agent Farm package that ships inside Pane, or undefined when this build lacks it.
 * Inside a packaged Pane it sits in app.asar, which Electron's own Node reads.
 */
export function bundledAgentFarm(resolveManifest: () => string = () => require.resolve('@greenfieldco/agent-farm/package.json')): BundledAgentFarm | undefined {
  let manifest: string;
  try { manifest = resolveManifest(); }
  catch { return undefined; }
  const root = path.dirname(manifest);
  const entry = path.join(root, 'dist', 'cli.js');
  if (!existsSync(entry)) return undefined;
  const version = decodeOptionalBoundary(JSON.parse(readFileSync(manifest, 'utf8')), boundary.object({ version: boundary.string }))?.version;
  return version ? { root, entry, version } : undefined;
}

/** Pane's own Agent Farm configuration root. Pane never reads or writes the person's ~/.config/agent-farm. */
export function agentFarmConfigRoot(paneDir: string): string {
  return path.join(paneDir, 'agent-farm');
}

/** A process that runs the bundled Agent Farm CLI: Pane's Electron (or Node) with ELECTRON_RUN_AS_NODE. */
export interface AgentFarmProcess {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

type JsonFile = { state: 'read'; value: JsonObject } | { state: 'missing' } | { state: 'unreadable' };

/** A JSON object file: missing when there is no file, unreadable when it can't be read or parsed. */
function readJsonFile(file: string): JsonFile {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { return { state: decodeOptionalBoundary(error, boundary.object({ code: boundary.string }))?.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  let value: JsonObject | undefined;
  try { value = decodeOptionalBoundary(JSON.parse(text), boundary.jsonObject); }
  catch { return { state: 'unreadable' }; }
  return value ? { state: 'read', value } : { state: 'unreadable' };
}

/**
 * Whether Pane holds launches' telemetry off. Only while Profiles is on: `profiles` is the
 * caller's live Profiles state, else `sessionProfilesEnabled` in <PANE_DIR>/config.json (beside
 * the config root). With Profiles off, Agent Farm's own default decides, as before T-63. With it
 * on, Pane's saved switch (`agentFarmTelemetry`) and Agent Farm's settings.json must both say on.
 * The saved switch is what Settings shows, so turning it off wins even when the settings.json
 * write failed (review F-2). A config.json that can't be read fails safe: telemetry off, whether
 * the caller says Profiles is on (Pane kept its last good config, review F-7) or nobody says. The
 * shim launcher in runpaneShim.ts decides the same way.
 */
function telemetryHeldOff(configRoot: string, profiles: boolean | undefined): boolean {
  const saved = readJsonFile(path.join(path.dirname(configRoot), 'config.json'));
  const on = profiles ?? (saved.state === 'unreadable' || (saved.state === 'read' && saved.value.sessionProfilesEnabled === true));
  if (!on) return false;
  if (saved.state !== 'read' || saved.value.agentFarmTelemetry !== true) return true;
  const settings = readJsonFile(path.join(configRoot, 'settings.json'));
  return !(settings.state === 'read' && decodeOptionalBoundary(settings.value.telemetry, boundary.jsonObject)?.enabled === true);
}

/**
 * `agent-farm <args> --config-root <root>` with the bundled copy. While Pane holds telemetry off
 * it sets AGENT_FARM_TELEMETRY=off, the one setting that outranks a repository's
 * .agent-farm/workspace.yaml, unless the environment already chose a value. `profiles` is the
 * caller's live Profiles state; without it, config.json on disk says.
 */
export function bundledAgentFarmProcess(bundle: BundledAgentFarm, args: string[], configRoot: string, env: NodeJS.ProcessEnv = process.env, runtime: string = process.execPath, profiles?: boolean): AgentFarmProcess {
  const rest = { ...env };
  delete rest.AGENT_FARM_CONFIG_ROOT;
  if (!rest.AGENT_FARM_TELEMETRY && telemetryHeldOff(configRoot, profiles)) rest.AGENT_FARM_TELEMETRY = 'off';
  return { executable: runtime, args: [bundle.entry, ...args, '--config-root', configRoot], env: { ...rest, ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * The Agent Farm every part of Pane runs (chat launches, Session move checks, the `agent-farm`
 * shim in Pane's terminals): the bundled copy, against `<PANE_DIR>/agent-farm`. Undefined when
 * this build lacks the package. The person's own agent-farm on PATH is never used (T-63, Q3).
 */
export function paneAgentFarmProcess(paneDir: string, args: string[], options: { profiles?: boolean; env?: NodeJS.ProcessEnv; bundle?: BundledAgentFarm | null; runtime?: string }): AgentFarmProcess | undefined {
  const bundle = options.bundle === undefined ? bundledAgentFarm() : options.bundle;
  return bundle ? bundledAgentFarmProcess(bundle, args, agentFarmConfigRoot(paneDir), options.env ?? process.env, options.runtime, options.profiles) : undefined;
}

/**
 * The profiles installed in Pane's own Agent Farm (`agent-farm profiles list`), Pane's plain ones
 * marked hidden. Never throws: a missing bundle or a failed read comes back as an empty list with
 * an error that says what to do. Session move and the Session list both read it.
 */
export async function listPaneAgentFarmProfiles(paneDir: string, env: NodeJS.ProcessEnv = process.env, run: AgentFarmRunner = runAgentFarm): Promise<AgentFarmProfileList> {
  const agentFarm = paneAgentFarmProcess(paneDir, ['profiles', 'list'], env);
  if (!agentFarm) return { profiles: [], error: `This Pane build does not include ${AGENT_FARM_PACKAGE}, so it has no Agent Farm profiles. Reinstall Pane from runpane.com.` };
  try {
    return { profiles: parseProfileList(await run(agentFarm)) };
  } catch (error) {
    const reason = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1) || reasonOf(error);
    return { profiles: [], error: `Pane couldn't list its Agent Farm profiles: ${reason}. Restart Pane, then try again.` };
  }
}

/** The bundled Agent Farm's state after a start's install. */
export interface BundledAgentFarmStatus {
  state: 'missing' | 'ready' | 'failed';
  configRoot: string;
  version?: string;
  /** Installed plugin → version. */
  plugins: Record<string, string>;
  /** Bundled plugins changed here since Pane installed them, which Pane updates no longer overwrite. */
  edited: string[];
  /** Why the last install failed, and what to do. */
  error?: string;
}

const manifestSchema = boundary.object({
  hash: boundary.string,
  agentFarmVersion: boundary.string,
  plugins: boundary.record(boundary.string),
  edited: boundary.optional(boundary.array(boundary.string)),
});

const receiptSchema = boundary.object({ version: boundary.string, checksums: boundary.record(boundary.string) });

const installOutput = boundary.object({ version: boundary.string });

/** Runs one Agent Farm command and returns its stdout. */
type AgentFarmRunner = (process: AgentFarmProcess) => Promise<string>;

const runAgentFarm: AgentFarmRunner = async ({ executable, args, env }) => {
  const { stdout } = await execFileAsync(executable, args, { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout;
};

/** The JSON object at the end of `plugin install`'s output (it may print notes before it). */
function installedVersion(stdout: string): string | undefined {
  const start = stdout.lastIndexOf('\n{');
  const json = start >= 0 ? stdout.slice(start + 1) : stdout.trim();
  try { return decodeBoundary(JSON.parse(json), installOutput).version; }
  catch { return undefined; }
}

/**
 * Agent Farm collects launch telemetry unless its config root's settings.json turns it off, and
 * writes it under ~/.local/state/agent-farm unless that file names another folder. Pane's copy
 * keeps it in its own config root either way. While Profiles is on, it is off unless Settings ›
 * AI & Agents turns it on (`agentFarmTelemetry`): `enabled` is that switch. While Profiles is off
 * (`enabled` undefined), Pane leaves on or off to Agent Farm, as before T-63, and takes back an
 * `enabled` it wrote itself (pane-telemetry.json records it), leaving one written by hand. Other
 * settings in the file are kept.
 *
 * Known exception, accepted for T-63 (D-T63-1): while the switch is on, a trusted repository's
 * .agent-farm/workspace.yaml can still name its own telemetry directory, which Agent Farm ranks
 * above this file. The files stay local; Pane doesn't force its folder over the workspace's.
 */
export async function writeAgentFarmTelemetry(paneDir: string, enabled: boolean | undefined): Promise<void> {
  const configRoot = agentFarmConfigRoot(paneDir);
  const file = path.join(configRoot, 'settings.json');
  const markerFile = path.join(configRoot, TELEMETRY_MARKER_FILE);
  const directory = path.join(configRoot, 'telemetry');
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  const settings = (text === undefined ? undefined : decodeOptionalBoundary(JSON.parse(text), boundary.jsonObject)) ?? {};
  const telemetry = decodeOptionalBoundary(settings.telemetry, boundary.jsonObject) ?? {};
  const marker = await fs.readFile(markerFile, 'utf8').then(value => decodeOptionalBoundary(JSON.parse(value), telemetryMarkerSchema), () => undefined);
  const next: JsonObject = { ...telemetry, directory };
  let nextMarker: TelemetryMarker | undefined;
  if (enabled !== undefined) {
    next.enabled = enabled;
    // What was there before Pane first wrote (review F-5), kept through every later write.
    const before = decodeOptionalBoundary(telemetry.enabled, boundary.boolean);
    nextMarker = { enabled, original: marker ? marker.original : before === undefined ? {} : { enabled: before } };
  } else if (marker && telemetry.enabled === marker.enabled) {
    // Still Pane's value: give back what was there before, or nothing.
    if (marker.original.enabled === undefined) delete next.enabled;
    else next.enabled = marker.original.enabled;
  }
  const settingsText = `${JSON.stringify({ ...settings, telemetry: next }, null, 2)}\n`;
  const markerText = nextMarker ? `${JSON.stringify(nextMarker)}\n` : undefined;
  const currentMarker = await fs.readFile(markerFile, 'utf8').catch(() => undefined);
  if (text === settingsText && currentMarker === markerText) return;
  await fs.mkdir(configRoot, { recursive: true });
  // The record goes first and comes off last, so a write cut short never leaves Pane's value without it.
  if (markerText !== undefined) await fs.writeFile(markerFile, markerText);
  if (text !== settingsText) await fs.writeFile(file, settingsText);
  if (markerText === undefined) await fs.rm(markerFile, { force: true });
}

const telemetryMarkerSchema = boundary.object({
  enabled: boundary.boolean,
  original: boundary.object({ enabled: boundary.optional(boundary.boolean) }),
});
type TelemetryMarker = { enabled: boolean; original: { enabled?: boolean } };

export interface AgentFarmTelemetrySyncOptions {
  write?: (paneDir: string, enabled: boolean | undefined) => Promise<void>;
  onError: (error: Error, wanted: boolean | undefined) => void;
}

export interface AgentFarmTelemetrySync {
  /** Writes what Pane wants now, after any write already queued. */
  sync(): Promise<void>;
}

/**
 * Keeps settings.json's telemetry in step with what Pane wants (`wanted()`: the switch while
 * Profiles is on, undefined while it is off), one write at a time (review F-6). A sync asked for
 * while a write runs waits for it and then reads `wanted()`, so the last toggle wins. A failed write is reported and retried at the next sync.
 */
export function agentFarmTelemetrySync(paneDir: string, wanted: () => boolean | undefined, options: AgentFarmTelemetrySyncOptions): AgentFarmTelemetrySync {
  const write = options.write ?? writeAgentFarmTelemetry;
  let written: { value: boolean | undefined } | undefined;
  let queue: Promise<void> = Promise.resolve();
  // Each sync reads wanted() only when its turn comes, so the last one queued writes the latest value.
  const run = async (): Promise<void> => {
    const value = wanted();
    if (written && written.value === value) return;
    try {
      await write(paneDir, value);
      written = { value };
    } catch (error) {
      written = undefined;
      options.onError(error instanceof Error ? error : new Error(String(error)), value);
    }
  };
  return { sync: () => (queue = queue.then(run)) };
}

/** Every file a receipt covers in an installed plugin, relative with `/`, and its SHA-256 (Agent Farm's hash). */
async function receiptInventory(pluginRoot: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = async (folder: string): Promise<void> => {
    const children = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const full = path.join(folder, child.name);
      if (child.isDirectory()) await visit(full);
      // A link or other non-file differs from anything Pane installed.
      else entries[path.relative(pluginRoot, full).split(path.sep).join('/')] = child.isFile() ? createHash('sha256').update(await fs.readFile(full)).digest('hex') : 'not-a-file';
    }
  };
  for (const section of RECEIPT_SECTIONS) await visit(path.join(pluginRoot, section));
  const manifest = await fs.readFile(path.join(pluginRoot, 'plugin.yaml')).catch(() => undefined);
  if (manifest) entries['plugin.yaml'] = createHash('sha256').update(manifest).digest('hex');
  return entries;
}

async function readReceipt(configRoot: string, name: string) {
  const text = await fs.readFile(path.join(configRoot, '.plugins', `${name}.json`), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : decodeOptionalBoundary(JSON.parse(text), receiptSchema);
}

async function installedVersionOf(configRoot: string, name: string): Promise<string> {
  return (await readReceipt(configRoot, name))?.version ?? 'unknown';
}

/**
 * A bundled plugin's install receipt when its files still match it, 'edited' when someone
 * changed, added or removed a file since, or undefined when it has no receipt (never installed,
 * or a first install that never finished).
 */
async function installedState(configRoot: string, name: string): Promise<{ version: string } | 'edited' | undefined> {
  const receipt = await readReceipt(configRoot, name);
  if (!receipt) return undefined;
  const current = await receiptInventory(path.join(configRoot, 'plugins', name));
  const files = new Set([...Object.keys(current), ...Object.keys(receipt.checksums)]);
  return [...files].every((file) => current[file] === receipt.checksums[file]) ? { version: receipt.version } : 'edited';
}

/**
 * Removes what an install that never finished (killed by the timeout, a crash or a quit) left
 * behind: Agent Farm's install lock, which makes every later install refuse, and the bundled
 * plugins' half-copied files: the one Pane was installing then (pane-installing.json), and those
 * with no receipt. The config root is Pane's, so nothing else is installing.
 */
async function clearUnfinishedInstall(configRoot: string, plugins: readonly string[]): Promise<void> {
  await fs.rm(path.join(configRoot, '.plugins', 'install.lock'), { recursive: true, force: true });
  for (const name of plugins) {
    await fs.rm(path.join(configRoot, 'plugins', name), { recursive: true, force: true });
    await fs.rm(path.join(configRoot, '.plugins', `${name}.json`), { force: true });
  }
}

export interface InstallBundledAgentFarmOptions {
  paneDir: string;
  /**
   * Settings › AI & Agents › Save Agent Farm telemetry on this computer while Profiles is on;
   * undefined while Profiles is off, when Agent Farm's own default decides (as before T-63).
   */
  telemetry?: boolean;
  /** Writes the telemetry setting through Pane's one queue (agentFarmTelemetrySync) instead of `telemetry`. */
  syncTelemetry?: () => Promise<void>;
  bundle?: BundledAgentFarm;
  run?: AgentFarmRunner;
  log?: (message: string) => void;
}

/**
 * Installs greenfield and the other bundled plugins into `<PANE_DIR>/agent-farm` with the
 * bundled Agent Farm, when the bundle (its version and plugin files) differs from what the
 * manifest there records; an unchanged bundle installs nothing. A bundled plugin someone changed
 * since Pane installed it (its files no longer match Agent Farm's install receipt) is kept as it
 * is and reported in `edited`: it is theirs now (T-63, A-3). Pane's own plugin, `pane` (the plain
 * Claude and Codex profiles, agentFarmProfiles.ts), is installed beside them and always replaced.
 * Called at startup without waiting.
 * Never throws: a failure is logged and returned in the status.
 */
export async function installBundledAgentFarm(options: InstallBundledAgentFarmOptions): Promise<BundledAgentFarmStatus> {
  let status: BundledAgentFarmStatus;
  const log = options.log ?? ((message: string) => console.log(message));
  const configRoot = agentFarmConfigRoot(options.paneDir);
  const bundle = options.bundle ?? bundledAgentFarm();
  if (!bundle) {
    status = { state: 'missing', configRoot, plugins: {}, edited: [], error: `This Pane build does not include ${AGENT_FARM_PACKAGE}, so its Agent Farm profiles can't be set up. Reinstall Pane from runpane.com.` };
    log(`[AgentFarm] ${status.error}`);
    return status;
  }
  try {
    await (options.syncTelemetry ? options.syncTelemetry() : writeAgentFarmTelemetry(options.paneDir, options.telemetry));
  } catch (error) {
    log(`[AgentFarm] Pane couldn't write Agent Farm's telemetry setting in ${configRoot}: ${reasonOf(error)}.`);
  }
  const manifestPath = path.join(configRoot, MANIFEST_FILE);
  let hash: string;
  try {
    // Pane's own plugin is part of the bundle: a Pane whose agents contract changed reinstalls it.
    hash = `${bundle.version}:${await hashDirectory(path.join(bundle.root, 'plugins'))}:${createHash('sha256').update(JSON.stringify([...panePluginFiles()])).digest('hex')}`;
  } catch (error) {
    status = { state: 'failed', configRoot, version: bundle.version, plugins: {}, edited: [], error: `Pane couldn't read the bundled Agent Farm's plugins: ${reasonOf(error)}. Reinstall Pane from runpane.com.` };
    log(`[AgentFarm] ${status.error}`);
    return status;
  }
  const previous = await fs.readFile(manifestPath, 'utf8').then((text) => decodeOptionalBoundary(JSON.parse(text), manifestSchema)).catch(() => undefined);
  const installed = previous && [...BUNDLED_AGENT_FARM_PLUGINS, PANE_PROFILE_PLUGIN].every((name) => existsSync(path.join(configRoot, 'plugins', name)));
  if (previous && installed && previous.hash === hash) {
    status = { state: 'ready', configRoot, version: bundle.version, plugins: previous.plugins, edited: previous.edited ?? [] };
    log(`[AgentFarm] Bundled Agent Farm ${bundle.version} is already set up in ${configRoot} (manifest hash unchanged); nothing reinstalled.`);
    return status;
  }
  log(`[AgentFarm] Setting up bundled Agent Farm ${bundle.version} in ${configRoot} (${previous ? `bundle changed from ${previous.agentFarmVersion}` : 'first start'}).`);
  const run = options.run ?? runAgentFarm;
  const plugins: Record<string, string> = {};
  const edited: string[] = [];
  const installingPath = path.join(configRoot, INSTALLING_FILE);
  try {
    await fs.mkdir(configRoot, { recursive: true });
    const unfinished: string[] = await fs.readFile(installingPath, 'utf8').then((text) => decodeOptionalBoundary(JSON.parse(text), boundary.array(boundary.string)) ?? []).catch(() => []);
    const install: string[] = [];
    const clear: string[] = [];
    for (const name of BUNDLED_AGENT_FARM_PLUGINS) {
      // A plugin Pane was installing when it stopped is Pane's half-copy, not an edit.
      const state = unfinished.includes(name) ? undefined : await installedState(configRoot, name);
      if (state === 'edited') {
        edited.push(name);
        plugins[name] = await installedVersionOf(configRoot, name);
        continue;
      }
      install.push(name);
      if (!state) clear.push(name);
    }
    await clearUnfinishedInstall(configRoot, clear);
    for (const name of install) {
      // Names only the plugin being installed, and only until it succeeds: one that finished
      // has a receipt that guards its later edits, even when a plugin after it fails (review F-1).
      await fs.writeFile(installingPath, `${JSON.stringify([name])}\n`);
      // No name installs the package's default plugin, greenfield.
      const args = name === 'greenfield' ? ['plugin', 'install'] : ['plugin', 'install', name];
      const stdout = await run(bundledAgentFarmProcess(bundle, args, configRoot));
      plugins[name] = installedVersion(stdout) ?? 'unknown';
      await fs.rm(installingPath, { force: true });
    }
    // Pane's own plugin is always Pane's: an edit there is replaced, not kept.
    const source = path.join(configRoot, PANE_PLUGIN_SOURCE, PANE_PROFILE_PLUGIN);
    await writePanePluginSource(source);
    await clearUnfinishedInstall(configRoot, [PANE_PROFILE_PLUGIN]);
    plugins[PANE_PROFILE_PLUGIN] = installedVersion(await run(bundledAgentFarmProcess(bundle, ['plugin', 'install', source], configRoot))) ?? 'unknown';
    await fs.writeFile(manifestPath, `${JSON.stringify({ hash, agentFarmVersion: bundle.version, plugins, edited }, null, 2)}\n`);
  } catch (error) {
    const reason = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1) || reasonOf(error);
    status = { state: 'failed', configRoot, version: bundle.version, plugins, edited, error: `Pane couldn't set up its bundled Agent Farm in ${configRoot}: ${reason}. Its Agent Farm profiles may be out of date; restart Pane to try again.` };
    log(`[AgentFarm] ${status.error}`);
    return status;
  }
  if (edited.length) log(`[AgentFarm] Bundled Agent Farm ${bundle.version}: kept ${edited.join(', ')} because it was changed here since Pane installed it; Pane updates no longer replace it.`);
  status = { state: 'ready', configRoot, version: bundle.version, plugins, edited };
  log(`[AgentFarm] Bundled Agent Farm ${bundle.version} set up: ${Object.entries(plugins).map(([name, version]) => `${name} ${version}`).join(', ')}.`);
  return status;
}
