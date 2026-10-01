import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../boundaryDecoder';
import { RemoteDaemonClient } from '../remote/remoteDaemonClient';
import { getWrapperVersion } from '../version';
import { createBoatProvider } from './boat';
import { cloudHostname, joinSandboxToTailnet, provisionSandbox, repairServeAndGuards, repairTailnetIfLoggedOut, waitForDaemonHealth } from './bootstrap';
import { runCoordinatorCommand } from './coordinator';
import type { CloudDeps, CloudSafeToStopAnswer } from './commands';
import { callCoordinator, readClientConfig } from './coordinator/client';
import { NO_COORDINATOR, type CoordinatorPushResult } from './coordinatorSync';
import { defaultDesktopDir } from './desktop';
import { createGitHubPort } from './githubApi';
import type { BootstrapPort } from './ports';
import { createCloudStore } from './store';
import { createTailscaleApi } from './tailscale';

/** The real dependencies behind `runpane cloud`: boat REST, bootstrap, the Tailscale API, local files. */
export function createDefaultCloudDeps(env: NodeJS.ProcessEnv = process.env): CloudDeps {
  const store = createCloudStore();
  const bootstrap: BootstrapPort = {
    cloudHostname,
    createTailnet: (credentials) => createTailscaleApi(credentials),
    waitForDaemonHealth: (baseUrl, options) => waitForDaemonHealth(baseUrl, options),
    async joinTailnet(sandbox, request, tailnet) {
      const node = await joinSandboxToTailnet(sandbox, {
        sessionId: request.sessionId,
        hostname: request.hostname,
        tailscale: createTailscaleApi(tailnet),
        tailnetTcpPorts: request.tailnetTcpPorts,
        onStep: (step) => {
          if (step.state === 'done') request.onStep?.(`${step.step} done${step.detail ? `: ${step.detail}` : ''}`);
        },
      });
      return { nodeId: node.nodeId, magicDnsName: node.magicDnsName, tailscaleIps: node.tailscaleIps };
    },
    repairServe: (sandbox, request) => repairServeAndGuards(sandbox, request),
    async repairTailnet(sandbox, request, tailnet) {
      const result = await repairTailnetIfLoggedOut(sandbox, { ...request, tailscale: createTailscaleApi(tailnet) });
      return result.reenrolled
        ? { reenrolled: true, previousBackendState: result.previousBackendState, nodeId: result.nodeId, magicDnsName: result.magicDnsName, deletedNodeIds: result.deletedNodeIds }
        : result;
    },
    async provision(sandbox, request, tailnet) {
      const result = await provisionSandbox(sandbox, {
        sessionId: request.sessionId,
        label: request.label,
        hostname: request.hostname,
        tailscale: createTailscaleApi(tailnet),
        paneSource: request.paneSource,
        repo: request.repo,
        transport: request.transport,
        pairingOutputPath: request.pairingOutputPath,
        extraClients: request.extraClients,
        healthTimeoutMs: request.healthTimeoutMs,
        onStep: (step) => {
          if (step.state === 'done') {
            request.onStep?.(`${step.step} done${step.elapsedMs !== undefined ? ` (${(step.elapsedMs / 1000).toFixed(1)} s)` : ''}${step.detail ? `: ${step.detail}` : ''}`);
          }
        },
      });
      return {
        hostname: result.hostname,
        magicDnsName: result.magicDnsName,
        nodeId: result.nodeId,
        baseUrl: result.baseUrl,
        transport: result.transport,
        pairingPath: result.pairingPath,
        daemonVersion: result.daemonVersion,
        timings: result.timings,
      };
    },
  };

  return {
    store,
    createProvider: (credentials, org) => {
      if (!credentials.boat) throw new Error('No boat API key saved. Run: runpane cloud setup --boat-key-file <path|->');
      return createBoatProvider({ apiKey: credentials.boat.apiKey, org });
    },
    bootstrap,
    readSecretFile,
    stdout: (line) => writeLine(process.stdout, line),
    stderr: (line) => writeLine(process.stderr, line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env,
    defaultDesktopDir: defaultDesktopDir(env),
    runCoordinator: (argv) => runCoordinatorCommand(argv),
    pushCoordinatorDirectory: (directory) => pushToCoordinator(store.coordinatorClientPath, directory),
    wakeViaCoordinator: (sessionId, timeoutMs) => wakeViaCoordinator(store.coordinatorClientPath, sessionId, timeoutMs),
    packCoordinatorApp,
    async callCoordinatorApi(method, pathAndQuery, body, timeoutMs) {
      const client = readClientConfig(store.coordinatorClientPath);
      if (!client) throw new Error('No coordinator client is configured: run runpane cloud coordinator deploy --yes.');
      return callCoordinator(client, method, pathAndQuery, body, timeoutMs);
    },
    probeCoordinatorHealth,
    async invokeDaemon(profile, channel, args, timeoutMs) {
      const client = new RemoteDaemonClient({ profile, runtimeId: 'runpane-cloud', clientLabel: 'runpane cloud' });
      return client.invoke(channel, args, { timeoutMs });
    },
    safeToStop: (profile) => askSafeToStop(profile),
    runLocal,
    github: createGitHubPort(readSecretFile),
  };
}

/**
 * PUT /cloud/directory on the coordinator named by `<cloud dir>/coordinator.json` ({baseUrl, token},
 * written by `runpane cloud coordinator mint-token --client-config`). No file means no coordinator.
 */
async function pushToCoordinator(clientConfigPath: string, directory: JsonObject): Promise<CoordinatorPushResult> {
  const client = readClientConfig(clientConfigPath);
  if (!client) return { pushed: false, reason: NO_COORDINATOR };
  const result = await callCoordinator(client, 'PUT', '/cloud/directory', directory, 60_000);
  if (result.status < 200 || result.status >= 300) {
    return { pushed: false, reason: `coordinator answered HTTP ${result.status}` };
  }
  const sessions = directory.sessions;
  return { pushed: true, sessions: Array.isArray(sessions) ? sessions.length : 0 };
}

const safeToStopAnswerSchema = boundary.object({
  safe: boundary.boolean,
  blockers: boundary.array(boundary.object({ condition: boundary.string, message: boundary.string })),
  // `durable`: every flush step succeeded. Daemons from before it never confirm, and get the plain sync.
  flush: boundary.nullable(boundary.object({ durable: boundary.optional(boundary.boolean) })),
});

export function decodeCloudStopSafeToStop(value: JsonValue | undefined): CloudSafeToStopAnswer {
  const result = decodeBoundary(value, safeToStopAnswerSchema);
  return {
    safe: result.safe,
    blockers: result.blockers.map((blocker) => ({ condition: blocker.condition, message: blocker.message })),
    flushed: result.flush?.durable === true,
  };
}

/** `runpane:cloud:safe-to-stop {flush: "always"}` over the host's paired token, for `cloud stop`. */
async function askSafeToStop(profile: { baseUrl: string; token: string }): Promise<CloudSafeToStopAnswer> {
  const client = new RemoteDaemonClient({
    profile: { id: 'runpane-cloud-stop', label: 'runpane cloud stop', baseUrl: profile.baseUrl, token: profile.token },
    runtimeId: 'runpane-cloud-stop',
    clientLabel: 'runpane cloud',
  });
  return decodeCloudStopSafeToStop(
    await client.invoke('runpane:cloud:safe-to-stop', [{ flush: 'always' }], { timeoutMs: 60_000 }),
  );
}

/** Reads a secret from a file, or from stdin for "-". Secrets never come from argv (visible in `ps`). */
async function readSecretFile(filePath: string): Promise<string> {
  if (filePath !== '-') return fs.readFile(filePath, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

const execFileAsync = promisify(execFile);

/** Runs a local program without a shell and collects its output; a non-zero exit resolves with its code. */
function runLocal(file: string, args: readonly string[], timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

/**
 * This CLI's package root (dist/cloud/wiring.js -> ../..), packed without maps and type declarations.
 * The coordinator is a zero-dependency service inside this same package, so the deployed
 * coordinator always matches the CLI that deployed it.
 */
async function packCoordinatorApp(): Promise<{ archiveBase64: string; version: string }> {
  const root = path.resolve(__dirname, '..', '..');
  await fs.access(path.join(root, 'dist', 'cloud', 'coordinator', 'main.js'));
  const { stdout } = await execFileAsync('tar', [
    '-czf', '-', '--exclude=*.map', '--exclude=*.d.ts', '-C', root, 'dist', 'package.json',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return { archiveBase64: stdout.toString('base64'), version: getWrapperVersion() };
}

const coordinatorHealthSchema = boundary.object({ ok: boundary.boolean, version: boundary.optional(boundary.string) });

async function probeCoordinatorHealth(baseUrl: string): Promise<{ ok: boolean; status?: number; version?: string }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ok: false, status: response.status };
    const body = decodeBoundary(await response.json(), coordinatorHealthSchema);
    return { ok: body.ok, status: response.status, version: body.version };
  } catch {
    return { ok: false };
  }
}

/** A reader that closed early (`runpane cloud list | head -1`) must not crash the command mid-change. */
function writeLine(stream: NodeJS.WriteStream, line: string): void {
  if (stream.listenerCount('error') === 0) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') throw error;
    });
  }
  stream.write(`${line}\n`);
}

const coordinatorWakeSchema = boundary.object({
  status: boundary.optional(boundary.string),
  code: boundary.optional(boundary.string),
  version: boundary.optional(boundary.nullable(boundary.string)),
  detail: boundary.optional(boundary.nullable(boundary.string)),
  message: boundary.optional(boundary.string),
});

async function wakeViaCoordinator(clientConfigPath: string, sessionId: string, timeoutMs: number) {
  try {
    const client = readClientConfig(clientConfigPath);
    if (!client) return null;
    const result = await callCoordinator(client, 'POST', '/cloud/wake', { host: sessionId, wait: true, timeoutMs }, timeoutMs + 30_000);
    const body = decodeBoundary(result.body, coordinatorWakeSchema);
    return { status: body.status ?? body.code ?? `HTTP ${result.status}`, version: body.version ?? null, detail: body.detail ?? body.message ?? null };
  } catch {
    return null;
  }
}
