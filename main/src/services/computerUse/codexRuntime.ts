import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

const execFileAsync = promisify(execFile);

/** The files Pane needs from a ChatGPT install to start OpenAI's own computer-use launcher. */
export interface CodexRuntime {
  platform: NodeJS.Platform;
  /** ChatGPT's resources folder, which holds `cua_node` and the Codex CLI. */
  resources: string;
  /** OpenAI's signed node, which must stay the launcher's parent so the engine trusts the call chain. */
  node: string;
  nodeRepl: string;
  moduleDir: string;
  launcher: string;
  codexCli: string;
  /** macOS only: the signed service app the launcher starts through LaunchServices. */
  serviceApp?: string;
  version?: string;
}

export type CodexRuntimeLookup = { found: true; runtime: CodexRuntime } | { found: false; reason: string };

interface LocateOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Windows: finds the Store package's folder. Tests replace it. */
  windowsPackageLocation?: () => Promise<string | null>;
}

const manifestSchema = boundary.object({
  node_path: boundary.string,
  node_repl_path: boundary.string,
  node_modules: boundary.string,
  runtime_archive_version: boundary.optional(boundary.string),
});

/** Finds a usable ChatGPT install on this machine, or says why there is none. */
export async function locateCodexRuntime(options: LocateOptions = {}): Promise<CodexRuntimeLookup> {
  const platform = options.platform ?? process.platform;
  const resources = await findResources(platform, options);
  if (!resources) return { found: false, reason: 'ChatGPT is not installed.' };

  const runtimeDir = path.join(resources, 'cua_node');
  const manifest = readManifest(path.join(runtimeDir, 'manifest.json'));
  if (!manifest) return { found: false, reason: `This ChatGPT install has no computer-use runtime (${runtimeDir}).` };

  const exe = platform === 'win32' ? '.exe' : '';
  const codexCli = [path.join(resources, 'codex-cli', 'bin', `codex${exe}`), path.join(resources, `codex${exe}`)].find((file) => fs.existsSync(file));
  if (!codexCli) return { found: false, reason: 'This ChatGPT install has no Codex CLI, which its computer-use runtime needs.' };
  const moduleDir = path.join(runtimeDir, manifest.node_modules);
  const runtime: CodexRuntime = {
    platform,
    resources,
    node: path.join(runtimeDir, manifest.node_path),
    nodeRepl: path.join(runtimeDir, manifest.node_repl_path),
    moduleDir,
    launcher: path.join(moduleDir, '@oai', 'cua-repl', 'bin', 'cua-repl.mjs'),
    codexCli,
    version: manifest.runtime_archive_version,
  };
  if (platform === 'darwin') runtime.serviceApp = path.join(moduleDir, '@oai', 'sky', 'Codex Computer Use.app');

  const missing = [runtime.node, runtime.nodeRepl, runtime.launcher, runtime.serviceApp]
    .find((file) => file !== undefined && !fs.existsSync(file));
  if (missing) return { found: false, reason: `This ChatGPT install is missing part of its computer-use runtime (${missing}).` };
  return { found: true, runtime };
}

async function findResources(platform: NodeJS.Platform, options: LocateOptions): Promise<string | null> {
  const homeDir = options.homeDir ?? os.homedir();
  let candidates: string[];
  if (platform === 'darwin') {
    candidates = ['/Applications/ChatGPT.app', path.join(homeDir, 'Applications', 'ChatGPT.app')].map((app) => path.join(app, 'Contents', 'Resources'));
  } else if (platform === 'linux') {
    candidates = ['/usr/lib/chatgpt/resources'];
  } else if (platform === 'win32') {
    const location = await (options.windowsPackageLocation ?? windowsPackageLocation)();
    candidates = location ? [path.join(location, 'app', 'resources')] : [];
  } else {
    candidates = [];
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'cua_node'))) ?? null;
}

/** The desktop app is a Store package; only its registration knows where it lives. */
async function windowsPackageLocation(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation"],
      { windowsHide: true, timeout: 15_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function readManifest(file: string) {
  try {
    return decodeOptionalBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), manifestSchema) ?? null;
  } catch {
    return null;
  }
}

/** Per-connection metadata the launcher attaches to every runtime request. */
interface CodexRequestMeta {
  'x-codex-turn-metadata': { session_id: string; turn_id: string };
  'codex/sandbox-state-meta'?: { permissionProfile: { type: 'disabled' }; sandboxCwd: string };
}

/**
 * The environment OpenAI's launcher expects from its own host app. Pane names a turn per engine
 * so the runtime can tie its approvals and cleanup to one connection.
 */
export function codexLaunchEnv(runtime: CodexRuntime, base: NodeJS.ProcessEnv, sessionId: string): NodeJS.ProcessEnv {
  const separator = runtime.platform === 'win32' ? ';' : ':';
  const codexHome = base.CODEX_HOME ?? path.join(base.HOME ?? base.USERPROFILE ?? os.homedir(), '.codex');
  const requestMeta: CodexRequestMeta = { 'x-codex-turn-metadata': { session_id: sessionId, turn_id: `${sessionId}-turn` } };
  if (runtime.platform === 'linux') {
    // Without this the runtime sandboxes its worker with networking off, which also blocks the X11 socket.
    requestMeta['codex/sandbox-state-meta'] = { permissionProfile: { type: 'disabled' }, sandboxCwd: 'file:///' };
  }
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: [path.dirname(runtime.node), base.PATH ?? base.Path ?? ''].filter(Boolean).join(separator),
    CODEX_HOME: codexHome,
    CODEX_CLI_PATH: runtime.codexCli,
    CUA_REPL_NODE_REPL_PATH: runtime.nodeRepl,
    NODE_REPL_NODE_PATH: runtime.node,
    NODE_REPL_NODE_MODULE_DIRS: runtime.moduleDir,
    NODE_REPL_TRUSTED_CODE_PATHS: [codexHome, runtime.moduleDir, path.join(runtime.resources, 'plugins')].join(separator),
    CUA_REPL_ENABLED_SURFACES: 'computer',
    CUA_REPL_BROWSER_ENV: 'codex-app',
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
    NODE_REPL_DISABLE_ANALYTICS: '1',
    BROWSER_USE_DISABLE_AMBIENT_NETWORK: '1',
    NODE_REPL_REQUEST_META: JSON.stringify(requestMeta),
  };
  if (runtime.serviceApp) env.SKY_CUA_SERVICE_PATH = runtime.serviceApp;
  return env;
}
