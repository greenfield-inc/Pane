import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import yaml from 'js-yaml';
import { reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { hashDirectory } from '../skillCacheManager';
import { syncedPluginEdits } from './profileSyncFile';
import { writeRecoveryNote } from './agentFarmRecovery';
import { panePluginFiles, panePluginInstalled, parseProfileList, writePanePluginSource } from './agentFarmProfiles';
import { PANE_PROFILE_PLUGIN } from '../../../../shared/agentProfiles';
import type { AgentFarmProfileList } from '../../../../shared/types/agentFarmProfiles';

const execFileAsync = promisify(execFile);

/** The npm package Pane ships (pinned in package.json and main/package.json). */
const AGENT_FARM_PACKAGE = '@greenfieldco/agent-farm';
/** Plugins Pane installs from the bundled package into its own config root. */
export const BUNDLED_AGENT_FARM_PLUGINS = ['greenfield'] as const;
/**
 * Plugins older Pane builds installed into its config root (dcouple was bundled; bigbrain is
 * older still). Each start uninstalls whichever of them is still there.
 */
export const RETIRED_AGENT_FARM_PLUGINS = ['dcouple', 'bigbrain'] as const;
const MANIFEST_FILE = 'pane-manifest.json';
/** The telemetry `enabled` Pane last wrote into settings.json while Profiles was on, so turning Profiles off takes back only Pane's own. */
const TELEMETRY_MARKER_FILE = 'pane-telemetry.json';
/** Written while Pane installs one bundled plugin, naming it; still there at the next start means that install never finished. */
const INSTALLING_FILE = 'pane-installing.json';
/** Where Restore keeps an edited plugin and its receipt while the bundled copy installs. */
const RESTORE_DIR = 'pane-restore';
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
  /** The folder it runs in; absent, Pane's own working folder. */
  cwd?: string;
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
  // Only read while Profiles is on (chat-tab:profiles and a Session's named profile check that first).
  const agentFarm = paneAgentFarmProcess(paneDir, ['profiles', 'list'], { env, profiles: true });
  if (!agentFarm) return { profiles: [], error: `This Pane build does not include ${AGENT_FARM_PACKAGE}, so it has no Agent Farm profiles. Reinstall Pane from runpane.com.` };
  try {
    return { profiles: parseProfileList(await run(agentFarm)) };
  } catch (error) {
    const reason = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1) || reasonOf(error);
    return { profiles: [], error: `Pane couldn't list its Agent Farm profiles: ${reason}. Restart Pane, then try again.` };
  }
}

/**
 * The harness a profile or variant (`plugin/profile[:variant]`) really runs, from `agent-farm inspect`
 * in Pane's own Agent Farm; undefined when the bundle is missing or the profile can't be read.
 * A Session checks a variant's agent with it before it is saved (review F-4).
 */
