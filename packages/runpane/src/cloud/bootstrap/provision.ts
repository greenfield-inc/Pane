import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { boundary, decodeBoundary, type BoundarySchema, type JsonObject } from '../../boundaryDecoder';
import { RemoteDaemonClient, type RemoteHttpTransport } from '../../remote/remoteDaemonClient';
import { decodePairingCode, encodePairingCode } from '../pairing';
import type { PinnedPane } from '../store';
import { CLOUD_SESSION_TAG, deletableNodeIds, describeForeignDevice, type TailscaleApi, type TailscaleDevice } from '../tailscale';
import { cloudBootstrapAssets, type CloudBootstrapAssetName } from './generated/assets';
import { waitForDaemonHealth } from './health';
import type {
  DaemonHealthResult,
  PaneSource,
  ProvisionStep,
  ProvisionStepName,
  SandboxHandle,
  TailnetIdentity,
} from './types';

const DEFAULT_SANDBOX_HOME = '/home/user';
const UPLOADED_ASSETS: CloudBootstrapAssetName[] = ['rp-bootstrap.sh', 'golden-scrub.sh', 'golden-check.sh'];
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PAIRING_PATTERN = /pane-remote:\/\/\S+/g;

interface ProvisionOptions {
  sessionId: string;
  label: string;
  tailscale: TailscaleApi;
  paneSource: PaneSource;
  /** Tailnet hostname; defaults to cloudHostname(sessionId). Used verbatim. */
  hostname?: string;
  repo?: { url: string; ref?: string; dir?: string };
  /** Local path that receives the pane-remote:// code with mode 0600. The code is never printed. */
  pairingOutputPath: string;
  /**
   * Further paired clients (e.g. label "runpane-cloud-coordinator"); each client's pane-remote:// code
   * is written to its local outputPath with mode 0600. `scope: 'coordinator'` pairs a client that may
   * only call runpane:cloud:* channels (needs a Pane daemon that knows `--client-scope`).
   */
  extraClients?: { label: string; outputPath: string; scope?: 'coordinator' }[];
  tags?: string[];
  /**
   * TCP ports other tailnet nodes may open on this sandbox (default [443], Tailscale Serve in front of
   * the daemon). The tailnet policy lets rp-session nodes reach each other on every port; the host
   * firewall narrows that. A coordinator box adds its API port.
   */
  tailnetTcpPorts?: number[];
  /**
   * How clients reach the daemon. `https` (Tailscale Serve with a Let's Encrypt certificate) is the
   * default; `http` serves plain TCP inside the tailnet (WireGuard encrypts it; the phone PWA can't use
   * it). `auto` (default) tries HTTPS and switches to `http` when Let's Encrypt refuses the certificate:
   * it issues at most 50 per week for the tailnet's domain and every new node name needs one.
   */
  transport?: CloudTransportMode;
  /** auto: how long HTTPS gets before the certificate is checked (default 45 s). */
  autoHttpsWaitMs?: number;
  healthTimeoutMs?: number;
  sandboxHome?: string;
  fetchImpl?: typeof fetch;
  /** HTTP transport for the paired /invoke call that registers the repo; tests pass a fake. */
  remoteTransport?: RemoteHttpTransport;
  onStep?: (step: ProvisionStep) => void;
}

type CloudTransportMode = 'auto' | 'https' | 'http';

interface ProvisionResult extends TailnetIdentity {
  baseUrl: string;
  /** What `auto` settled on. */
  transport: 'https' | 'http';
  pairingPath: string;
  extraClientPaths: string[];
  daemonVersion?: string;
  health: DaemonHealthResult;
  identityReset: boolean;
  deletedStaleNodeIds: string[];
  repoDir?: string;
  timings: Partial<Record<ProvisionStepName, number>>;
}

