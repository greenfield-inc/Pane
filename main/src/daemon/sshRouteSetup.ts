import http from 'http';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { decodePaneRemoteConnection, normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { upsertComputer, withRoutes, type ComputerRoute, type RemoteComputer } from '../../../shared/types/remoteComputers';
import type { ConfigManager } from '../services/configManager';
import { lastLine, sshBatchOptions, type SshRunner, type SshTunnels } from './sshRoute';

export type SshRouteStep = 'connecting' | 'checking-node' | 'installing' | 'starting' | 'linked' | 'failed';

export interface SshRouteProgress {
  host: string;
  step: SshRouteStep;
  message: string;
}

export interface SshRouteHost {
  alias: string;
  hostname?: string;
  user?: string;
}

/** The oldest Node.js major runpane runs on (its package `engines`). */
const MIN_NODE_MAJOR = 22;
const QUICK_COMMAND_TIMEOUT_MS = 30_000;
/** npx may download runpane and then the packaged Pane runtime. */
const SETUP_TIMEOUT_MS = 10 * 60_000;
const HOST_READY_TIMEOUT_MS = 60_000;

/** A host alias or user@host that every shell and ssh read as one destination, never an option. */
const SAFE_DESTINATION = /^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/u;

/** Runs `command` on `host` in its login shell, which puts node and npx on PATH. Commands are fixed text without single quotes. */
function remoteArgs(host: string, command: string): string[] {
  return [...sshBatchOptions(), host, `"$SHELL" -lc '${command}'`];
}

/** The setup command the docs give for an SSH-tunnelled host (docs/SELF_HOSTED_REMOTE_DAEMON.md). */
function setupCommand(clientLabel: string): string {
  const label = clientLabel.replace(/[^A-Za-z0-9._ -]/gu, '').trim() || 'Pane over SSH';
  return `npx --yes runpane@latest install daemon --label "${label}" --prefer-tunnel ssh`;
}

/** Hosts from the person's SSH config, with the name and user ssh resolves each to (`ssh -G`, which does not connect). */
export async function listSshRouteHosts(runner: SshRunner, aliases: string[]): Promise<SshRouteHost[]> {
  return Promise.all(aliases.map(async (alias): Promise<SshRouteHost> => {
    const result = await runner.run(['-G', alias], { timeoutMs: 5_000 });
    const host: SshRouteHost = { alias };
    if (result.code !== 0) return host;
    for (const line of result.stdout.split(/\r?\n/u)) {
      const [key, ...rest] = line.trim().split(/\s+/u);
      const value = rest.join(' ');
      if (key === 'hostname' && value) host.hostname = value;
      if (key === 'user' && value) host.user = value;
    }
    return host;
  }));
}

export interface ConnectSshRouteDependencies {
  runner: SshRunner;
  tunnels: Pick<SshTunnels, 'ensure'>;
  /** Saves the route and resolves the computer's id. */
  save: (host: string, route: ComputerRoute) => Promise<string>;
  /** What the host's paired-client list calls this computer. */
  clientLabel: string;
  onProgress: (progress: SshRouteProgress) => void;
  hostReadyTimeoutMs?: number;
}

/**
 * Starts Pane's headless host on an SSH host and saves the computer with an SSH route: checks
 * Node.js, runs `runpane install daemon --prefer-tunnel ssh` there (npx installs Pane when missing),
 * reads the pairing code it prints, and opens the tunnel to the port it reports.
 */
export async function connectSshRoute(host: string, dependencies: ConnectSshRouteDependencies): Promise<{ computerId: string }> {
  const progress = (step: SshRouteStep, message: string) => dependencies.onProgress({ host, step, message });
  try {
    if (!SAFE_DESTINATION.test(host)) {
      throw new PaneError('ERR_SSH_HOST_INVALID', `"${host}" is not an SSH host Pane can connect to, so nothing changed.`, 'Pick a host from your SSH config, or enter it as user@host.');
    }
    const { runner } = dependencies;

    progress('connecting', `Connecting to ${host}`);
    const hello = await runner.run(remoteArgs(host, 'echo pane-ssh-ok'), { timeoutMs: QUICK_COMMAND_TIMEOUT_MS });
    if (hello.code !== 0 || !hello.stdout.includes('pane-ssh-ok')) {
      const reason = hello.timedOut ? 'ssh timed out' : lastLine(hello.stderr, `ssh exited with code ${hello.code}`);
      throw new PaneError(
        'ERR_SSH_CONNECT_FAILED',
        `Pane could not connect to ${host} over SSH: ${reasonOf(reason)}. Nothing changed on ${host}.`,
        `Check that "ssh ${host}" connects in a terminal without asking for a password or host key, then try again.`,
      );
    }

    progress('checking-node', `Checking Node.js on ${host}`);
    const node = await runner.run(remoteArgs(host, 'echo pane-node:$(node --version 2>/dev/null)'), { timeoutMs: QUICK_COMMAND_TIMEOUT_MS });
    const version = /pane-node:(v?(\d+)\S*)/u.exec(node.stdout);
    if (!version) {
      throw new PaneError(
        'ERR_SSH_NO_NODE',
        `${host} has no Node.js, so Pane cannot start its host there. Nothing was installed.`,
        `Install Node.js ${MIN_NODE_MAJOR} or later on ${host} (https://nodejs.org or its package manager), then try again.`,
      );
    }
    if (Number(version[2]) < MIN_NODE_MAJOR) {
      throw new PaneError(
        'ERR_SSH_NODE_TOO_OLD',
        `${host} has Node.js ${version[1]}, and Pane needs ${MIN_NODE_MAJOR} or later. Nothing was installed.`,
        `Update Node.js on ${host} to ${MIN_NODE_MAJOR} or later, then try again.`,
      );
    }

    const command = setupCommand(dependencies.clientLabel);
    progress('starting', `Starting Pane on ${host}`);
    let installing = false;
    const setup = await runner.run(remoteArgs(host, command), {
      timeoutMs: SETUP_TIMEOUT_MS,
      onLine: (line) => {
        if (!installing && /^runpane: (resolving|downloading|installing)/u.test(line)) {
          installing = true;
          progress('installing', `Installing Pane on ${host} with npx`);
        } else if (installing && line.startsWith('runpane: starting remote setup')) {
          installing = false;
          progress('starting', `Starting Pane on ${host}`);
        }
      },
    });
    const code = /pane-remote:\/\/\S+/u.exec(setup.stdout)?.[0];
    if (setup.code !== 0 || !code) {
      const reason = setup.timedOut ? 'it did not finish in 10 minutes' : lastLine(setup.stderr || setup.stdout, `it exited with code ${setup.code}`);
      throw new PaneError(
        'ERR_SSH_HOST_SETUP_FAILED',
        `Pane could not start its host on ${host}: ${reasonOf(reason)}.`,
        `Run "${command}" on ${host} to see the full output, then try again.`,
      );
    }
    const manual = /Manual daemon command:\r?\n(.+)/u.exec(setup.stdout)?.[1]?.trim();
    if (manual) {
      throw new PaneError(
        'ERR_SSH_HOST_NOT_STARTED',
        `Pane is set up on ${host}, but its host did not start as a service there.`,
        `Run "${manual}" on ${host}, then try again.`,
      );
    }
    const payload = decodePaneRemoteConnection(code);
    const remotePort = Number(new URL(payload.baseUrl).port);

    const route: ComputerRoute = {
      id: `ssh:${host}`,
      kind: 'ssh',
      source: 'ssh',
      baseUrl: `http://127.0.0.1:${remotePort}`,
      token: payload.token,
      ssh: { host, remotePort },
    };
    const baseUrl = await dependencies.tunnels.ensure(route);
    route.baseUrl = baseUrl;
    if (!await hostAnswers(baseUrl, dependencies.hostReadyTimeoutMs ?? HOST_READY_TIMEOUT_MS)) {
      throw new PaneError(
        'ERR_SSH_HOST_NOT_ANSWERING',
        `Pane started its host on ${host}, but it did not answer through the SSH tunnel on port ${remotePort}.`,
        `Run "npx --yes runpane@latest doctor --json" on ${host} to see why, then try again.`,
      );
    }

    const computerId = await dependencies.save(host, route);
    progress('linked', `${host} is linked over SSH`);
    return { computerId };
  } catch (error) {
    progress('failed', reasonOf(error));
    throw error;
  }
}

/** True once the host answers `/health` with any HTTP status. */
async function hostAnswers(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answered = await new Promise<boolean>((resolve) => {
      const request = http.get(new URL('health', `${baseUrl}/`), { timeout: 5_000 }, (response) => {
        response.resume();
        resolve(true);
      });
      request.once('timeout', () => request.destroy());
      request.once('error', () => resolve(false));
    });
    if (answered) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Saves an SSH route onto the computer that already has a route to this host, else onto the
 * computer its identity names, else a new computer named after the host.
 */
export async function saveSshRoute(configManager: Pick<ConfigManager, 'updateConfigWith'>, host: string, route: ComputerRoute): Promise<string> {
  let computerId = '';
  await configManager.updateConfigWith((current) => {
    const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
    const saved = remote.client.computers;
    const known = saved.find((computer) => computer.routes.some((candidate) => candidate.kind === 'ssh' && candidate.ssh?.host === host));
    let computers: RemoteComputer[];
    if (known) {
      computers = saved.map((computer) => (computer === known ? { ...computer, routes: withRoutes(computer.routes, [route]) } : computer));
      computerId = known.id;
    } else {
      let id = `ssh-${host}`;
      for (let n = 2; saved.some((computer) => computer.id === id); n += 1) id = `ssh-${host}-${n}`;
      const upserted = upsertComputer(saved, { id, label: host, routes: [route] });
      computers = upserted.computers;
      computerId = upserted.id;
    }
    return { remoteDaemon: { ...remote, client: { ...remote.client, computers } } };
  });
  return computerId;
}
