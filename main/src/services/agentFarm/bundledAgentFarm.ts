import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { hashDirectory } from '../skillCacheManager';

const execFileAsync = promisify(execFile);

/** The npm package Pane ships (pinned in package.json and main/package.json). */
const AGENT_FARM_PACKAGE = '@greenfieldco/agent-farm';
/** Plugins the bundled package carries that Pane installs into its own config root; greenfield first. */
export const BUNDLED_AGENT_FARM_PLUGINS = ['greenfield', 'dcouple'] as const;
const MANIFEST_FILE = 'pane-manifest.json';

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

/** `agent-farm <args> --config-root <root>` with the bundled copy. */
export function bundledAgentFarmProcess(bundle: BundledAgentFarm, args: string[], configRoot: string, env: NodeJS.ProcessEnv = process.env, runtime: string = process.execPath): AgentFarmProcess {
  const rest = { ...env };
  delete rest.AGENT_FARM_CONFIG_ROOT;
  return { executable: runtime, args: [bundle.entry, ...args, '--config-root', configRoot], env: { ...rest, ELECTRON_RUN_AS_NODE: '1' } };
}

/** What the Profiles page shows about the bundled Agent Farm. */
export interface BundledAgentFarmStatus {
  state: 'missing' | 'installing' | 'ready' | 'failed';
  configRoot: string;
  version?: string;
  /** Installed plugin → version. */
  plugins: Record<string, string>;
  /** Why the last install failed, and what to do. */
  error?: string;
}

const manifestSchema = boundary.object({
  hash: boundary.string,
  agentFarmVersion: boundary.string,
  plugins: boundary.record(boundary.string),
});

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
 * Agent Farm writes launch telemetry under ~/.local/state/agent-farm unless its config root's
 * settings.json names another folder; Pane's copy keeps it in its own config root. Other
 * settings in the file are kept.
 */
