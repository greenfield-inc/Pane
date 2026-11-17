import { execFile, spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { besideItsNode, hostCommand } from '../agentChat/hostCommand';
import { addDeviceHubPort, removeDeviceHubPort } from './deviceHubPorts';

const execFileAsync = promisify(execFile);

/**
 * The two open-source helpers Pane installs on first use: Callstack's agent-device drives the
 * device for agents, and Expo's device hub boots devices and streams their screen. Exact versions
 * (T3 Code ships this pair); a new pin is a new folder, so an update never mixes versions.
 */
const DEVICE_HELPER_PINS = { agentDevice: '0.21.36', hub: '0.22.1' } as const;
/** Every dependency resolves as it was just after the newer pin's release, so first use installs the tree Pane was tested with. */
const RESOLVED_BEFORE = '2026-11-11T00:00:00Z';

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const HUB_START_TIMEOUT_MS = 60_000;

export interface DeviceHelperPaths {
  agentDevice: string;
  hub: string;
}

/** How Pane runs a Node script: its own binary as Node, so the person's Node version never matters. */
export interface NodeRunner {
  executable: string;
  env: NodeJS.ProcessEnv;
}

export function paneNode(): NodeRunner {
  return { executable: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

const recordSchema = boundary.object({ agentDevice: boundary.string, hub: boundary.string });
const execFailureSchema = boundary.object({ code: boundary.optional(boundary.number), stdout: boundary.optional(boundary.string), stderr: boundary.optional(boundary.string) });

/** Installs the pinned helpers into `<root>/helpers/<pins>` with the person's npm, once. */
export class DeviceHelpers {
  private installing?: Promise<DeviceHelperPaths>;

  constructor(private readonly options: {
    root: string;
    findExecutable: (name: string) => string | null;
    machineName: () => string;
    platform?: NodeJS.Platform;
  }) {}

  get folder(): string {
    return path.join(this.options.root, 'helpers', `agent-device-${DEVICE_HELPER_PINS.agentDevice}_hub-${DEVICE_HELPER_PINS.hub}`);
  }

  /** The installed helpers, or undefined before the first install finishes. */
  installed(): DeviceHelperPaths | undefined {
    const record = path.join(this.folder, 'installed.json');
    if (!existsSync(record)) return undefined;
    try {
      return decodeBoundary(JSON.parse(readFileSync(record, 'utf8')), recordSchema);
    } catch {
      return undefined;
    }
  }

  /** Installs on first use; `onInstall` runs only when an install actually starts. */
  ensure(onInstall?: () => void): Promise<DeviceHelperPaths> {
    const ready = this.installed();
    if (ready) return Promise.resolve(ready);
    this.installing ??= this.install(onInstall).finally(() => { this.installing = undefined; });
    return this.installing;
  }

  private async install(onInstall?: () => void): Promise<DeviceHelperPaths> {
    const npm = this.options.findExecutable('npm');
    if (!npm) {
      throw new PaneError(
        'ERR_DEVICE_NEEDS_NPM',
        `Pane installs its device tools with npm on first use, and ${this.options.machineName()} has no npm on its PATH. Nothing was installed.`,
        'Install Node.js (it includes npm) from https://nodejs.org, then try again.',
      );
    }
    onInstall?.();
    const folder = this.folder;
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const install = hostCommand(npm, ['install', '--prefix', folder, '--no-audit', '--no-fund', `--before=${RESOLVED_BEFORE}`,
      `agent-device@${DEVICE_HELPER_PINS.agentDevice}`, `expo-device-hub@${DEVICE_HELPER_PINS.hub}`], this.options.platform);
    try {
      await execFileAsync(install.executable, install.args, { env: besideItsNode(npm), timeout: INSTALL_TIMEOUT_MS, windowsVerbatimArguments: install.windowsVerbatimArguments, maxBuffer: 16 * 1024 * 1024 });
    } catch (cause) {
      rmSync(folder, { recursive: true, force: true });
      throw new PaneError('ERR_DEVICE_INSTALL_FAILED', `npm could not install Pane's device tools on ${this.options.machineName()}: ${reasonOf(cause)}. Nothing was installed.`, 'Check the network connection and that `npm install` works in a terminal, then try again.');
    }
    const paths: DeviceHelperPaths = {
      agentDevice: path.join(folder, 'node_modules', 'agent-device', 'bin', 'agent-device.mjs'),
      hub: path.join(folder, 'node_modules', 'expo-device-hub', 'dist', 'server', 'cli.mjs'),
    };
    for (const script of Object.values(paths)) {
      if (!existsSync(script)) throw new PaneError('ERR_DEVICE_INSTALL_FAILED', `The device tools installed without ${path.basename(script)}, so Pane cannot run them.`, 'Try again; if it repeats, report it with `runpane doctor --json`.');
    }
    // Written last: a folder without it is an unfinished install.
    writeFileSync(path.join(folder, 'installed.json'), JSON.stringify(paths));
    return paths;
  }
}

/** The body of the hub's boot, shutdown, remove and create routes. */
type HubDeviceAction =
  | { platform: 'ios' | 'android'; id: string; name: string }
  | { platform: 'ios' | 'android'; name: string; runtime: string; deviceType: string };

/** A body for serve-emu's REST routes: a selected serial, a tap or swipe, a key, or nothing. */
type EmulatorBody = { serial: string } | { x: number; y: number } | { x1: number; y1: number; x2: number; y2: number } | { key: 'home' | 'back' } | Record<string, never>;

/** The running device hub: loopback only, token required. The token never leaves this module's callers. */
export interface RunningHub {
  port: number;
  token: string;
  pid: number | undefined;
  /** A request to the hub with its token: a GET, or a POST of a device action. */
  request(pathname: string, body?: HubDeviceAction): Promise<Response>;
  /** A JSON POST to one of the hub's vendored device servers (serve-emu). */
  post(pathname: string, body: EmulatorBody): Promise<Response>;
  stop(): Promise<void>;
}

const READY_LINE = /Local:\s+http:\/\/localhost:(\d+)\/\?token=([A-Za-z0-9._~-]+)/;

/**
 * Starts the hub on loopback with `--require-token`, and reads its port and token from its
 * startup line. Its output is never logged: the startup line carries the token.
 */
export function startHub(script: string, options: { node: NodeRunner; env: NodeJS.ProcessEnv; onExit?: () => void }): Promise<RunningHub> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(options.node.executable, [script, '--require-token', '--host', '127.0.0.1', '--stream-source', 'scrcpy', '--hide-sidebar'], {
      env: { ...process.env, ...options.env, ...options.node.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error('it did not start within a minute')), HUB_START_TIMEOUT_MS);
    function fail(cause: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new PaneError('ERR_DEVICE_HUB_FAILED', `Pane's device hub did not start: ${reasonOf(cause)}.`, 'Try again. If it repeats, quit other simulator tools and retry.'));
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (settled) return;
      output += chunk;
      const match = READY_LINE.exec(output);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      output = '';
      const port = Number(match[1]);
      const token = match[2];
      addDeviceHubPort(port);
      child.once('exit', () => removeDeviceHubPort(port));
      const base = `http://127.0.0.1:${port}`;
      resolve({
        port,
        token,
        pid: child.pid,
        request: (pathname, body) => fetch(`${base}${pathname}`, body === undefined
          ? { headers: { Authorization: `Bearer ${token}` } }
          : { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        post: (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        stop: () => new Promise<void>((done) => {
          if (child.exitCode !== null) return done();
          child.once('exit', () => done());
          child.kill('SIGTERM');
          setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 15_000).unref();
        }),
      });
    });
    // Drain stderr so the hub never blocks on a full pipe; it can hold device names, not the token.
    child.stderr?.resume();
    child.once('error', fail);
    child.once('exit', (code) => {
      if (!settled) fail(new Error(`it exited with code ${code}`));
      options.onExit?.();
    });
  });
}

/** The flags that would point agent-device at another device, session or daemon. */
const RETARGET_FLAGS = ['--session', '--device', '--udid', '--serial', '--platform', '--target', '--state-dir', '--daemon-base-url', '--daemon-auth-token', '--daemon-transport', '--daemon-server-mode', '--tenant', '--run-id', '--lease-id', '--config', '--remote-config', '--ios-simulator-device-set', '--android-device-allowlist', '--session-isolation'];
/** Flag families that reach a remote daemon, a provider or a proxy instead of the leased device. */
const RETARGET_FLAG_PATTERN = /^--(?:.*-)?(?:daemon|remote|provider|proxy|tenant|lease|session)(?:-|$)/;
/**
 * Commands that act on the daemon and sessions every Pane shares, or on connections, rather than
 * the leased device. `batch` steps can carry their own target, so steps run as separate calls.
 */
const SHARED_COMMANDS = new Set(['daemon', 'session', 'connect', 'connection', 'disconnect', 'proxy', 'mcp', 'auth', 'plugins', 'artifacts', 'device', 'takeover', 'batch']);

/** Refuses agent-device arguments that would retarget it away from the leased device. */
export function refuseRetarget(args: readonly string[]): void {
  const command = args.find(arg => !arg.startsWith('-'));
  if (command && SHARED_COMMANDS.has(command)) {
    throw new PaneError(
      'ERR_DEVICE_ACT_COMMAND',
      `device_act refused \`${command}\`: it acts on agent-device's shared daemon, sessions or connections, which every Pane uses, not on this Pane's device. Nothing ran.`,
      command === 'batch' ? 'Run each step as its own device_act call.' : 'Use device_act for commands on this Pane\'s device, such as open, snapshot -i and press.',
    );
  }
  for (const arg of args) {
    const flag = arg.split('=')[0];
    if (RETARGET_FLAGS.includes(flag) || RETARGET_FLAG_PATTERN.test(flag)) {
      throw new PaneError(
        'ERR_DEVICE_ACT_FLAG',
        `device_act refused ${flag}: Pane points agent-device at the device this Pane holds, so flags that pick another device, session or daemon are not allowed. Nothing ran.`,
        `Run the same command without ${flag}.`,
      );
    }
  }
}

export interface AgentDeviceTarget {
  session: string;
  platform: 'ios' | 'android';
  /** The simulator UDID or emulator serial. */
  id: string;
}

/** Runs one agent-device command against one device, with its state in Pane's folder. */
export async function runAgentDevice(
  script: string,
  args: readonly string[],
  target: AgentDeviceTarget,
  options: { node: NodeRunner; stateDir: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const selector = target.platform === 'ios' ? ['--udid', target.id] : ['--serial', target.id];
  const argv = [script, ...args, '--session', target.session, '--platform', target.platform, ...selector];
  try {
    const { stdout, stderr } = await execFileAsync(options.node.executable, argv, {
      env: { ...process.env, ...options.env, ...options.node.env, AGENT_DEVICE_STATE_DIR: options.stateDir, AGENT_DEVICE_CLAIMS_DIR: path.join(options.stateDir, 'claims') },
      timeout: options.timeoutMs ?? 5 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      cwd: options.cwd,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    // execFile's rejection carries the child's exit code and output.
    const failure = decodeOptionalBoundary(cause, execFailureSchema);
    return { code: failure?.code ?? 1, stdout: failure?.stdout ?? '', stderr: failure?.stderr ?? reasonOf(cause) };
  }
}