interface ReenrolOptions {
  hostname: string;
  tailscale: TailscaleApi;
  /**
   * The node id recorded at provision time. Devices under the same hostname tagged like this node are
   * deleted too; any other device under it stops the re-enrol before the node state is wiped.
   */
  oldNodeId?: string;
  tags?: string[];
  /** Re-point Tailscale Serve at the daemon (its config lives in the wiped node state). Default true. */
  restoreServe?: boolean;
  sandboxHome?: string;
}

interface ReenrolResult extends TailnetIdentity {
  deletedNodeIds: string[];
  elapsedMs: number;
}

/** Failures carry the step name; messages are redacted. Callers match on `name === 'BootstrapError'`. */
class BootstrapError extends Error {
  constructor(readonly step: string, message: string) {
    super(`cloud bootstrap step "${step}" failed: ${message}`);
    this.name = 'BootstrapError';
  }
}

/** `rp-` plus the first 8 lowercase alphanumerics of the session id. */
export function cloudHostname(sessionId: string, prefix = 'rp'): string {
  const short = sessionId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  if (short.length < 4) {
    throw new Error(`Session id "${sessionId}" has too few alphanumerics for a hostname`);
  }
  return assertHostname(`${prefix}-${short}`);
}

/**
 * The sandbox installs a Pane .deb it downloads with curl, as root: only an https:// URL is accepted (the
 * download also refuses redirects to anything else), so nothing between the sandbox and the server can swap it.
 */