export async function paneAgentFarmHarness(paneDir: string, ref: string, env: NodeJS.ProcessEnv = process.env, run: AgentFarmRunner = runAgentFarm): Promise<string | undefined> {
  const agentFarm = paneAgentFarmProcess(paneDir, ['inspect', ref], { env, profiles: true });
  if (!agentFarm) return undefined;
  try {
    // inspect reads the workspace.yaml of the repository it runs in, and refuses an untrusted one: run it
    // in Pane's own Agent Farm folder, where a profile's harness is the plugin's alone.
    const inspected = decodeOptionalBoundary(JSON.parse(await run({ ...agentFarm, cwd: agentFarmConfigRoot(paneDir) })), boundary.object({ agents: boundary.record(boundary.jsonObject) }));
    return decodeOptionalBoundary(inspected?.agents.main?.harness, boundary.nonEmptyString);
  } catch (error) {
    console.warn(`[AgentFarm] Pane couldn't read which agent ${ref} runs: ${reasonOf(error)}`);
    return undefined;
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
  /**
   * Edited bundled plugins this Agent Farm rejected (review F-3): each was saved unchanged in
   * `folder` and replaced with the copy this Pane ships, so the profile list keeps working.
   */
  recovered?: Array<{ plugin: string; folder: string; reason: string }>;
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
const uninstallOutput = boundary.object({
  removed: boundary.array(boundary.string),
  stayed: boundary.array(boundary.object({ file: boundary.string, reason: boundary.string })),
});

/** Runs one Agent Farm command and returns its stdout. */
export type AgentFarmRunner = (process: AgentFarmProcess) => Promise<string>;

export const runAgentFarm: AgentFarmRunner = async ({ executable, args, env, cwd }) => {
  const { stdout } = await execFileAsync(executable, args, { env, cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout;
};

/** The JSON object at the end of `plugin install`'s output (it may print notes before it). */
function installedVersion(stdout: string): string | undefined {
  const start = stdout.lastIndexOf('\n{');
  const json = start >= 0 ? stdout.slice(start + 1) : stdout.trim();
  try { return decodeBoundary(JSON.parse(json), installOutput).version; }
  catch { return undefined; }
}

/** Where the retired plugins' shipped copies came from: their packed source repository. */
const STOCK_RETIRED_REPOSITORY = /^(https:\/\/github\.com\/|git@github\.com:)(greenfield-inc|dcouple)\/(skills|agent-farm)(\.git)?$/;

/** Where Agent Farm's receipt says a plugin came from: the pack's repository, or the folder it was installed from. */
type ReceiptSource = { repository?: string; path?: string };

const receiptSourceSchema = boundary.object({
  source: boundary.optional(boundary.object({ repository: boundary.optional(boundary.string), path: boundary.optional(boundary.string) })),
});

/**
 * Whether a retired plugin's receipt is the copy an older Pane installed from its bundled Agent
 * Farm (review F-1): installed from the package's own plugins folder, or from the pack it carried
 * (whose plugin.yaml names the stock repository), and not a save that arrived through profile sync.
 * Anything else, such as a profile made in the Profiles editor under the same name, is the person's.
 */
function stockRetiredInstall(name: string, source: ReceiptSource | undefined, synced: ReadonlySet<string>): boolean {
  if (synced.has(name)) return false;
  if (source?.repository !== undefined) return STOCK_RETIRED_REPOSITORY.test(source.repository);
  const from = source?.path?.split('\\').join('/');
  return from !== undefined && from.endsWith(`/node_modules/@greenfieldco/agent-farm/plugins/${name}`);
}

/**
 * Uninstalls each retired plugin that Agent Farm's receipt says an older Pane installed in its
 * config root, with Agent Farm's own `plugin uninstall`: it deletes only files unchanged since the
 * install and leaves changed ones in place. A plugin of the same name the person made or synced is
 * kept. Never throws; each outcome is logged.
 */
async function uninstallRetiredPlugins(bundle: BundledAgentFarm, configRoot: string, run: AgentFarmRunner, log: (message: string) => void): Promise<void> {
  const present = RETIRED_AGENT_FARM_PLUGINS.filter((name) => existsSync(path.join(configRoot, '.plugins', `${name}.json`)));
  if (present.length === 0) return;
  const synced = await syncedPluginEdits(configRoot);
  // A lock left by a killed install would refuse the uninstall; the config root is Pane's alone.
  await fs.rm(path.join(configRoot, '.plugins', 'install.lock'), { recursive: true, force: true }).catch(() => undefined);
  for (const name of present) {
    const receipt = path.join(configRoot, '.plugins', `${name}.json`);
    // Agent Farm reads every receipt when it installs, so one it can't parse would fail greenfield's
    // install on every start too. Keep its bytes under a name Agent Farm doesn't read, and its files.
    const text = await fs.readFile(receipt, 'utf8').catch(() => undefined);
    let malformed = false;
    let parsed: unknown;
    try { if (text !== undefined) parsed = JSON.parse(text); } catch { malformed = true; }
    if (malformed) {
      const aside = `${receipt}.unreadable-${Date.now()}`;
      await fs.rename(receipt, aside).then(
        () => log(`[AgentFarm] The receipt for the retired Agent Farm plugin ${name} isn't valid JSON, so Agent Farm can't uninstall it; Pane moved it aside to ${aside} and left the plugin's files in ${path.join(configRoot, 'plugins', name)}. Delete both if you don't need them.`),
        (error: NodeJS.ErrnoException) => log(`[AgentFarm] The receipt for the retired Agent Farm plugin ${name} isn't valid JSON, and Pane couldn't move it aside (${error.message}). Agent Farm's installs in ${configRoot} fail until ${receipt} is moved or deleted.`),
      );
      continue;
    }
    if (!stockRetiredInstall(name, decodeOptionalBoundary(parsed, receiptSourceSchema)?.source, synced)) {
      log(`[AgentFarm] Kept the Agent Farm plugin ${name} in ${path.join(configRoot, 'plugins', name)}: Pane no longer ships a plugin by that name, but this copy was made or synced here, so it is yours.`);
      continue;
    }
    try {
      const stdout = await run(bundledAgentFarmProcess(bundle, ['plugin', 'uninstall', name], configRoot));
      const start = stdout.indexOf('{');
      const result = decodeOptionalBoundary(JSON.parse(start >= 0 ? stdout.slice(start) : '{}'), uninstallOutput);
      const changed = result?.stayed.filter((entry) => entry.reason === 'modified').map((entry) => entry.file) ?? [];
      const kept = changed.length ? `, left ${changed.length} changed file${changed.length === 1 ? '' : 's'} in place (${changed.join(', ')})` : '';
      log(`[AgentFarm] Uninstalled retired plugin ${name}: removed ${result?.removed.length ?? 0} files${kept}.`);
    } catch (error) {
      const reason = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1) || reasonOf(error);
      log(`[AgentFarm] Pane couldn't uninstall the retired Agent Farm plugin ${name} from ${configRoot}: ${reason}. Pane will try again on its next start.`);
    }
  }
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
  const currentMarker = await fs.readFile(markerFile, 'utf8').catch(() => undefined);
  const marker = currentMarker === undefined ? undefined : (() => {
    try { return decodeOptionalBoundary(JSON.parse(currentMarker), telemetryMarkerSchema); }
    catch { return undefined; }
  })();
  const current = decodeOptionalBoundary(telemetry.enabled, boundary.boolean);
  // settings.json still holds a value Pane wrote: the one it last asked for, or, when that write
  // never landed, the one before it (review F-6).
  const panesOwn = marker !== undefined && current !== undefined && (current === marker.enabled || current === marker.prior);
  const next: JsonObject = { ...telemetry, directory };
  let pending: TelemetryMarker | undefined;
  let done: TelemetryMarker | undefined;
  if (enabled !== undefined) {
    next.enabled = enabled;
    // What was there before Pane first wrote (review F-5), kept through every later write.
    const original = marker ? marker.original : current === undefined ? {} : { enabled: current };
    done = { enabled, original };
    // Until settings.json takes the new value, the record also names the value Pane wrote before.
    pending = panesOwn && current !== enabled ? { enabled, prior: current, original } : done;
  } else if (marker && panesOwn) {
    // Still Pane's value: give back what was there before, or nothing.
    if (marker.original.enabled === undefined) delete next.enabled;
    else next.enabled = marker.original.enabled;
  }
  const settingsText = `${JSON.stringify({ ...settings, telemetry: next }, null, 2)}\n`;
  const markerText = (value: TelemetryMarker | undefined) => value ? `${JSON.stringify(value)}\n` : undefined;
  if (text === settingsText && currentMarker === markerText(done)) return;
  await fs.mkdir(configRoot, { recursive: true });
  // The record goes first and comes off last, so a write cut short never leaves Pane's value without it.
  const pendingText = markerText(pending);
  if (pendingText !== undefined && pendingText !== currentMarker) await fs.writeFile(markerFile, pendingText);
  if (text !== settingsText) await fs.writeFile(file, settingsText);
  const doneText = markerText(done);
  if (doneText === undefined) await fs.rm(markerFile, { force: true });
  else if (doneText !== pendingText) await fs.writeFile(markerFile, doneText);
}

const telemetryMarkerSchema = boundary.object({
  enabled: boundary.boolean,
  prior: boundary.optional(boundary.boolean),
  original: boundary.object({ enabled: boundary.optional(boundary.boolean) }),
});
/** pane-telemetry.json: the `enabled` Pane asked for, the one it wrote before while that write is unconfirmed, and what was there before Pane. */
type TelemetryMarker = { enabled: boolean; prior?: boolean; original: { enabled?: boolean } };

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

function receiptPath(configRoot: string, name: string): string {
  return path.join(configRoot, '.plugins', `${name}.json`);
}

type Receipt = { state: 'read'; version: string; checksums: Record<string, string> } | { state: 'missing' } | { state: 'unreadable'; reason: string };

/** A plugin's install receipt: missing only when there is no file; one that can't be read, parsed or decoded is unreadable (review F-10). */
async function readReceipt(configRoot: string, name: string): Promise<Receipt> {
  let text: string;
  try { text = await fs.readFile(receiptPath(configRoot, name), 'utf8'); }
  catch (error) {
    return decodeOptionalBoundary(error, boundary.object({ code: boundary.string }))?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', reason: reasonOf(error) };
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { return { state: 'unreadable', reason: `it isn't valid JSON (${reasonOf(error)})` }; }
  const receipt = decodeOptionalBoundary(value, receiptSchema);
  return receipt ? { state: 'read', ...receipt } : { state: 'unreadable', reason: 'it has no version or checksums' };
}

async function installedVersionOf(configRoot: string, name: string): Promise<string> {
  const receipt = await readReceipt(configRoot, name);
  return receipt.state === 'read' ? receipt.version : 'unknown';
}

/**
 * A bundled plugin's install receipt when its files still match it, 'edited' when someone
 * changed, added or removed a file since, undefined when it has no receipt (never installed,
 * or a first install that never finished), or unreadable when its plugin folder is there but
 * Pane can't read the receipt that would tell an edit apart: the folder is kept (review F-10).
 */
export async function installedState(configRoot: string, name: string): Promise<{ version: string } | 'edited' | { unreadable: string } | undefined> {
  const receipt = await readReceipt(configRoot, name);
  if (receipt.state === 'missing') return undefined;
  if (receipt.state === 'unreadable') return existsSync(path.join(configRoot, 'plugins', name)) ? { unreadable: receipt.reason } : undefined;
  const current = await receiptInventory(path.join(configRoot, 'plugins', name));
  const files = new Set([...Object.keys(current), ...Object.keys(receipt.checksums)]);
  return [...files].every((file) => current[file] === receipt.checksums[file]) ? { version: receipt.version } : 'edited';
}

/**
 * A plugin installed from a pack (greenfield) lists its files' checksums in plugin.yaml,
 * which `plugin validate` checks but launches don't. Any edit changes a file, so the staged copy
 * Pane validates leaves them out; the installed plugin.yaml keeps them.
 */
export async function withoutPackChecksums(manifestFile: string): Promise<void> {
  const content = await fs.readFile(manifestFile, 'utf8').catch(() => undefined);
  if (content === undefined) return;
  let data: JsonObject | undefined;
  try { data = decodeOptionalBoundary(yaml.load(content), boundary.jsonObject); }
  catch { return; }
  if (!data || !('checksums' in data)) return;
  const { checksums: _packed, ...rest } = data;
  await fs.writeFile(manifestFile, yaml.dump(rest, { lineWidth: -1 }));
}

/**
 * Why this Agent Farm rejects a bundled plugin kept because it was edited, or undefined when it
 * passes `plugin validate` (review F-3: an edited greenfield from Agent Farm 0.2 can name variants
 * 0.3 refuses, and then `profiles list` fails for every plugin). It checks a copy without the pack's
 * checksums, as the Profiles editor does. A copy Pane can't make counts as passing: the edit stays.
 */
async function rejectedBy(bundle: BundledAgentFarm, configRoot: string, name: string, run: AgentFarmRunner): Promise<string | undefined> {
  const drafts = path.join(configRoot, 'drafts');
  const staging = path.join(drafts, `.check-${name}-${randomBytes(4).toString('hex')}`, name);
  try {
    try {
      await fs.cp(path.join(configRoot, 'plugins', name), staging, { recursive: true, verbatimSymlinks: true });
      await withoutPackChecksums(path.join(staging, 'plugin.yaml'));
    } catch {
      return undefined;
    }
    try { await run(bundledAgentFarmProcess(bundle, ['plugin', 'validate', staging], configRoot)); }
    catch (error) { return decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1) || reasonOf(error); }
    return undefined;
  } finally {
    await fs.rm(path.dirname(staging), { recursive: true, force: true });
    await fs.rmdir(drafts).catch(() => undefined);
  }
}

/**
 * Saves an edited bundled plugin, its files and Agent Farm's receipt, unchanged in
 * `<config root>/recovered/<name>-<version>-<time>/`, where neither Agent Farm nor profile sync
 * reads, with a note on what happened. Throws when the copy can't be made.
 */
async function saveRecoveryCopy(configRoot: string, name: string, bundleVersion: string, reason: string): Promise<string> {
  const version = await installedVersionOf(configRoot, name);
  const folder = path.join(configRoot, 'recovered', `${name}-${version}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(path.dirname(folder), { recursive: true });
  await fs.mkdir(folder);
  await fs.cp(path.join(configRoot, 'plugins', name), path.join(folder, 'plugin'), { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  await fs.copyFile(path.join(configRoot, '.plugins', `${name}.json`), path.join(folder, 'receipt.json'));
  await fs.writeFile(path.join(folder, 'README.txt'), [
    `This is your edited ${name} ${version}, saved unchanged by Pane on ${new Date().toISOString()}.`,
    `Agent Farm ${bundleVersion}, which this Pane runs, rejects it: ${reason}.`,
    `Pane installed the ${name} that ships with it instead, so your profiles keep working.`,
    `To bring your changes back, copy what you need from plugin/ into ${name} in the Profiles editor; it checks each save.`,
    '',
  ].join('\n'));
  // The Profiles tab's one-time notice reads this (agentFarmRecovery.ts).
  await writeRecoveryNote(folder, { plugin: name, version, reason });
  return folder;
}

/**
 * Removes what an install that never finished (killed by the timeout, a crash or a quit) left
 * behind: Agent Farm's install lock, which makes every later install refuse, and the bundled
 * plugins' half-copied files: the one Pane was installing then (pane-installing.json), and those
 * with no receipt. The config root is Pane's, so nothing else is installing.
 */
/** Renames `from` to `to` when `from` exists; true when it moved. */
async function moveIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await fs.rename(from, to);
    return true;
  } catch (error) {
    if (decodeOptionalBoundary(error, boundary.object({ code: boundary.string }))?.code === 'ENOENT') return false;
    throw error;
  }
}

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
  /**
   * The Profiles switch at startup (D-474). Only while it is on does a Pane plugin that profile sync
   * marked as your copy in sync.json stay through an update; off, the receipt alone decides, as
   * before T-63 (review F-12). Absent: off.
   */
  profiles?: boolean;
  bundle?: BundledAgentFarm;
  run?: AgentFarmRunner;
  log?: (message: string) => void;
}

/**
 * Uninstalls retired plugins, then installs greenfield into `<PANE_DIR>/agent-farm` with the
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
  const run = options.run ?? runAgentFarm;
  await uninstallRetiredPlugins(bundle, configRoot, run, log);
  const previous = await fs.readFile(manifestPath, 'utf8').then((text) => decodeOptionalBoundary(JSON.parse(text), manifestSchema)).catch(() => undefined);
  // Pane's own plugin must also still be exactly what Pane writes: an edit there is replaced.
  const installed = previous && BUNDLED_AGENT_FARM_PLUGINS.every((name) => existsSync(path.join(configRoot, 'plugins', name))) && await panePluginInstalled(configRoot);
  // An install that never finished may have recreated the plugin's folder, so its marker wins over the fast path (review F-1).
  const installingPath = path.join(configRoot, INSTALLING_FILE);
  const unfinished: string[] = await fs.readFile(installingPath, 'utf8').then((text) => decodeOptionalBoundary(JSON.parse(text), boundary.array(boundary.string)) ?? []).catch(() => []);
  if (previous && installed && previous.hash === hash && unfinished.length === 0 && BUNDLED_AGENT_FARM_PLUGINS.every((name) => name in previous.plugins)) {
    const retired: readonly string[] = RETIRED_AGENT_FARM_PLUGINS;
    const dropped = Object.keys(previous.plugins).filter((name) => retired.includes(name));
    const plugins = Object.fromEntries(Object.entries(previous.plugins).filter(([name]) => !dropped.includes(name)));
    const edited = (previous.edited ?? []).filter((name) => !dropped.includes(name));
    if (dropped.length) {
      // An older Pane bundled more plugins; drop them from the manifest and leave greenfield's files alone.
      try {
        await fs.writeFile(`${manifestPath}.tmp`, `${JSON.stringify({ ...previous, plugins, edited }, null, 2)}\n`);
        await fs.rename(`${manifestPath}.tmp`, manifestPath);
        log(`[AgentFarm] Bundle unchanged; dropped ${dropped.join(', ')} from the manifest in ${configRoot}.`);
      } catch (error) {
        log(`[AgentFarm] Pane couldn't drop ${dropped.join(', ')} from ${manifestPath}: ${reasonOf(error)}. It tries again on the next start.`);
      }
    }
    status = { state: 'ready', configRoot, version: bundle.version, plugins, edited };
    log(`[AgentFarm] Bundled Agent Farm ${bundle.version} is already set up in ${configRoot} (manifest hash unchanged); nothing reinstalled.`);
    return status;
  }
  log(`[AgentFarm] Setting up bundled Agent Farm ${bundle.version} in ${configRoot} (${!previous ? 'first start' : previous.hash !== hash ? `bundle changed from ${previous.agentFarmVersion}` : 'a plugin changed or is missing here'}).`);
  const plugins: Record<string, string> = {};
  const edited: string[] = [];
  const recovered: NonNullable<BundledAgentFarmStatus['recovered']> = [];
  try {
    await fs.mkdir(configRoot, { recursive: true });
    const install: string[] = [];
    const clear: string[] = [];
    // Bundled plugins whose install receipt can't be read (review F-10).
    const unreadable: string[] = [];
    // An edited copy that arrived from another computer matches its own receipt, so sync.json says it is yours (T-63 PR 6),
    // which counts only while Profiles is on (review F-12).
    const synced = options.profiles === true ? await syncedPluginEdits(configRoot) : new Set<string>();
    for (const name of BUNDLED_AGENT_FARM_PLUGINS) {
      // A plugin Pane was installing when it stopped is Pane's half-copy, not an edit.
      const state = unfinished.includes(name) ? undefined : await installedState(configRoot, name);
      if (state === 'edited' || (state && synced.has(name))) {
        const reason = await rejectedBy(bundle, configRoot, name, run);
        let folder: string | undefined;
        if (reason !== undefined) {
          try { folder = await saveRecoveryCopy(configRoot, name, bundle.version, reason); }
          catch (error) { log(`[AgentFarm] Agent Farm ${bundle.version} rejects your edited ${name} (${reason}), and Pane couldn't save a copy of it (${reasonOf(error)}), so it kept it as it is. Its profiles may not list until you fix or restore it.`); }
        }
        if (reason === undefined || folder === undefined) {
          edited.push(name);
          plugins[name] = await installedVersionOf(configRoot, name);
          continue;
        }
        recovered.push({ plugin: name, folder, reason });
        log(`[AgentFarm] Agent Farm ${bundle.version} rejects your edited ${name} (${reason}), which would leave New Session with no named profiles. Pane saved it unchanged in ${folder} and is installing the ${name} that ships with this Pane.`);
        install.push(name);
        clear.push(name);
        continue;
      }
      if (state && 'unreadable' in state) {
        // Without its receipt Pane can't tell an edit from its own copy, so it keeps the folder.
        edited.push(name);
        plugins[name] = 'unknown';
        unreadable.push(`${receiptPath(configRoot, name)} (${state.unreadable})`);
        continue;
      }
      install.push(name);
      if (!state) clear.push(name);
    }
    if (unreadable.length) {
      // Agent Farm refuses every install while a receipt is broken, so Pane changes nothing and
      // says so; with no manifest written, the next start checks again.
      status = { state: 'failed', configRoot, version: bundle.version, plugins, edited, error: `Pane kept its bundled Agent Farm plugins in ${configRoot} as they are and updated none, because it can't read the install receipt ${unreadable.join(', ')}, so it can't tell your changes from its own copy. To keep your changes, copy them out of ${path.join(configRoot, 'plugins')} first; then delete that receipt and the plugin's folder and restart Pane to get Pane's version.` };
      log(`[AgentFarm] ${status.error}`);
      return status;
    }
    await clearUnfinishedInstall(configRoot, clear);
    for (const name of install) {
      // Names only the plugin being installed, and only until it succeeds: one that finished
      // has a receipt that guards its later edits, even when a plugin after it fails (review F-1).
      await fs.writeFile(installingPath, `${JSON.stringify([name])}\n`);
      const stdout = await run(bundledAgentFarmProcess(bundle, bundledInstallArgs(name), configRoot));
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
    if (recovered.length) status.recovered = recovered;
    log(`[AgentFarm] ${status.error}`);
    return status;
  }
  if (edited.length) log(`[AgentFarm] Bundled Agent Farm ${bundle.version}: kept ${edited.join(', ')} because it was changed here since Pane installed it; Pane updates no longer replace it.`);
  status = { state: 'ready', configRoot, version: bundle.version, plugins, edited };
  if (recovered.length) status.recovered = recovered;
  log(`[AgentFarm] Bundled Agent Farm ${bundle.version} set up: ${Object.entries(plugins).map(([name, version]) => `${name} ${version}`).join(', ')}.`);
  return status;
}

/** The `plugin install` arguments for a bundled plugin: no name installs the package's default, greenfield. */
function bundledInstallArgs(name: string): string[] {
  return name === 'greenfield' ? ['plugin', 'install'] : ['plugin', 'install', name];
}

/**
 * Restore Pane's version (T-63, A-3): replaces a bundled plugin someone edited with the copy this
 * Pane ships, and records in the manifest that Pane updates replace it again. The edited copy and
 * its receipt are moved aside first and put back when the install fails, so a timeout or a full
 * disk leaves your edits as they were (review F-1); the error is then thrown. Only a crash between
 * the two leaves the plugin to the next start, which reinstalls it as you asked, and the moved
 * copy stays in pane-restore/ until the next Restore.
 */
export async function reinstallBundledPlugin(paneDir: string, name: string, bundle: BundledAgentFarm, run: AgentFarmRunner = runAgentFarm): Promise<string> {
  const configRoot = agentFarmConfigRoot(paneDir);
  const live = { plugin: path.join(configRoot, 'plugins', name), receipt: path.join(configRoot, '.plugins', `${name}.json`) };
  const aside = path.join(configRoot, RESTORE_DIR, name);
  const moved = { plugin: path.join(aside, 'plugin'), receipt: path.join(aside, 'receipt.json') };
  await fs.rm(aside, { recursive: true, force: true });
  await fs.mkdir(aside, { recursive: true });
  const installingPath = path.join(configRoot, INSTALLING_FILE);
  await fs.writeFile(installingPath, `${JSON.stringify([name])}\n`);
  const hadPlugin = await moveIfPresent(live.plugin, moved.plugin);
  const hadReceipt = await moveIfPresent(live.receipt, moved.receipt);
  let version: string;
  try {
    await clearUnfinishedInstall(configRoot, [name]);
    version = installedVersion(await run(bundledAgentFarmProcess(bundle, bundledInstallArgs(name), configRoot))) ?? 'unknown';
  } catch (error) {
    // Put your copy back over whatever the failed install left; the marker stays if that fails too.
    await clearUnfinishedInstall(configRoot, [name]);
    if (hadPlugin) await fs.rename(moved.plugin, live.plugin);
    if (hadReceipt) await fs.rename(moved.receipt, live.receipt);
    await fs.rm(installingPath, { force: true });
    await fs.rm(aside, { recursive: true, force: true });
    throw error;
  }
  await fs.rm(installingPath, { force: true });
  await fs.rm(aside, { recursive: true, force: true });
  const manifestPath = path.join(configRoot, MANIFEST_FILE);
  const manifest = await fs.readFile(manifestPath, 'utf8').then((text) => decodeOptionalBoundary(JSON.parse(text), manifestSchema)).catch(() => undefined);
  if (manifest) {
    const next = { ...manifest, plugins: { ...manifest.plugins, [name]: version }, edited: (manifest.edited ?? []).filter((entry) => entry !== name) };
    await fs.writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return version;
}