async function keepTelemetryInPaneDir(configRoot: string): Promise<void> {
  const file = path.join(configRoot, 'settings.json');
  const directory = path.join(configRoot, 'telemetry');
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  const settings = (text === undefined ? undefined : decodeOptionalBoundary(JSON.parse(text), boundary.jsonObject)) ?? {};
  const telemetry = decodeOptionalBoundary(settings.telemetry, boundary.jsonObject) ?? {};
  if (telemetry.directory === directory) return;
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...settings, telemetry: { ...telemetry, directory } }, null, 2)}\n`);
}

/**
 * Removes what an install that never finished (killed by the timeout, a crash or a quit) left
 * behind: Agent Farm's install lock, which makes every later install refuse, and the bundled
 * plugins' half-copied files. The config root is Pane's alone, so nothing else is installing.
 */
async function clearUnfinishedInstall(configRoot: string): Promise<void> {
  await fs.rm(path.join(configRoot, '.plugins', 'install.lock'), { recursive: true, force: true });
  for (const name of BUNDLED_AGENT_FARM_PLUGINS) {
    await fs.rm(path.join(configRoot, 'plugins', name), { recursive: true, force: true });
    await fs.rm(path.join(configRoot, '.plugins', `${name}.json`), { force: true });
  }
}

export interface InstallBundledAgentFarmOptions {
  paneDir: string;
  bundle?: BundledAgentFarm;
  run?: AgentFarmRunner;
  log?: (message: string) => void;
}

/**
 * Installs greenfield and the other bundled plugins into `<PANE_DIR>/agent-farm` with the
 * bundled Agent Farm, when the bundle (its version and plugin files) differs from what the
 * manifest there records; an unchanged bundle installs nothing. Called at startup without
 * waiting. Never throws: a failure is logged and returned in the status, for the Profiles page.
 */
let lastStatus: BundledAgentFarmStatus | undefined;

/** The bundled Agent Farm's state since this start; undefined before the installer first ran. */
export function bundledAgentFarmStatus(): BundledAgentFarmStatus | undefined {
  return lastStatus;
}

export async function installBundledAgentFarm(options: InstallBundledAgentFarmOptions): Promise<BundledAgentFarmStatus> {
  const status = await installOnce(options);
  lastStatus = status;
  return status;
}

async function installOnce(options: InstallBundledAgentFarmOptions): Promise<BundledAgentFarmStatus> {
  let status: BundledAgentFarmStatus;
  const log = options.log ?? ((message: string) => console.log(message));
  const configRoot = agentFarmConfigRoot(options.paneDir);
  const bundle = options.bundle ?? bundledAgentFarm();
  if (!bundle) {
    status = { state: 'missing', configRoot, plugins: {}, error: `This Pane build does not include ${AGENT_FARM_PACKAGE}, so bundled profiles can't be set up. Reinstall Pane from runpane.com.` };
    log(`[AgentFarm] ${status.error}`);
    return status;
  }
  try {
    await keepTelemetryInPaneDir(configRoot);
  } catch (error) {
    log(`[AgentFarm] Pane couldn't point Agent Farm's telemetry at ${configRoot}: ${reasonOf(error)}.`);
  }
  const manifestPath = path.join(configRoot, MANIFEST_FILE);
  let hash: string;
  try {
    hash = `${bundle.version}:${await hashDirectory(path.join(bundle.root, 'plugins'))}`;
  } catch (error) {
    status = { state: 'failed', configRoot, version: bundle.version, plugins: {}, error: `Pane couldn't read the bundled Agent Farm's plugins: ${reasonOf(error)}. Reinstall Pane from runpane.com.` };
    log(`[AgentFarm] ${status.error}`);
    return status;
  }
  const previous = await fs.readFile(manifestPath, 'utf8').then((text) => decodeOptionalBoundary(JSON.parse(text), manifestSchema)).catch(() => undefined);
  const installed = previous && BUNDLED_AGENT_FARM_PLUGINS.every((name) => existsSync(path.join(configRoot, 'plugins', name)));
  if (previous && installed && previous.hash === hash) {
    status = { state: 'ready', configRoot, version: bundle.version, plugins: previous.plugins };
    log(`[AgentFarm] Bundled Agent Farm ${bundle.version} is already set up in ${configRoot} (manifest hash unchanged); nothing reinstalled.`);
    return status;
  }
  status = { state: 'installing', configRoot, version: bundle.version, plugins: {} };
  lastStatus = status;
  log(`[AgentFarm] Setting up bundled Agent Farm ${bundle.version} in ${configRoot} (${previous ? `bundle changed from ${previous.agentFarmVersion}` : 'first start'}).`);
  const run = options.run ?? runAgentFarm;
  const plugins: Record<string, string> = {};
  try {
    await fs.mkdir(configRoot, { recursive: true });
    await clearUnfinishedInstall(configRoot);
    for (const name of BUNDLED_AGENT_FARM_PLUGINS) {
      // No name installs the package's default plugin, greenfield.
      const args = name === 'greenfield' ? ['plugin', 'install'] : ['plugin', 'install', name];
      const stdout = await run(bundledAgentFarmProcess(bundle, args, configRoot));
      plugins[name] = installedVersion(stdout) ?? 'unknown';
    }
    await fs.writeFile(manifestPath, `${JSON.stringify({ hash, agentFarmVersion: bundle.version, plugins }, null, 2)}\n`);
  } catch (error) {
    const reason = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1) || reasonOf(error);
    status = { state: 'failed', configRoot, version: bundle.version, plugins, error: `Pane couldn't set up its bundled Agent Farm in ${configRoot}: ${reason}. Bundled profiles may be out of date; restart Pane to try again.` };
    log(`[AgentFarm] ${status.error}`);
    return status;
  }
  status = { state: 'ready', configRoot, version: bundle.version, plugins };
  log(`[AgentFarm] Bundled Agent Farm ${bundle.version} set up: ${Object.entries(plugins).map(([name, version]) => `${name} ${version}`).join(', ')}.`);
  return status;
}