export function assertHttpsArtifactUrl(url: string, what: string): void {
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    // reported below
  }
  if (protocol !== 'https:') throw new Error(`${what} must be an https:// URL${protocol ? ` (got ${protocol}//)` : ''}.`);
}

/**
 * Provisions one cloud sandbox for a Pane Session: identity reset, strip-list check, tailnet join
 * with a single-use tagged key (never Tailscale SSH), Pane daemon install, pairing capture to a
 * local 0600 file, optional repo clone, and a /health wait over the tailnet. Safe to re-run for
 * the same session: finished steps are detected and skipped.
 */
export async function provisionSandbox(sandbox: SandboxHandle, options: ProvisionOptions): Promise<ProvisionResult> {
  if (options.paneSource.kind === 'deb-url') assertHttpsArtifactUrl(options.paneSource.url, 'The Pane .deb URL');
  const home = options.sandboxHome ?? DEFAULT_SANDBOX_HOME;
  const hostname = assertHostname(options.hostname ?? cloudHostname(options.sessionId));
  const tags = options.tags ?? [CLOUD_SESSION_TAG];
  const timings: Partial<Record<ProvisionStepName, number>> = {};
  const step = async <T>(name: ProvisionStepName, run: () => Promise<T>, detail?: (value: T) => string): Promise<T> => {
    options.onStep?.({ step: name, state: 'start' });
    const started = Date.now();
    const value = await run();
    timings[name] = Date.now() - started;
    options.onStep?.({ step: name, state: 'done', elapsedMs: timings[name], detail: detail?.(value) });
    return value;
  };
  const runner = new StepRunner(sandbox, home);
  const { identity, tailnet, deletedStaleNodeIds } = await prepareAndJoin(sandbox, runner, options, hostname, tags, home, step,
    options.tailnetTcpPorts ?? [443]);

  const runpaneSpec = options.paneSource.kind === 'runpane-npm' ? options.paneSource.spec : '';
  const install = await step('install-pane', () => runner.run('install-pane', [
    options.paneSource.kind,
    options.paneSource.kind === 'deb-url' ? options.paneSource.url : '',
    options.paneSource.kind === 'deb-url' ? options.paneSource.sha256 ?? '' : '',
    runpaneSpec,
    options.label,
  ], installStepSchema, { timeoutSeconds: 600 }), (value) => value.version ?? 'installed');

  let pairingCode = await step('pairing', async () => {
    const pairing = await runner.run('pairing-read', [], pairingStepSchema);
    const code = requirePairingCode(pairing.code);
    writeSecretFile(options.pairingOutputPath, code);
    return code;
  });

  const extraClientPaths: string[] = [];
  if (options.extraClients && options.extraClients.length > 0) {
    await step('extra-clients', async () => {
      for (const client of options.extraClients ?? []) {
        const slug = clientSlug(client.label);
        await runner.run('add-client', [slug, client.label, client.scope ?? ''], envelopeSchema, { timeoutSeconds: 180 });
        const pairing = await runner.run('pairing-read', [slug], pairingStepSchema);
        writeSecretFile(client.outputPath, requirePairingCode(pairing.code));
        extraClientPaths.push(client.outputPath);
      }
    });
  }

  let repoDir: string | undefined;
  const repoName = options.repo ? repoNameFromUrl(options.repo.url) : undefined;
  if (options.repo) {
    const repo = options.repo;
    const dir = repo.dir ?? path.posix.join(home, repoNameFromUrl(repo.url));
    await step('clone', () => runner.run('clone', [repo.url, repo.ref ?? '', dir], cloneStepSchema, { timeoutSeconds: 600 }),
      (value) => String(value.head ?? ''));
    repoDir = dir;
  }

  const transportMode = options.transport ?? 'auto';
  const healthTimeoutMs = options.healthTimeoutMs ?? 120_000;
  let baseUrl = `https://${tailnet.magicDnsName}`;
  let transport: 'https' | 'http' = 'https';
  const requireHealthy = async (result: DaemonHealthResult): Promise<DaemonHealthResult> => {
    if (result.ok) return result;
    const local = await runner.run('health-local', [], envelopeSchema, { allowFailure: true });
    throw new BootstrapError('health', `${baseUrl}/health not ready after ${result.elapsedMs} ms `
      + `(last HTTP ${result.status ?? 'none'}; in-sandbox loopback check ${local.ok ? 'ok' : 'failed'})`);
  };
  const waitHealth = (timeoutMs: number) => waitForDaemonHealth(baseUrl,
    { timeoutMs, fetchImpl: options.fetchImpl, token: decodePairingCode(pairingCode).token });

  let health: DaemonHealthResult | undefined;
  if (transportMode !== 'http') {
    const firstWaitMs = transportMode === 'auto' ? Math.min(options.autoHttpsWaitMs ?? AUTO_HTTPS_WAIT_MS, healthTimeoutMs) : healthTimeoutMs;
    const first = await waitHealth(firstWaitMs);
    if (first.ok || transportMode === 'https') {
      health = await step('health', () => requireHealthy(first), (value) => `${value.elapsedMs} ms`);
    } else {
      const cert = await step('cert-check', () => runner.run('cert-status', [tailnet.magicDnsName], certStatusStepSchema, { timeoutSeconds: 60 }),
        (value) => (value.rateLimited ? `Let's Encrypt rate limit: ${value.detail ?? 'refused'}` : 'no rate limit in tailscaled\'s log'));
      // Without a logged refusal, HTTPS gets one more window (a first certificate can take ~30 s).
      const second = cert.rateLimited ? undefined : await waitHealth(Math.max(Math.min(healthTimeoutMs - first.elapsedMs, firstWaitMs), 1_000));
      if (second?.ok) {
        health = await step('health', () => requireHealthy(second), (value) => `${value.elapsedMs + first.elapsedMs} ms`);
      } else {
        // HTTPS is down. If the daemon answers on loopback, the problem is Serve's certificate: switch.
        // If it doesn't, the daemon itself is broken and plain HTTP wouldn't help.
        const local = await runner.run('health-local', [], envelopeSchema, { allowFailure: true });
        if (!local.ok) {
          throw new BootstrapError('health', `${baseUrl}/health not ready after ${first.elapsedMs + (second?.elapsedMs ?? 0)} ms `
            + `(last HTTP ${(second ?? first).status ?? 'none'}; in-sandbox loopback check failed)`);
        }
      }
    }
  }
  if (!health) {
    const served = await step('serve-http', () => runner.run('serve-http', [], serveHttpStepSchema, { timeoutSeconds: 180 }),
      (value) => value.baseUrl);
    baseUrl = served.baseUrl;
    transport = 'http';
    pairingCode = withBaseUrl(pairingCode, baseUrl);
    writeSecretFile(options.pairingOutputPath, pairingCode);
    for (const clientPath of extraClientPaths) {
      writeSecretFile(clientPath, withBaseUrl(fs.readFileSync(clientPath, 'utf8'), baseUrl));
    }
    health = await step('health', async () => requireHealthy(await waitHealth(healthTimeoutMs)),
      (value) => `${value.elapsedMs} ms over plain HTTP inside the tailnet`);
  }

  // Serve lives in tailscaled.state, which a resume has brought back stale; keep a desired copy that a boot unit re-applies.
  await step('serve-guard', () => runner.run('serve-guard', [transport], serveGuardStepSchema, { timeoutSeconds: 180 }),
    () => `${transport} Serve re-applied on boot if lost`);

  if (repoDir && repoName) {
    const dir = repoDir;
    // A clone alone is invisible to Pane: register it so `panes create --repo <name>` works. Idempotent on re-run.
    await step('register-repo', () => registerRepo(pairingCode, dir, repoName, options.remoteTransport),
      () => repoName);
  }

  return {
    ...tailnet,
    baseUrl,
    transport,
    pairingPath: options.pairingOutputPath,
    extraClientPaths,
    daemonVersion: health.version ?? install.version ?? undefined,
    health,
    identityReset: identity.reset === true,
    deletedStaleNodeIds,
    repoDir,
    timings,
  };
}

type StepFn = <T>(name: ProvisionStepName, run: () => Promise<T>, detail?: (value: T) => string) => Promise<T>;

/**
 * The first half of provisioning, shared with `joinSandboxToTailnet`: identity reset, Tailscale
 * install, the strip-list check, stale-device cleanup and the tagged join (never Tailscale SSH).
 */
async function prepareAndJoin(
  sandbox: SandboxHandle,
  runner: StepRunner,
  options: { sessionId: string; tailscale: TailscaleApi },
  hostname: string,
  tags: string[],
  home: string,
  step: StepFn,
  tailnetTcpPorts: number[],
): Promise<{ identity: { reset?: boolean }; tailnet: TailnetIdentity; deletedStaleNodeIds: string[] }> {
  await step('upload-scripts', () => uploadScripts(sandbox, home));
  const identity = await step('identity', () => runner.run('identity', [options.sessionId], identityStepSchema),
    (value) => (value.reset === true ? 'reset' : 'already this session'));
  await step('tailscale-install', () => runner.run('tailscale-install', [], envelopeSchema));
  const current = await runner.run('tailnet-identity', [], tailnetStepSchema);
  const alreadyJoined = current.backendState === 'Running';
  if (!alreadyJoined) {
    await step('check', async () => {
      const check = await runner.run('check', [], checkStepSchema, { allowFailure: true });
      if (!check.ok) {
        const failed = check.failed?.join('; ') ?? 'unknown';
        throw new BootstrapError('check', `identity strip-list check failed: ${failed}`);
      }
      return check;
    }, (value) => `${String(value.passed)} passed`);
  }

  await step('firewall', () => runner.run('firewall', [tailnetTcpPorts.join(',')], firewallStepSchema, { timeoutSeconds: 300 }),
    (value) => `tailnet tcp ${(value.allowedTcp ?? tailnetTcpPorts).join(',')} only`);

  const deletedStaleNodeIds: string[] = [];
  const tailnet = await step('tailscale-join', async () => {
    if (alreadyJoined) {
      // tailscale-up installs the tailscaled.state guard; a retry past the join installs it here.
      await runner.run('ts-guard', [], envelopeSchema, { timeoutSeconds: 120 });
      return parseIdentity(current);
    }
    // A device left under this hostname would push the new node to "<hostname>-1". Only a stale node
    // of ours is deleted; anyone else's device under the name stops the join instead.
    const stale = deletableNodeIds(await options.tailscale.findDevicesByHostname(hostname), tags);
    refuseForeignDevices('tailscale-join', hostname, stale.foreign);
    for (const nodeId of stale.nodeIds) {
      if (await options.tailscale.deleteDevice(nodeId)) {
        deletedStaleNodeIds.push(nodeId);
      }
    }
    return joinTailnet(sandbox, runner, options.tailscale, home, hostname, tags);
  }, (value) => value.magicDnsName);
  assertTailnetIdentity(tailnet, hostname, tags);
  return { identity, tailnet, deletedStaleNodeIds };
}

interface JoinOnlyOptions {
  /** Keys the one-time identity reset, like a cloud Session id does in provisionSandbox. */
  sessionId: string;
  hostname: string;
  /** The only tcp ports this node accepts from the tailnet (the coordinator: its API port). */
  tailnetTcpPorts: number[];
  tailscale: TailscaleApi;
  tags?: string[];
  sandboxHome?: string;
  onStep?: (step: ProvisionStep) => void;
}

/**
 * Joins a sandbox to the tailnet with the same identity reset, strip-list check and tagged,
 * SSH-off key as a cloud Session, without installing Pane. Used for the coordinator's sandbox.
 * Safe to re-run: an already joined node is kept.
 */
export async function joinSandboxToTailnet(sandbox: SandboxHandle, options: JoinOnlyOptions): Promise<TailnetIdentity> {
  const home = options.sandboxHome ?? DEFAULT_SANDBOX_HOME;
  const hostname = assertHostname(options.hostname);
  const step: StepFn = async (name, run, detail) => {
    options.onStep?.({ step: name, state: 'start' });
    const started = Date.now();
    const value = await run();
    options.onStep?.({ step: name, state: 'done', elapsedMs: Date.now() - started, detail: detail?.(value) });
    return value;
  };
  const runner = new StepRunner(sandbox, home);
  const { tailnet } = await prepareAndJoin(sandbox, runner, options, hostname, options.tags ?? [CLOUD_SESSION_TAG], home, step,
    options.tailnetTcpPorts);
  return tailnet;
}

/**
 * Repair path: gives a sandbox a fresh tailnet node under the SAME hostname. Deletes the old
 * device(s) through the API first (otherwise the name gets a -1 suffix and the old name keeps
 * pointing at a dead IP), wipes the node state, rejoins with a new single-use key and restores
 * Tailscale Serve. The MagicDNS name is kept; the tailnet IPs change.
 */
export async function reenrolSandbox(sandbox: SandboxHandle, options: ReenrolOptions): Promise<ReenrolResult> {
  const started = Date.now();
  const home = options.sandboxHome ?? DEFAULT_SANDBOX_HOME;
  const hostname = assertHostname(options.hostname);
  const tags = options.tags ?? [CLOUD_SESSION_TAG];
  const runner = new StepRunner(sandbox, home);
  await uploadScripts(sandbox, home);

  const doomed = deletableNodeIds(await options.tailscale.findDevicesByHostname(hostname), tags, options.oldNodeId);
  refuseForeignDevices('tailscale-reenrol', hostname, doomed.foreign);
  const deletedNodeIds: string[] = [];
  for (const nodeId of doomed.nodeIds) {
    if (await options.tailscale.deleteDevice(nodeId)) {
      deletedNodeIds.push(nodeId);
    }
  }

  await runner.run('tailscale-reset', [], envelopeSchema);
  const identity = await joinTailnet(sandbox, runner, options.tailscale, home, hostname, tags);
  assertTailnetIdentity(identity, hostname, tags);
  if (options.restoreServe ?? true) {
    await runner.run('serve-restore', [], envelopeSchema);
  }
  return { ...identity, deletedNodeIds, elapsedMs: Date.now() - started };
}

interface RepairOptions {
  hostname: string;
  tailscale: TailscaleApi;
  oldNodeId?: string;
  /** False for a node without a Pane daemon behind Tailscale Serve (the coordinator). */
  restoreServe?: boolean;
  sandboxHome?: string;
}

type RepairResult =
  | { reenrolled: false; backendState: string }
  | ({ reenrolled: true; previousBackendState: string } & ReenrolResult);

/**
 * Wake-time repair: when a resumed sandbox's node is no longer logged in (seen live on boat: an
 * incremental restore brought tailscaled.state back empty), re-enrol it under the same hostname.
 * A node that is running is left alone, so this is safe to call whenever /health does not answer.
 */
export async function repairTailnetIfLoggedOut(sandbox: SandboxHandle, options: RepairOptions): Promise<RepairResult> {
  const home = options.sandboxHome ?? DEFAULT_SANDBOX_HOME;
  await uploadScripts(sandbox, home);
  const current = await new StepRunner(sandbox, home).run('tailnet-identity', [], tailnetStepSchema);
  const backendState = current.backendState ?? 'unknown';
  if (backendState === 'Running') return { reenrolled: false, backendState };
  const result = await reenrolSandbox(sandbox, {
    hostname: options.hostname,
    tailscale: options.tailscale,
    oldNodeId: options.oldNodeId,
    restoreServe: options.restoreServe,
    sandboxHome: home,
  });
  return { reenrolled: true, previousBackendState: backendState, ...result };
}

interface ServeRepairOptions {
  transport: 'https' | 'http';
  sandboxHome?: string;
}

interface ServeRepairResult {
  backendState: string;
  /** True when the Serve config was missing and got re-applied. */
  serveApplied: boolean;
  detail: string;
}

/**
 * For a running Session: installs the tailscaled.state and Serve guards (Sessions made by older CLIs lack
 * them) and re-applies Serve if it is missing. Never stops or restarts anything. A node that is not
 * Running is left to repairTailnetIfLoggedOut.
 */
export async function repairServeAndGuards(sandbox: SandboxHandle, options: ServeRepairOptions): Promise<ServeRepairResult> {
  const home = options.sandboxHome ?? DEFAULT_SANDBOX_HOME;
  await uploadScripts(sandbox, home);
  const runner = new StepRunner(sandbox, home);
  const current = await runner.run('tailnet-identity', [], tailnetStepSchema);
  const backendState = current.backendState ?? 'unknown';
  if (backendState !== 'Running') return { backendState, serveApplied: false, detail: 'tailscale is not Running' };
  await runner.run('ts-guard', [], envelopeSchema, { timeoutSeconds: 120 });
  const serve = await runner.run('serve-guard', [options.transport], serveGuardStepSchema, { timeoutSeconds: 180 });
  return { backendState, serveApplied: serve.applied === true, detail: serve.detail ?? '' };
}

/**
 * Writes the Pane version this Session's daemon may install on `runpane:cloud:upgrade` (root:root 0644
 * /etc/rp-cloud/pane-pin.json), or removes it for null. The coordinator relays the pin; it can't set it.
 */
export async function writePanePin(sandbox: SandboxHandle, pin: PinnedPane | null, sandboxHome = DEFAULT_SANDBOX_HOME): Promise<void> {
  await uploadScripts(sandbox, sandboxHome);
  await new StepRunner(sandbox, sandboxHome).run('pin-pane', pin ? [pin.version, pin.debUrl, pin.sha256] : ['--clear'], envelopeSchema,
    { timeoutSeconds: 60 });
}

async function registerRepo(pairingCode: string, dir: string, name: string, transport?: RemoteHttpTransport): Promise<void> {
  const pairing = decodePairingCode(pairingCode);
  const client = new RemoteDaemonClient({
    profile: { id: 'runpane-cloud-bootstrap', label: pairing.label, baseUrl: pairing.baseUrl, token: pairing.token },
    runtimeId: 'runpane-cloud-bootstrap',
    clientLabel: 'runpane cloud',
    transport,
  });
  try {
    await client.invoke('runpane:repos:add', [{ path: dir, name }], { timeoutMs: 60_000 });
  } catch (error) {
    throw new BootstrapError('register-repo', `could not register ${dir} with the Pane daemon: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function joinTailnet(
  sandbox: SandboxHandle,
  runner: StepRunner,
  tailscale: TailscaleApi,
  home: string,
  hostname: string,
  tags: string[],
): Promise<TailnetIdentity> {
  const key = await tailscale.mintAuthKey({ tags, description: `runpane cloud ${hostname}` });
  const keyPath = path.posix.join(stateDir(home), `tskey-${crypto.randomBytes(6).toString('hex')}`);
  // The state dir is 0700, so the key is private from the moment it lands; the step chmods and shreds it.
  await sandbox.writeFile(keyPath, key.key);
  return parseIdentity(await runner.run('tailscale-up', [keyPath, hostname], tailnetStepSchema, { timeoutSeconds: 120 }));
}

/** Runpane never deletes a device it did not create; one holding a managed hostname needs the user. */
function refuseForeignDevices(step: string, hostname: string, foreign: TailscaleDevice[]): void {
  if (foreign.length === 0) return;
  throw new BootstrapError(step, `the tailnet already has ${foreign.map(describeForeignDevice).join(', ')} named ${hostname}, `
    + `which runpane did not create (only devices tagged like its own nodes are replaced). Rename or remove it in the Tailscale admin console, then retry.`);
}

function assertTailnetIdentity(identity: TailnetIdentity, hostname: string, tags: string[]): void {
  if (identity.runSsh) {
    throw new BootstrapError('tailscale-join', 'Tailscale SSH is enabled on the node; cloud sessions must run without it');
  }
  const missing = tags.filter((tag) => !identity.tags.includes(tag));
  if (missing.length > 0) {
    throw new BootstrapError('tailscale-join', `node is missing tags ${missing.join(', ')}`);
  }
  const shortName = identity.magicDnsName.split('.')[0];
  if (shortName !== hostname) {
    throw new BootstrapError('tailscale-join',
      `node joined as "${shortName}" instead of "${hostname}" (a stale device still holds the name)`);
  }
}

async function uploadScripts(sandbox: SandboxHandle, home: string): Promise<void> {
  const dir = stateDir(home);
  const prepared = await sandbox.runScript(`umask 077; mkdir -p ${shellQuote(`${dir}/bin`)}; chmod 700 ${shellQuote(dir)}`);
  if (prepared.exitCode !== 0) {
    throw new BootstrapError('upload-scripts', `could not create ${dir} (exit ${String(prepared.exitCode)})`);
  }
  for (const name of UPLOADED_ASSETS) {
    await sandbox.writeFile(`${dir}/bin/${name}`, cloudBootstrapAssets[name]);
  }
}

const envelopeSchema = boundary.object({
  ok: boundary.boolean,
  error: boundary.optional(boundary.string),
});
const identityStepSchema = boundary.object({ ok: boundary.boolean, reset: boundary.optional(boundary.boolean) });
const optionalStringList = boundary.optional(boundary.array(boundary.string));
const tailnetStepSchema = boundary.object({
  backendState: boundary.optional(boundary.string),
  nodeId: boundary.optional(boundary.string),
  hostname: boundary.optional(boundary.string),
  magicDnsName: boundary.optional(boundary.string),
  tailscaleIps: optionalStringList,
  tags: optionalStringList,
  runSsh: boundary.optional(boundary.boolean),
});
const checkStepSchema = boundary.object({
  ok: boundary.boolean,
  failed: optionalStringList,
  passed: boundary.optional(boundary.number),
});
const installStepSchema = boundary.object({ version: boundary.optional(boundary.nullable(boundary.string)) });
const pairingStepSchema = boundary.object({ code: boundary.nonEmptyString });
const cloneStepSchema = boundary.object({ head: boundary.optional(boundary.string) });
const certStatusStepSchema = boundary.object({
  rateLimited: boundary.boolean,
  detail: boundary.optional(boundary.nullable(boundary.string)),
});
const serveHttpStepSchema = boundary.object({ baseUrl: boundary.nonEmptyString });
const serveGuardStepSchema = boundary.object({
  applied: boundary.optional(boundary.boolean),
  detail: boundary.optional(boundary.string),
});

/** auto transport: HTTPS gets this long before the certificate is checked. */
const AUTO_HTTPS_WAIT_MS = 45_000;

/** The same pairing (same token) pointed at another address of the same daemon. */
function withBaseUrl(code: string, baseUrl: string): string {
  return encodePairingCode({ ...decodePairingCode(code), baseUrl });
}
const firewallStepSchema = boundary.object({ allowedTcp: boundary.optional(boundary.array(boundary.number)) });

type TailnetStepResult = ReturnType<typeof tailnetStepSchema.decode>;

class StepRunner {
  constructor(private readonly sandbox: SandboxHandle, private readonly home: string) {}

  async run<Value>(
    stepName: string,
    args: string[],
    schema: BoundarySchema<Value>,
    options: { timeoutSeconds?: number; allowFailure?: boolean } = {},
  ): Promise<Value> {
    const script = [`${stateDir(this.home)}/bin/rp-bootstrap.sh`, stepName, ...args].map(shellQuote).join(' ');
    const result = await this.sandbox.runScript(`bash ${script}`, { timeoutSeconds: options.timeoutSeconds ?? 300 });
    const payload = parseStepResult(result.stdout);
    if (!payload) {
      throw new BootstrapError(stepName, `no result (exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''}): `
        + redact(`${result.stderr}\n${result.stdout}`).trim().split('\n').slice(-5).join(' | '));
    }
    try {
      const envelope = decodeBoundary(payload, envelopeSchema);
      if (!envelope.ok && !options.allowFailure) {
        throw new BootstrapError(stepName, redact(envelope.error ?? 'unknown error'));
      }
      return decodeBoundary(payload, schema);
    } catch (error) {
      if (error instanceof BootstrapError) {
        throw error;
      }
      throw new BootstrapError(stepName, `malformed result: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}

export function parseStepResult(stdout: string): JsonObject | undefined {
  const line = stdout.split('\n').reverse().find((candidate) => candidate.startsWith('RP_RESULT '));
  if (!line) {
    return undefined;
  }
  try {
    return decodeBoundary(JSON.parse(line.slice('RP_RESULT '.length)), boundary.jsonObject);
  } catch {
    return undefined;
  }
}

function parseIdentity(payload: TailnetStepResult): TailnetIdentity {
  if (!payload.nodeId || !payload.magicDnsName) {
    throw new BootstrapError('tailscale-join', 'tailscale reported no node id or MagicDNS name');
  }
  return {
    nodeId: payload.nodeId,
    hostname: payload.hostname ?? '',
    magicDnsName: payload.magicDnsName,
    tailscaleIps: payload.tailscaleIps ?? [],
    tags: payload.tags ?? [],
    runSsh: payload.runSsh === true,
  };
}

function requirePairingCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed.startsWith('pane-remote://')) {
    throw new BootstrapError('pairing', 'the sandbox returned no pane-remote:// code');
  }
  return trimmed;
}

/** Writes a secret to a local file with mode 0600 (parent created 0700). */
function writeSecretFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${content}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function redact(text: string): string {
  return text.replace(PAIRING_PATTERN, '<pairing-redacted>').replace(/tskey-[A-Za-z0-9-]+/g, '<tskey-redacted>');
}

function assertHostname(hostname: string): string {
  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(`"${hostname}" is not a valid tailnet hostname (lowercase letters, digits and dashes)`);
  }
  return hostname;
}

function clientSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
}

function repoNameFromUrl(url: string): string {
  const name = url.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '') ?? '';
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..' ? name : 'repo';
}

function stateDir(home: string): string {
  return path.posix.join(home, '.runpane-cloud');
}
