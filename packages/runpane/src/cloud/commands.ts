import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { CloudArgs } from './args';
import type { JsonObject, JsonValue } from '../boundaryDecoder';
import { placeAgentCredentials } from './agentCredentials';
import { configuredGuardrails, pushAgentNotes, runCloudNotesCommand, type AgentNotesPushResult } from './agentNotes';
import { COORDINATOR_LIFECYCLE_USAGE, isCoordinatorLifecycleCommand, runCoordinatorLifecycle } from './coordinatorDeploy';
import { COORDINATOR_DOPPLER_USAGE, runCoordinatorDoppler } from './coordinatorDoppler';
import { COORDINATOR_GITHUB_USAGE, runCoordinatorGitHub } from './coordinatorGithub';
import { COORDINATOR_REVOKE_USAGE, isCoordinatorRevokeCommand, runCoordinatorRevoke } from './coordinatorRevoke';
import { NO_COORDINATOR, pushDirectory, type CoordinatorPushResult } from './coordinatorSync';
import { syncDesktopProfiles, type DesktopImportResult } from './desktop';
import { assertHttpsArtifactUrl } from './bootstrap';
import { deletableNodeIds, deleteOwnedDevices } from './tailscale';
import { cloneThroughBroker, connectDeployKey, deployKeyCloneUrl, parseRepoSpec, revokeGitHubGrants, runGitCommand, runGitHubCommand } from './github';
import { brokerReaches, enableBroker, readBrokerStatus } from './githubBroker';
import { coordinatorSecretsEnabled, describeSecretsOutcome, enableSessionSecrets } from './sessionSecrets';
import type { GitHubPort } from './githubApi';
import { decodePairingCode } from './pairing';
import { pushPanePin } from './panePin';
import { pushPeersFile, runPeersCommand } from './peers';
import { runSecretsCommand } from './secrets';
import { runCloudPortCommand } from './sessionPorts';
import { describeOrg, hostProvider, resolveBoatOrg } from './wallet';
import type { BootstrapPort, TailnetDevice, TailnetPort } from './ports';
import type { CloudProvider, CloudSandbox, CloudSize } from './provider';
import {
  DEFAULT_MAX_LIVE_SANDBOXES,
  DEFAULT_NAME_PREFIX,
  DEFAULT_PANE_SOURCE,
  findHost,
  type CloudCredentials,
  type CloudHostProfile,
  type CloudHostRecord,
  type CloudSettings,
  type CloudStore,
  type PaneSource,
} from './store';

/** Everything the cloud commands touch outside this module, so tests can swap in fakes. */
export interface CloudDeps {
  store: CloudStore;
  /** A provider whose calls are scoped to `org` (a boat wallet id, name or `personal`); none: boat's active wallet. */
  createProvider(credentials: CloudCredentials, org?: string): CloudProvider;
  bootstrap: BootstrapPort;
  /** Reads a secret from a file path, or stdin for "-". The value is never echoed. */
  readSecretFile(path: string): Promise<string>;
  stdout(line: string): void;
  stderr(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  env: NodeJS.ProcessEnv;
  /** Desktop Pane data dir used when neither --desktop-dir nor $RUNPANE_CLOUD_DESKTOP_DIR is given. */
  defaultDesktopDir: string;
  /** Runs `runpane cloud coordinator ...` (the coordinator CLI in ./coordinator). */
  runCoordinator?(argv: string[]): Promise<number>;
  /**
   * Replaces the coordinator's directory (PUT /cloud/directory). Resolves `pushed: false` when no
   * coordinator is configured; `runpane cloud` is the directory's single writer.
   */
  pushCoordinatorDirectory(directory: JsonObject): Promise<CoordinatorPushResult>;
  /**
   * POST /cloud/wake on the configured coordinator and wait. Resolves null when no coordinator is
   * configured or it cannot be reached; never throws.
   */
  wakeViaCoordinator(sessionId: string, timeoutMs: number): Promise<CoordinatorWakeResult | null>;
  /** Packs this CLI's own package (dist + package.json) as a base64 .tar.gz, for the coordinator sandbox. */
  packCoordinatorApp(): Promise<{ archiveBase64: string; version: string }>;
  /**
   * Calls the configured coordinator's API as this machine's `user:` caller. Rejects when no
   * coordinator client is configured or it cannot be reached.
   */
  callCoordinatorApi?(method: 'GET' | 'POST' | 'PUT', pathAndQuery: string, body: JsonValue | undefined, timeoutMs: number): Promise<{ status: number; body: JsonValue }>;
  /** GET <coordinator>/health; never throws. */
  probeCoordinatorHealth(baseUrl: string): Promise<{ ok: boolean; status?: number; version?: string }>;
  /** Calls a cloud host's daemon over the tailnet with the saved (full) client token. */
  invokeDaemon(profile: CloudHostProfile, channel: string, args: JsonObject[], timeoutMs: number): Promise<JsonValue | undefined>;
  /**
   * Asks the host's daemon `runpane:cloud:safe-to-stop` with `flush: "always"` over its paired
   * token: SQLite's WAL is checkpointed and files fsynced, and the answer lists what is still busy.
   * Rejects when the daemon can't answer (an older daemon, or it is down).
   */
  safeToStop?(profile: { baseUrl: string; token: string }): Promise<CloudSafeToStopAnswer>;
  /**
   * Runs a program on this machine without a shell (e.g. `doppler secrets get` for
   * `cloud secrets set --from-doppler`). stdout may hold a secret: callers never print it.
   */
  runLocal?(file: string, args: readonly string[], timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  /** GitHub with the laptop's own credential, and the local git for mediated pushes. */
  github: GitHubPort;
}

interface CoordinatorWakeResult {
  status: string;
  version?: string | null;
  detail?: string | null;
}

export interface CloudSafeToStopAnswer {
  safe: boolean;
  blockers: { condition: string; message: string }[];
  flushed: boolean;
}

/**
 * The status vocabulary the coordinator's /cloud/wake also uses (coordinator/wake.ts):
 * awake = running and /health answers; asleep = stopped; waking = starting or /health not up yet;
 * daemon-down = running but /health does not answer; lost = the provider no longer has it.
 */
type CloudHostStatus = 'awake' | 'asleep' | 'waking' | 'stopping' | 'daemon-down' | 'lost';

const SANDBOX_READY_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 120_000;
const DEFAULT_WAKE_TIMEOUT_MS = 120_000;
const WAKE_REPAIR_CHECK_MS = 30_000;
const DEFAULT_NEW_HEALTH_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_500;
const STATUS_HEALTH_TIMEOUT_MS = 5_000;
const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export async function runCloudCommand(args: CloudArgs, deps: CloudDeps): Promise<number> {
  switch (args.subcommand) {
    case 'setup': return runSetup(args, deps);
    case 'new': return runNew(args, deps);
    case 'list': return runList(args, deps);
    case 'status': return runStatus(args, deps);
    case 'stop': return runStop(args, deps);
    case 'wake': return runWake(args, deps);
    case 'repair': return runRepair(args, deps);
    case 'destroy': return runDestroy(args, deps);
    case 'pair': return runPair(args, deps);
    case 'sync': return runSync(args, deps);
    case 'coordinator':
      if (isCoordinatorLifecycleCommand(args.passthrough)) return runCoordinatorLifecycle(args.passthrough, deps);
      if (isCoordinatorRevokeCommand(args.passthrough)) return runCoordinatorRevoke(args.passthrough, deps);
      if (args.passthrough[0] === 'github') {
        if (['help', '--help', '-h', undefined].includes(args.passthrough[1])) {
          deps.stdout(COORDINATOR_GITHUB_USAGE);
          return 0;
        }
        return runCoordinatorGitHub(args.passthrough.slice(1), deps);
      }
      if (args.passthrough[0] === 'doppler') {
        if (['help', '--help', '-h', undefined].includes(args.passthrough[1])) {
          deps.stdout(COORDINATOR_DOPPLER_USAGE);
          return 0;
        }
        return runCoordinatorDoppler(args.passthrough.slice(1), deps);
      }
      if (['help', '--help', '-h', undefined].includes(args.passthrough[0])) deps.stdout(`${COORDINATOR_LIFECYCLE_USAGE}\n${COORDINATOR_REVOKE_USAGE}\n${COORDINATOR_GITHUB_USAGE}\n${COORDINATOR_DOPPLER_USAGE}\n`);
      if (!deps.runCoordinator) throw new Error('runpane cloud coordinator is not available in this build.');
      return deps.runCoordinator(args.passthrough);
    case 'peers': return runPeersCommand(args.passthrough, deps);
    case 'secrets': return runSecretsCommand(args.passthrough, deps);
    case 'port': return runCloudPortCommand(args.passthrough, deps);
    case 'github': return runGitHubCommand(args.passthrough, deps);
    case 'git': return runGitCommand(args.passthrough, deps);
    case 'notes': return runCloudNotesCommand(args.passthrough, deps);
  }
}

// ---------------------------------------------------------------- setup

async function runSetup(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const credentials = await deps.store.readCredentials();
  const settings = await deps.store.readSettings();
  const changed: string[] = [];

  if (args.boatKeyFile) {
    credentials.boat = { apiKey: await readRequiredSecret(deps, args.boatKeyFile, 'boat API key') };
    changed.push('boat API key');
  }
  if (args.tailscaleClientId || args.tailscaleSecretFile || args.tailscaleTailnet) {
    const clientId = args.tailscaleClientId ?? credentials.tailscale?.clientId;
    const clientSecret = args.tailscaleSecretFile
      ? await readRequiredSecret(deps, args.tailscaleSecretFile, 'Tailscale OAuth client secret')
      : credentials.tailscale?.clientSecret;
    if (!clientId || !clientSecret) {
      throw new Error('The Tailscale OAuth client needs both --tailscale-client-id and --tailscale-secret-file.');
    }
    credentials.tailscale = { clientId, clientSecret };
    const tailnet = args.tailscaleTailnet ?? credentials.tailscale?.tailnet;
    if (tailnet) credentials.tailscale.tailnet = tailnet;
    changed.push('Tailscale OAuth client');
  }
  if (args.anthropicKeyFile) {
    credentials.anthropic = { apiKey: await readRequiredSecret(deps, args.anthropicKeyFile, 'Anthropic API key') };
    changed.push('Anthropic API key');
  }
  if (args.claudeTokenFile) {
    credentials.claude = { oauthToken: await readRequiredSecret(deps, args.claudeTokenFile, 'Claude token') };
    changed.push('Claude token');
  }

  const nextSettings: CloudSettings = { ...settings };
  if (args.golden) nextSettings.goldenSnapshot = args.golden;
  if (args.noGolden) delete nextSettings.goldenSnapshot;
  if (args.size) nextSettings.size = args.size;
  if (args.transport) nextSettings.transport = args.transport;
  if (args.namePrefix) nextSettings.namePrefix = args.namePrefix;
  if (args.maxLive) nextSettings.maxLiveSandboxes = args.maxLive;
  if (args.coordinator !== undefined) nextSettings.coordinator = { enabled: args.coordinator };
  const paneSource = paneSourceFromArgs(args);
  if (paneSource) nextSettings.paneSource = paneSource;

  if (args.boatOrg) {
    if (!credentials.boat) throw new Error('--boat-org needs the boat API key: pass --boat-key-file too, or run setup with it first.');
    nextSettings.boatOrg = await resolveBoatOrg(deps.createProvider(credentials), args.boatOrg);
    changed.push('boat wallet');
  }

  const checks: Record<string, string> = {};
  if (!args.noVerify) {
    if (credentials.boat) {
      const me = await deps.createProvider(credentials).verifyCredentials();
      checks.boat = `ok (${me.account})`;
    }
    if (credentials.tailscale) {
      await deps.bootstrap.createTailnet(credentials.tailscale).findDevicesByHostname('runpane-cloud-setup-check');
      checks.tailscale = 'ok';
    }
  }

  await deps.store.writeCredentials(credentials);
  await deps.store.writeSettings(nextSettings);

  const summary = {
    ok: true,
    dir: deps.store.dir,
    changed,
    configured: {
      boat: Boolean(credentials.boat),
      tailscale: Boolean(credentials.tailscale),
      anthropic: Boolean(credentials.anthropic),
      claude: Boolean(credentials.claude),
    },
    checks,
    settings: nextSettings,
  };
  if (args.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    deps.stdout(`runpane cloud: saved to ${deps.store.dir} (files are 0600; keys stay on this machine).`);
    deps.stdout(`  boat API key:            ${summary.configured.boat ? 'set' : 'missing'}${checks.boat ? ` - ${checks.boat}` : ''}`);
    deps.stdout(`  Tailscale OAuth client:  ${summary.configured.tailscale ? 'set' : 'missing'}${checks.tailscale ? ` - ${checks.tailscale}` : ''}`);
    deps.stdout(`  Anthropic API key:       ${summary.configured.anthropic ? 'set' : 'not set (optional)'}`);
    deps.stdout(`  Claude token:            ${summary.configured.claude ? 'set' : 'not set (optional)'}`);
    deps.stdout(`  golden snapshot:         ${nextSettings.goldenSnapshot ?? 'none (plain image; bootstrap installs everything)'}`);
    deps.stdout(`  boat wallet (new):       ${nextSettings.boatOrg ? describeOrg(nextSettings.boatOrg) : "boat's active wallet (pin one with --boat-org <org|personal>)"}`);
    if (!summary.configured.boat || !summary.configured.tailscale) {
      deps.stdout('Next: runpane cloud setup --boat-key-file <path|-> --tailscale-client-id <id> --tailscale-secret-file <path|->');
    } else {
      deps.stdout('Next: runpane cloud new --label "My Session" --yes');
    }
  }
  return 0;
}

async function readRequiredSecret(deps: CloudDeps, file: string, what: string): Promise<string> {
  const value = (await deps.readSecretFile(file)).trim();
  if (!value) throw new Error(`The ${what} file is empty.`);
  return value;
}

function paneSourceFromArgs(args: CloudArgs): PaneSource | undefined {
  if (args.paneDebUrl) {
    assertHttpsArtifactUrl(args.paneDebUrl, '--pane-deb-url');
    return args.paneDebSha256 ? { kind: 'deb-url', url: args.paneDebUrl, sha256: args.paneDebSha256 } : { kind: 'deb-url', url: args.paneDebUrl };
  }
  if (args.paneNpmSpec) return { kind: 'runpane-npm', spec: args.paneNpmSpec };
  if (args.panePreinstalled) return { kind: 'preinstalled' };
  return undefined;
}

// ---------------------------------------------------------------- new

async function runNew(args: CloudArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) {
    throw new Error('runpane cloud new creates a billed cloud sandbox. Rerun with --yes to confirm.');
  }
  const settings = await deps.store.readSettings();
  const loaded = await loadCloud(deps);
  // The wallet is fixed at create, so it is chosen explicitly: --boat-org, else the saved one.
  const wantedOrg = args.boatOrg ? await resolveBoatOrg(loaded.provider, args.boatOrg) : settings.boatOrg;
  const { credentials, tailnetCredentials } = loaded;
  const provider = wantedOrg ? deps.createProvider(credentials, wantedOrg.id) : loaded.provider;
  const namePrefix = args.namePrefix ?? settings.namePrefix ?? DEFAULT_NAME_PREFIX;
  const size: CloudSize = args.size ?? settings.size ?? 'default';
  const fromSnapshot = args.noGolden ? undefined : args.fromSnapshot ?? settings.goldenSnapshot;
  // A golden image already carries the Pane .deb; a plain image needs it installed.
  const paneSource = paneSourceFromArgs(args) ?? settings.paneSource
    ?? (fromSnapshot ? { kind: 'preinstalled' } : DEFAULT_PANE_SOURCE);
  if (paneSource.kind === 'deb-url') {
    assertHttpsArtifactUrl(paneSource.url, 'The saved Pane .deb URL (runpane cloud setup --pane-deb-url)');
    // Installed as root: without a digest, only https to the URL's host vouches for the package.
    if (!paneSource.sha256) {
      deps.stderr(`runpane cloud: WARNING: the Pane .deb from ${paneSource.url} will be installed as root with no sha256 check; `
        + 'only https to its host vouches for it. Pass --pane-deb-sha256 <hex> (or save it with runpane cloud setup --pane-deb-url <url> --pane-deb-sha256 <hex>).');
    }
  }
  const maxLive = settings.maxLiveSandboxes ?? DEFAULT_MAX_LIVE_SANDBOXES;
  const progress = (line: string) => (args.json ? deps.stderr(line) : deps.stdout(line));

  // A private repository is cloned over a deploy key: check the laptop's GitHub credential can add one
  // before a billed sandbox exists.
  const githubRepo = args.github && args.repo ? parseRepoSpec(args.repo) : undefined;
  const githubTokenSource = args.githubTokenFile ? { kind: 'file' as const, path: args.githubTokenFile } : { kind: 'gh' as const };
  if (args.githubTokenFile === '-') throw new Error('new --github-token-file needs a file (the token is read more than once), not stdin.');
  // With the coordinator's GitHub broker on, the Session publishes through it. App mode
  // also reads through it (no deploy key); PAT mode still reads over a read-only deploy key.
  let brokerMode: 'app' | 'pat' | null = null;
  if (githubRepo && settings.coordinator?.deployment && !args.readWrite) {
    const status = await readBrokerStatus(deps);
    if ('unavailable' in status) progress(`runpane cloud: not using the coordinator's GitHub broker (${status.unavailable}); falling back to a deploy key.`);
    else if (status.mode === 'off') progress('runpane cloud: the coordinator\'s GitHub broker is off; using a read-only deploy key (publish with runpane cloud git push).');
    else if (!brokerReaches(status, githubRepo)) progress(`runpane cloud: the coordinator's GitHub broker does not reach ${githubRepo}; using a read-only deploy key.`);
    else brokerMode = status.mode;
  }
  if (githubRepo && brokerMode !== 'app') {
    const info = await deps.github.api(await deps.github.resolveToken(githubTokenSource)).getRepo(githubRepo);
    if (!info.admin) throw new Error(`Your GitHub credential cannot add deploy keys to ${info.fullName} (that needs admin on the repository).`);
  }

  const records = await deps.store.listHosts();
  const live = await countLiveSandboxes(provider, records, namePrefix);
  if (live >= maxLive) {
    throw new Error(`Runaway guard: ${live} cloud sandboxes are already live (limit ${maxLive}). Stop or destroy one first, or raise it with runpane cloud setup --max-live <n>.`);
  }

  const sessionId = randomSessionId();
  const hostname = deps.bootstrap.cloudHostname(sessionId, namePrefix);
  const label = args.label ?? hostname;
  const started = deps.now();
  const timings: Record<string, number> = {};
  let agentNotes: AgentNotesPushResult | null = null;

  progress(`runpane cloud: creating ${size} sandbox ${hostname}${fromSnapshot ? ` from ${fromSnapshot}` : ''}...`);
  const sandbox = await provider.create({
    name: hostname,
    size,
    fromSnapshot,
    org: wantedOrg?.id,
    idempotencyKey: `runpane-cloud-new-${sessionId}`,
  });
  timings.createMs = deps.now() - started;
  // Record the wallet boat actually billed (its answer, not our request); unknown until a later get.
  const billedOrg = sandbox.org ?? wantedOrg;

  // Record the host before provisioning, so a failure part-way still leaves something `destroy` can find.
  const record: CloudHostRecord = {
    version: 1,
    profile: {
      id: `cloud-${sessionId}`,
      label,
      baseUrl: '',
      token: '',
      transport: 'http+sse',
      cloud: { provider: provider.name, sandboxId: sandbox.id, sessionId, nodeId: '', hostname, version: 1 },
    },
    meta: {
      createdAt: new Date(started).toISOString(),
      size,
      namePrefix,
      magicDnsName: '',
      pairingPath: deps.store.pairingPath(hostname),
      paneSource,
    },
  };
  if (billedOrg) record.meta.boatOrg = billedOrg;
  if (args.repo) {
    record.meta.repo = { url: args.repo };
    if (args.ref) record.meta.repo.ref = args.ref;
  }
  await deps.store.writeHost(record);

  try {
    // The provider could not name it at create time: the record above already holds its id, so a
    // failure here still goes through the cleanup below instead of leaking an unnamed sandbox.
    if (sandbox.name !== hostname) await provider.rename(sandbox.id, hostname);
    const ready = await waitForSandbox(provider, sandbox.id, 'running', SANDBOX_READY_TIMEOUT_MS, deps);
    if (ready.org && ready.org.id !== record.meta.boatOrg?.id) {
      record.meta.boatOrg = ready.org;
      await deps.store.writeHost(record);
    }
    if (wantedOrg && record.meta.boatOrg && record.meta.boatOrg.id !== wantedOrg.id) {
      throw new Error(`boat billed ${describeOrg(record.meta.boatOrg)} instead of the requested ${describeOrg(wantedOrg)}.`);
    }
    timings.readyMs = deps.now() - started;
    progress(`runpane cloud: sandbox ${sandbox.id} is up; joining the tailnet and installing the Pane daemon...`);
    let cloneRepo = record.meta.repo;
    // App mode clones through the broker once the coordinator knows this Session (below).
    if (brokerMode === 'app') cloneRepo = undefined;
    if (githubRepo && record.meta.repo && brokerMode !== 'app') {
      const grant = await connectDeployKey(record, provider.handle(sandbox.id), deps, {
        repo: githubRepo,
        readWrite: args.readWrite,
        tokenSource: githubTokenSource,
        onStep: (step) => progress(`  - ${step}`),
      });
      cloneRepo = { ...record.meta.repo, url: deployKeyCloneUrl(grant.repo) };
    }

    const coordinatorEnabled = settings.coordinator?.enabled === true;
    const outcome = await deps.bootstrap.provision(provider.handle(sandbox.id), {
      sessionId,
      label,
      hostname,
      paneSource,
      repo: cloneRepo,
      transport: args.transport ?? settings.transport ?? 'auto',
      pairingOutputPath: record.meta.pairingPath,
      extraClients: coordinatorEnabled
        ? [{ label: 'runpane-cloud-coordinator', outputPath: deps.store.coordinatorPairingPath(hostname), scope: 'coordinator' }]
        : undefined,
      healthTimeoutMs: args.timeoutMs ?? DEFAULT_NEW_HEALTH_TIMEOUT_MS,
      onStep: (step) => progress(`  - ${step}`),
    }, tailnetCredentials);
    timings.provisionedMs = deps.now() - started;

    const pairing = decodePairingCode(await deps.store.readPairing(hostname));
    record.profile = {
      ...record.profile,
      baseUrl: pairing.baseUrl,
      token: pairing.token,
      cloud: { ...record.profile.cloud, nodeId: outcome.nodeId },
    };
    if (pairing.tunnel?.kind === 'tailscale') {
      record.profile.tunnel = { kind: 'tailscale', selected: true };
      if (pairing.tunnel.note) record.profile.tunnel.note = pairing.tunnel.note;
    }
    record.meta.magicDnsName = outcome.magicDnsName;
    const agentKeys = await placeAgentCredentials(provider.handle(sandbox.id), credentials,
      record.meta.repo ? [`/home/user/${repoDirName(record.meta.repo.url)}`] : []);
    if (agentKeys.length > 0) {
      // The daemon restarted with the agent environment; wait for it again before handing the host over.
      const health = await deps.bootstrap.waitForDaemonHealth(pairing.baseUrl, { token: pairing.token, timeoutMs: 60_000, intervalMs: 500 });
      if (!health.ok) throw new Error(`the daemon did not come back after adding the agent credentials (${agentKeys.join(', ')})`);
      progress(`  - agent-credentials done: ${agentKeys.join(', ')}`);
      timings.agentCredentialsMs = deps.now() - started;
    }
    if (outcome.daemonVersion) record.meta.daemonVersion = outcome.daemonVersion;
    if (coordinatorEnabled) record.meta.coordinatorPairingPath = deps.store.coordinatorPairingPath(hostname);
    await deps.store.writeHost(record);
    if (coordinatorEnabled) {
      // The daemon upgrades itself only to the pin the laptop wrote; none (cleared) refuses every upgrade.
      const pin = settings.coordinator?.deployment?.pin ?? null;
      const pinned = await pushPanePin(record, pin, deps, provider);
      if (pinned.written) progress(`  - pane-pin done: ${pinned.pinned ?? 'none'}`);
      else deps.stderr(`runpane cloud: ${hostname}'s Pane pin was not written (${pinned.reason}); the coordinator can't upgrade it until runpane cloud repair ${hostname}.`);
    }
    // The user's guardrails (settings agentNotes.guardrails): the daemon keeps them and rewrites them at every wake.
    const guardrails = configuredGuardrails(settings);
    if (guardrails?.length) {
      agentNotes = await pushAgentNotes(record, guardrails, deps);
      if (agentNotes.pushed) progress(`  - agent-notes done: ${guardrails.length} guardrail${guardrails.length === 1 ? '' : 's'} in ${agentNotes.changedFiles.join(', ') || 'the notes'}`);
      else deps.stderr(`runpane cloud: the Session's agent guardrails were not written (${agentNotes.reason}). Retry with: runpane cloud notes push ${hostname}`);
    }
    if (githubRepo && brokerMode) {
      const repo = record.meta.github?.[0]?.repo ?? githubRepo;
      const enabled = await enableBroker(record, provider.handle(sandbox.id), deps, { repo, mode: brokerMode });
      if (!enabled.directory.pushed) throw new Error(`the coordinator did not take the directory (${enabled.directory.reason}), so it would refuse this Session's GitHub calls`);
      if (enabled.peersFile.written === false) throw new Error(`the Session's peers list was not written (${String(enabled.peersFile.reason)}), so it can't reach the coordinator`);
      progress(`  - github-broker done: ${repo} (${brokerMode === 'app' ? 'GitHub App; fetch uses the broker\'s read-only token' : 'fine-grained token; fetch uses the read-only deploy key'}); gh shim installed`);
      if (enabled.shimWarning) deps.stderr(`runpane cloud: ${enabled.shimWarning}`);
      if (brokerMode === 'app' && record.meta.repo) {
        const dir = `/home/user/${repoDirName(record.meta.repo.url)}`;
        const head = await cloneThroughBroker(provider.handle(sandbox.id), repo, record.meta.repo.ref, dir);
        await deps.invokeDaemon(record.profile, 'runpane:repos:add', [{ path: dir, name: repoDirName(record.meta.repo.url) }], 60_000);
        progress(`  - clone done over https (git asks the broker for a read-only token when GitHub wants one): ${head.slice(0, 12)}`);
      }
      timings.githubBrokerMs = deps.now() - started;
      // The coordinator reads this Session's .runpane/secrets.json (directory secretsManifest) and hands
      // it the names; the Session fetches straight from the coordinator, now and at every wake.
      if (await coordinatorSecretsEnabled(deps)) {
        const secrets = await enableSessionSecrets(provider.handle(sandbox.id), hostname);
        progress(`  - secrets done: ${describeSecretsOutcome(secrets)}`);
        if (secrets.warning) deps.stderr(`runpane cloud: ${secrets.warning}`);
        timings.secretsMs = deps.now() - started;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (args.keepOnFailure) {
      deps.stderr(`runpane cloud: setup of ${hostname} failed; kept sandbox ${sandbox.id} for debugging (--keep-on-failure). Remove it with: runpane cloud destroy ${hostname} --yes`);
    } else {
      deps.stderr(`runpane cloud: setup of ${hostname} failed; removing its tailnet device and sandbox ${sandbox.id}...`);
      try {
        const github = await revokeGitHubGrants(record, deps);
        if (github.failed.length > 0) {
          // The record holds the only handle on those keys: keep it, and the sandbox, for a retry.
          await deps.store.writeHost(record);
          throw new Error(`deploy key${github.failed.length === 1 ? '' : 's'} ${github.failed.join(', ')} could not be deleted on GitHub, so ${hostname} and sandbox ${sandbox.id} are kept`);
        }
        await destroyHost(record, provider, deps.bootstrap.createTailnet(tailnetCredentials), deps);
        await deps.store.removeHost(hostname);
        // The broker step may already have told the coordinator about this Session.
        if (record.meta.brokerRepos) await pushDirectory(deps);
      } catch (cleanupError) {
        deps.stderr(`runpane cloud: cleanup failed too: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Run runpane cloud destroy ${hostname} --yes.`);
      }
    }
    throw new Error(`runpane cloud new failed: ${reason}`);
  }

  const desktop = await importIntoDesktop(args, deps, [record.profile]);
  const coordinator = await pushDirectory(deps);
  // A new Session allows no peers, but its peers list names the coordinator so submits can wake peers later.
  const peersFile = settings.coordinator?.deployment ? await pushPeersFile(record, await deps.store.listHosts(), deps, provider) : null;
  timings.totalMs = deps.now() - started;

  if (args.json) {
    deps.stdout(JSON.stringify({
      ok: true,
      host: hostSummary(record),
      pairingPath: record.meta.pairingPath,
      desktop: desktopSummary(desktop),
      coordinator,
      peersFile,
      agentNotes,
      githubBroker: record.meta.brokerRepos ? { repos: record.meta.brokerRepos, mode: record.meta.brokerMode ?? 'app' } : null,
      agentCredentials: agentCredentialsSummary(credentials),
      timings,
    }, null, 2));
  } else {
    deps.stdout(`runpane cloud: ${hostname} is ready at ${record.profile.baseUrl} (${Math.round(timings.totalMs / 1000)} s).`);
    deps.stdout(`  sandbox: ${sandbox.id}   tailnet node: ${record.profile.cloud.nodeId}`);
    deps.stdout(`  boat wallet: ${record.meta.boatOrg ? describeOrg(record.meta.boatOrg) : 'unknown'}${wantedOrg ? '' : " (boat's active wallet; pin one with runpane cloud setup --boat-org <org|personal>)"}`);
    deps.stdout(`  pairing code saved to ${record.meta.pairingPath} (0600; not printed).`);
    if (hostTransport(record) === 'http') {
      deps.stdout(`  transport: ${HTTP_TRANSPORT_NOTE}. Let's Encrypt refused this node's certificate (50 per week per tailnet).`);
    }
    printDesktopOutcome(deps, desktop, hostname);
    printCoordinatorOutcome(deps, coordinator);
    if (record.meta.brokerRepos) {
      deps.stdout(`  github: ${record.meta.brokerRepos.join(', ')} through the coordinator's broker; inside the Session, gh pr create / runpane cloud agent github push publish to cloud/${hostname}/<branch> (draft PRs only).`);
    }
    const agents = agentCredentialsSummary(credentials);
    deps.stdout(agents.length > 0
      ? `  agents: signed in with the saved ${agents.join(' and ')}.`
      : '  agents: no Anthropic key or Claude token saved; sign in inside the Session, or save one with runpane cloud setup --anthropic-key-file <path|->.');
    deps.stdout(`  phone: run \`runpane cloud pair ${hostname}\` and paste the code into https://runpane.com/app/.`);
  }
  return 0;
}

async function countLiveSandboxes(provider: CloudProvider, records: readonly CloudHostRecord[], namePrefix: string): Promise<number> {
  const managedIds = new Set(records.map((record) => record.profile.cloud.sandboxId));
  const sandboxes = await provider.list();
  return sandboxes.filter((sandbox) =>
    (managedIds.has(sandbox.id) || sandbox.name.startsWith(`${namePrefix}-`))
    && sandbox.state !== 'stopped'
    && sandbox.state !== 'gone').length;
}

function agentCredentialsSummary(credentials: CloudCredentials): string[] {
  return [credentials.anthropic ? 'Anthropic API key' : null, credentials.claude ? 'Claude token' : null].filter((kind): kind is string => kind !== null);
}

function repoDirName(url: string): string {
  const name = url.replace(/\/+$/u, '').split('/').pop()?.replace(/\.git$/u, '') ?? '';
  return /^[A-Za-z0-9._-]+$/u.test(name) && name !== '.' && name !== '..' ? name : 'repo';
}

function randomSessionId(): string {
  const bytes = randomBytes(10);
  let id = '';
  for (const byte of bytes) id += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length];
  return id;
}

// ---------------------------------------------------------------- list / status

async function runList(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const listSettings = await deps.store.readSettings();
  const { credentials } = await loadCloud(deps);
  // boat lists your own sandboxes in every wallet's scope; the saved wallet adds nothing hidden.
  const provider = deps.createProvider(credentials, listSettings.boatOrg?.id);
  const records = await deps.store.listHosts();
  const sandboxes = await provider.list();
  const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
  for (const record of records) {
    const listed = byId.get(record.profile.cloud.sandboxId)?.org;
    if (listed && listed.id !== record.meta.boatOrg?.id) {
      record.meta.boatOrg = listed;
      await deps.store.writeHost(record);
    }
  }
  const rows = records.map((record) => {
    const sandbox = byId.get(record.profile.cloud.sandboxId);
    return {
      ...hostSummary(record),
      state: sandbox?.state ?? 'gone',
      providerState: sandbox?.providerState ?? 'not_found',
      size: sandbox?.size ?? record.meta.size,
    };
  });
  const settings = await deps.store.readSettings();
  const coordinatorId = settings.coordinator?.deployment?.sandboxId;
  // The coordinator's own sandbox shares the name prefix but is not a cloud Session.
  const known = new Set(records.map((record) => record.profile.cloud.sandboxId));
  if (coordinatorId) known.add(coordinatorId);
  const prefixes = new Set([settings.namePrefix ?? DEFAULT_NAME_PREFIX, ...records.map((record) => record.meta.namePrefix)]);
  const unmanaged = sandboxes
    .filter((sandbox) => !known.has(sandbox.id) && [...prefixes].some((prefix) => sandbox.name.startsWith(`${prefix}-`)))
    .map((sandbox) => ({ sandboxId: sandbox.id, name: sandbox.name, state: sandbox.state }));

  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, hosts: rows, unmanaged }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    deps.stdout('No cloud hosts. Create one with: runpane cloud new --label "My Session" --yes');
  } else {
    deps.stdout(formatTable(['HOST', 'LABEL', 'STATE', 'SIZE', 'WALLET', 'SANDBOX', 'URL'],
      rows.map((row) => [row.hostname, row.label, row.state, row.size, row.boatOrg?.name ?? '?', row.sandboxId, row.baseUrl || '-'])));
  }
  if (unmanaged.length > 0) {
    deps.stdout('');
    deps.stdout(`Sandboxes that look like cloud hosts but are not in ${deps.store.dir}:`);
    for (const sandbox of unmanaged) deps.stdout(`  ${sandbox.sandboxId} ${sandbox.name} (${sandbox.state})`);
  }
  return 0;
}

interface HostStatusReport {
  host: ReturnType<typeof hostSummary>;
  status: CloudHostStatus;
  sandbox: { state: string; providerState: string; size?: string };
  tailnet: { devices: TailnetDevice[]; sameNode: boolean | null };
  health: { ok: boolean; status?: number; version?: string } | null;
}

async function runStatus(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const { provider, tailnet } = await loadCloudWithTailnet(deps, record);
  const report = await hostStatus(record, provider, tailnet, deps);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, ...report }, null, 2));
  } else {
    deps.stdout(`${record.profile.cloud.hostname}: ${report.status}`);
    deps.stdout(`  sandbox ${record.profile.cloud.sandboxId}: ${report.sandbox.providerState}${report.sandbox.size ? ` (${report.sandbox.size})` : ''}`);
    deps.stdout(`  boat wallet: ${record.meta.boatOrg ? describeOrg(record.meta.boatOrg) : 'unknown'}`);
    deps.stdout(`  transport: ${hostTransport(record) === 'http' ? HTTP_TRANSPORT_NOTE : 'https (Tailscale Serve)'}`);
    const device = report.tailnet.devices[0];
    deps.stdout(`  tailnet: ${device ? describeDevice(device) : 'no device'}${report.tailnet.sameNode === false ? ' (node id changed!)' : ''}`);
    deps.stdout(`  daemon: ${report.health ? `${report.health.ok ? 'healthy' : `not answering${report.health.status ? ` (HTTP ${report.health.status})` : ''}`}${report.health.version ? `, version ${report.health.version}` : ''}` : 'not checked (sandbox not running)'}`);
    deps.stdout(`  url: ${record.profile.baseUrl || '-'}`);
  }
  return report.status === 'lost' ? 1 : 0;
}

function describeDevice(device: TailnetDevice): string {
  const parts = [device.name ?? device.hostname, device.nodeId];
  if (device.online !== undefined) parts.push(device.online ? 'online' : 'offline');
  if (device.lastSeen) parts.push(`last seen ${device.lastSeen}`);
  return parts.join(', ');
}

async function hostStatus(record: CloudHostRecord, provider: CloudProvider, tailnet: TailnetPort, deps: CloudDeps): Promise<HostStatusReport> {
  const sandbox = await provider.get(record.profile.cloud.sandboxId);
  const devices = await tailnet.findDevicesByHostname(record.profile.cloud.hostname);
  const sameNode = record.profile.cloud.nodeId
    ? devices.some((device) => device.nodeId === record.profile.cloud.nodeId)
    : null;
  let health: HostStatusReport['health'] = null;
  let status: CloudHostStatus;
  if (sandbox.state === 'gone' || sandbox.state === 'error') {
    status = 'lost';
  } else if (sandbox.state === 'stopped') {
    status = 'asleep';
  } else if (sandbox.state === 'stopping') {
    status = 'stopping';
  } else if (sandbox.state === 'starting') {
    status = 'waking';
  } else {
    const result = record.profile.baseUrl
      ? await deps.bootstrap.waitForDaemonHealth(record.profile.baseUrl, { token: record.profile.token, timeoutMs: STATUS_HEALTH_TIMEOUT_MS, intervalMs: 1_000 })
      : { ok: false, elapsedMs: 0 };
    health = { ok: result.ok, status: result.status, version: result.version };
    status = result.ok ? 'awake' : 'daemon-down';
  }
  return {
    host: hostSummary(record),
    status,
    sandbox: { state: sandbox.state, providerState: sandbox.providerState, size: sandbox.size },
    tailnet: { devices, sameNode },
    health,
  };
}

// ---------------------------------------------------------------- stop / wake

async function runStop(args: CloudArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) throw new Error('runpane cloud stop powers the sandbox off. Rerun with --yes to confirm.');
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const { provider } = await loadCloud(deps, record);
  const { sandboxId, hostname } = record.profile.cloud;
  const started = deps.now();
  const sandbox = await provider.get(sandboxId);
  if (sandbox.state === 'gone') throw new Error(`${hostname}: the provider no longer has sandbox ${sandboxId}.`);
  if (sandbox.state === 'stopped') {
    report(args, deps, { ok: true, host: hostname, status: 'asleep', alreadyStopped: true }, `${hostname} is already asleep.`);
    return 0;
  }

  // boat's stop is a hard power-off about 1 s after a live snapshot, with no SIGTERM, so make the
  // daemon's state durable first: its safe-to-stop checkpoints the WAL and fsyncs. The user asked for
  // this stop, so blockers are reported, not obeyed. A daemon that can't answer gets a plain sync.
  let flushed = false;
  let flushedBy: 'safe-to-stop' | 'sync' | undefined;
  let blockers: CloudSafeToStopAnswer['blockers'] = [];
  const timings: Record<string, number> = {};
  if (!args.force && sandbox.state === 'running') {
    const answer = record.profile.baseUrl && deps.safeToStop
      ? await deps.safeToStop({ baseUrl: record.profile.baseUrl, token: record.profile.token }).catch(() => null)
      : null;
    if (answer) {
      blockers = answer.blockers;
      flushed = answer.flushed;
      if (flushed) flushedBy = 'safe-to-stop';
      if (blockers.length > 0) {
        deps.stderr(`runpane cloud: stopping ${hostname} while it is busy: ${blockers.map((blocker) => `${blocker.condition} (${blocker.message})`).join('; ')}`);
      }
    }
    if (!flushed) {
      try {
        const result = await provider.handle(sandboxId).runScript('sync; sleep 0.2; sync', { timeoutSeconds: 30 });
        flushed = result.exitCode === 0;
        if (flushed) flushedBy = 'sync';
      } catch (error) {
        deps.stderr(`runpane cloud: could not flush ${hostname} before stopping (${error instanceof Error ? error.message : String(error)}); stopping anyway.`);
      }
    }
    timings.flushMs = deps.now() - started;
  }
  await provider.stop(sandboxId);
  timings.stopAcceptedMs = deps.now() - started;
  let final: CloudSandbox | undefined;
  if (!args.noWait) final = await waitForSandbox(provider, sandboxId, 'stopped', STOP_TIMEOUT_MS, deps);
  const elapsedMs = deps.now() - started;
  report(
    args,
    deps,
    { ok: true, host: hostname, status: final ? 'asleep' : 'stopping', flushed, flushedBy, blockers, timings: { ...timings, totalMs: elapsedMs } },
    final ? `${hostname} is asleep (${(elapsedMs / 1000).toFixed(1)} s). Wake it with: runpane cloud wake ${hostname}` : `${hostname} is stopping.`,
  );
  return 0;
}

async function runWake(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const { provider, tailnet, tailnetCredentials } = await loadCloudWithTailnet(deps, record);
  const { sandboxId, hostname } = record.profile.cloud;
  const timeoutMs = args.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
  const started = deps.now();
  const timings: Record<string, number> = {};

  let sandbox = await provider.get(sandboxId);
  if (sandbox.state === 'gone' || sandbox.state === 'error') {
    throw new Error(`${hostname} is lost: the provider reports ${sandbox.providerState} for ${sandboxId}.`);
  }
  if (sandbox.state === 'stopping') sandbox = await waitForSandbox(provider, sandboxId, 'stopped', STOP_TIMEOUT_MS, deps);
  // With a coordinator, wake through it: it applies the pinned Pane version and gives the Session its
  // idle-stop grace. A resize, or a coordinator that is down or refuses, falls back to a direct resume.
  let coordinator: CoordinatorWakeResult | null = null;
  if (sandbox.state === 'stopped' && !args.size) {
    if (!args.json) deps.stdout(`runpane cloud: waking ${hostname} through the coordinator...`);
    coordinator = await deps.wakeViaCoordinator(record.profile.cloud.sessionId, timeoutMs);
    if (coordinator?.status === 'awake') {
      timings.coordinatorWakeMs = deps.now() - started;
      sandbox = await provider.get(sandboxId);
    } else if (coordinator && !args.json) {
      deps.stdout(`runpane cloud: the coordinator answered ${coordinator.status}${coordinator.detail ? ` (${coordinator.detail})` : ''}; resuming directly.`);
    }
  }
  const resumed = coordinator?.status === 'awake' || sandbox.state === 'stopped';
  if (sandbox.state === 'stopped') {
    if (!args.json) deps.stdout(`runpane cloud: waking ${hostname}...`);
    await provider.resume(sandboxId, args.size ? { size: args.size } : undefined);
    timings.resumeCallMs = deps.now() - started;
  }
  await waitForSandbox(provider, sandboxId, 'running', Math.max(timeoutMs - (deps.now() - started), 1_000), deps);
  timings.runningMs = deps.now() - started;
  if (!record.profile.baseUrl) throw new Error(`${hostname} has no daemon address yet; its setup never finished. Destroy it and create a new one.`);
  const remaining = () => Math.max(timeoutMs - (deps.now() - started), 1_000);
  // A healthy wake answers in 9-13 s; after that, check the node before waiting out the rest.
  let health = await deps.bootstrap.waitForDaemonHealth(record.profile.baseUrl, {
    token: record.profile.token,
    timeoutMs: Math.min(remaining(), WAKE_REPAIR_CHECK_MS),
    intervalMs: 500,
  });
  timings.healthMs = deps.now() - started;
  let repaired: { previousBackendState: string; oldNodeId: string; nodeId: string } | null = null;
  let serveRepaired = false;
  if (!health.ok) {
    // A resume can bring the node back logged out (tailscaled.state lost); re-enrol under the same name.
    const repair = await deps.bootstrap.repairTailnet(provider.handle(sandboxId), { hostname, oldNodeId: record.profile.cloud.nodeId }, tailnetCredentials);
    if (repair.reenrolled) {
      if (!args.json) deps.stdout(`runpane cloud: ${hostname}'s tailnet node came back logged out (${repair.previousBackendState}); re-enrolled it as ${repair.nodeId} under the same name.`);
      repaired = { previousBackendState: repair.previousBackendState, oldNodeId: record.profile.cloud.nodeId, nodeId: repair.nodeId };
      record.profile.cloud = { ...record.profile.cloud, nodeId: repair.nodeId, version: record.profile.cloud.version + 1 };
      await deps.store.writeHost(record);
      await importIntoDesktop(args, deps, [record.profile]);
      await pushDirectory(deps);
      health = await deps.bootstrap.waitForDaemonHealth(record.profile.baseUrl, { token: record.profile.token, timeoutMs: 90_000, intervalMs: 500 });
      timings.repairedHealthMs = deps.now() - started;
    } else {
      // Logged in but unreachable: a resume can bring back a stale tailscaled.state without the Serve config.
      const serve = await deps.bootstrap.repairServe(provider.handle(sandboxId), { transport: hostTransport(record) ?? 'https' });
      if (serve.serveApplied) {
        serveRepaired = true;
        if (!args.json) deps.stdout(`runpane cloud: ${hostname} came back without its Tailscale Serve config; re-applied it.`);
      }
      health = await deps.bootstrap.waitForDaemonHealth(record.profile.baseUrl, { token: record.profile.token, timeoutMs: remaining(), intervalMs: 500 });
      timings.healthMs = deps.now() - started;
    }
  }
  const devices = await tailnet.findDevicesByHostname(hostname);
  const sameNode = devices.some((device) => device.nodeId === record.profile.cloud.nodeId);
  // Grants changed while it slept are written now: a sleeping peer gets them when it wakes.
  const settings = await deps.store.readSettings();
  const peersFile = health.ok && (record.meta.peers?.length || settings.coordinator?.deployment)
    ? await pushPeersFile(record, await deps.store.listHosts(), deps, provider)
    : null;
  // So do guardrails changed while it slept (an empty list clears them).
  const guardrails = configuredGuardrails(settings);
  const agentNotes = health.ok && guardrails ? await pushAgentNotes(record, guardrails, deps) : null;
  if (agentNotes && !agentNotes.pushed && !args.json) deps.stderr(`runpane cloud: ${hostname}'s agent guardrails were not updated (${agentNotes.reason}).`);
  // And the coordinator's Pane pin, so the next coordinator wake can upgrade it.
  const deployment = settings.coordinator?.deployment;
  const panePin = health.ok && deployment ? await pushPanePin(record, deployment.pin ?? null, deps, provider) : null;
  if (panePin && !panePin.written && !args.json) deps.stderr(`runpane cloud: ${hostname}'s Pane pin was not updated (${panePin.reason}).`);
  // A Session that slept through a new pin refused the coordinator's upgrade; now that it holds the pin, ask again.
  let pinUpgrade: CoordinatorWakeResult | null = null;
  if (panePin?.written && deployment?.pin && health.version !== deployment.pin.version) {
    pinUpgrade = await deps.wakeViaCoordinator(record.profile.cloud.sessionId, remaining());
    if (pinUpgrade?.status === 'awake' && pinUpgrade.version) health = { ...health, version: pinUpgrade.version };
    else if (pinUpgrade && !args.json) deps.stderr(`runpane cloud: ${hostname} is not on the pinned Pane ${deployment.pin.version} yet (${pinUpgrade.detail ?? pinUpgrade.status}).`);
  }
  const summary = {
    ok: health.ok,
    host: hostname,
    status: (health.ok ? 'awake' : 'daemon-down') satisfies CloudHostStatus,
    resumed,
    baseUrl: record.profile.baseUrl,
    sameTailnetNode: sameNode,
    nodeIds: devices.map((device) => device.nodeId),
    version: health.version ?? null,
    coordinator,
    repaired,
    serveRepaired,
    peersFile,
    agentNotes,
    panePin,
    pinUpgrade,
    timings,
  };
  report(
    args,
    deps,
    summary,
    health.ok
      ? `${hostname} is awake at ${record.profile.baseUrl} (${((deps.now() - started) / 1000).toFixed(1)} s${repaired ? ', re-enrolled tailnet node' : sameNode ? ', same tailnet node' : ', TAILNET NODE CHANGED'}).`
      : `${hostname} is running but its daemon did not answer /health within ${Math.round(timeoutMs / 1000)} s.`,
  );
  return health.ok ? 0 : 1;
}

/**
 * `runpane cloud repair <host>`: brings an awake Session up to date without stopping it. Re-enrols a
 * logged-out node, installs the tailscaled.state and Serve guards (Sessions made by older CLIs lack
 * them) and re-applies a Tailscale Serve config a resume lost. Idempotent; never starts or stops a sandbox.
 */
async function runRepair(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const { provider, tailnetCredentials } = await loadCloudWithTailnet(deps, record);
  const { sandboxId, hostname } = record.profile.cloud;
  const sandbox = await provider.get(sandboxId);
  if (sandbox.state !== 'running') {
    throw new Error(`${hostname} is ${sandbox.state === 'stopped' ? 'asleep' : sandbox.providerState}; repair only works on an awake Session and never starts one. Wake it first: runpane cloud wake ${hostname}`);
  }
  const handle = provider.handle(sandboxId);
  const tailnetRepair = await deps.bootstrap.repairTailnet(handle, { hostname, oldNodeId: record.profile.cloud.nodeId }, tailnetCredentials);
  if (tailnetRepair.reenrolled) {
    record.profile.cloud = { ...record.profile.cloud, nodeId: tailnetRepair.nodeId, version: record.profile.cloud.version + 1 };
    await deps.store.writeHost(record);
    await importIntoDesktop(args, deps, [record.profile]);
    await pushDirectory(deps);
  }
  const transport = hostTransport(record) ?? 'https';
  const serve = await deps.bootstrap.repairServe(handle, { transport });
  const deployment = (await deps.store.readSettings()).coordinator?.deployment;
  const panePin = deployment ? await pushPanePin(record, deployment.pin ?? null, deps, provider) : null;
  const health = record.profile.baseUrl
    ? await deps.bootstrap.waitForDaemonHealth(record.profile.baseUrl, { token: record.profile.token, timeoutMs: 60_000, intervalMs: 1_000 })
    : { ok: false, elapsedMs: 0 };
  const done = [
    tailnetRepair.reenrolled ? `re-enrolled the tailnet node as ${tailnetRepair.nodeId}` : 'tailnet node ok',
    serve.serveApplied ? `re-applied the missing ${transport} Serve config` : `${transport} Serve config ok`,
    'tailscaled.state and Serve guards installed',
  ];
  if (panePin) done.push(panePin.written ? `Pane pin ${panePin.pinned ?? 'none'} written` : `Pane pin NOT written (${panePin.reason})`);
  report(
    args,
    deps,
    {
      ok: health.ok,
      host: hostname,
      transport,
      reenrolled: tailnetRepair.reenrolled,
      serveApplied: serve.serveApplied,
      guards: 'installed',
      panePin,
      health: { ok: health.ok, status: health.status ?? null, version: health.version ?? null },
    },
    `${hostname}: ${done.join('; ')}. /health ${health.ok ? 'answers' : 'does NOT answer'} at ${record.profile.baseUrl}.`,
  );
  return health.ok ? 0 : 1;
}

// ---------------------------------------------------------------- destroy

async function runDestroy(args: CloudArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) {
    throw new Error('runpane cloud destroy permanently deletes the sandbox, its disk and its tailnet device. Rerun with --yes to confirm.');
  }
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const { provider, tailnet } = await loadCloudWithTailnet(deps, record);
  const github = record.meta.github?.length ? await revokeGitHubGrants(record, deps) : undefined;
  if (github?.failed.length) {
    // Nothing is removed yet: the saved record keeps the keys' only handle, and a retry deletes what is left.
    throw new Error(`${record.profile.cloud.hostname} was not destroyed: GitHub deploy key${github.failed.length === 1 ? '' : 's'} ${github.failed.join(', ')} could not be deleted. Fix the GitHub credential (or delete the key${github.failed.length === 1 ? '' : 's'} as shown above) and rerun runpane cloud destroy ${record.profile.cloud.hostname} --yes.`);
  }
  const result = await destroyHost(record, provider, tailnet, deps);
  const desktop = await importIntoDesktop(args, deps, [], [record.profile.cloud.sessionId]);
  await deps.store.removeHost(record.profile.cloud.hostname);
  const peers = await forgetPeerGrants(record, deps);
  const coordinator = await pushDirectory(deps);
  if (!args.json) printCoordinatorOutcome(deps, coordinator);
  const summary = { ok: true, host: record.profile.cloud.hostname, ...result, desktop: desktopSummary(desktop), coordinator, peers };
  report(
    args,
    deps,
    github ? { ...summary, github } : summary,
    `${record.profile.cloud.hostname} destroyed: tailnet device${result.deletedNodeIds.length === 1 ? '' : 's'} ${result.deletedNodeIds.join(', ') || '(none)'} deleted, sandbox ${record.profile.cloud.sandboxId} ${result.sandbox}.${github?.deletedKeys.length ? ` GitHub deploy keys deleted: ${github.deletedKeys.join(', ')}.` : ''}${github?.pats.length ? ` Delete the personal access token it used for ${github.pats.join(', ')} at https://github.com/settings/personal-access-tokens.` : ''}`,
  );
  return 0;
}

/**
 * After a destroy: the Sessions it could message revoke its peer records (best effort: a sleeping one
 * keeps a record whose sender no longer exists), and Sessions that could message it drop the grant.
 */
async function forgetPeerGrants(destroyed: CloudHostRecord, deps: CloudDeps) {
  const host = destroyed.profile.cloud.hostname;
  const records = await deps.store.listHosts();
  const revoked: string[] = [];
  for (const grant of destroyed.meta.peers ?? []) {
    const target = records.find((record) => record.profile.cloud.hostname === grant.host);
    if (!target) continue;
    try {
      await deps.invokeDaemon(target.profile, 'runpane:peers:revoke', [{ peer: grant.peerId }], 30_000);
      revoked.push(grant.host);
    } catch (error) {
      deps.stderr(`runpane cloud: could not revoke ${host}'s peer record on ${grant.host} (${error instanceof Error ? error.message : String(error)}); run runpane cloud wake ${grant.host} and remove it with runpane --host ${grant.host} peers revoke --peer ${grant.peerId} --yes.`);
    }
  }
  const dropped: string[] = [];
  for (const record of records) {
    if (!record.meta.peers?.some((grant) => grant.host === host)) continue;
    record.meta.peers = record.meta.peers.filter((grant) => grant.host !== host);
    if (record.meta.peers.length === 0) delete record.meta.peers;
    await deps.store.writeHost(record);
    await pushPeersFile(record, records, deps);
    dropped.push(record.profile.cloud.hostname);
  }
  return { revokedOn: revoked, droppedFrom: dropped };
}

/** Tailnet device first, then the sandbox (a live node would otherwise linger as an orphan). */
async function destroyHost(record: CloudHostRecord, provider: CloudProvider, tailnet: TailnetPort, deps: CloudDeps) {
  const { hostname, nodeId, sandboxId } = record.profile.cloud;
  const deletedNodeIds = await deleteOwnedDevices(tailnet, hostname, nodeId, deps.stderr);
  await provider.destroy(sandboxId);
  const after = await provider.get(sandboxId);
  const remaining = deletableNodeIds(await tailnet.findDevicesByHostname(hostname)).nodeIds;
  if (remaining.length > 0) {
    throw new Error(`Tailnet devices for ${hostname} are still listed after delete: ${remaining.join(', ')}.`);
  }
  return { deletedNodeIds, sandbox: after.state === 'gone' ? 'deleted' : `deleting (${after.providerState})` };
}

// ---------------------------------------------------------------- pair / sync

async function runPair(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const code = await deps.store.readPairing(record.profile.cloud.hostname);
  decodePairingCode(code);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, host: record.profile.cloud.hostname, code }, null, 2));
  } else {
    deps.stderr('This code grants full control of the cloud Session. Paste it only into your own Pane app or https://runpane.com/app/.');
    deps.stdout(code);
  }
  return 0;
}

async function runSync(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const records = (await deps.store.listHosts()).filter((record) => record.profile.baseUrl && record.profile.token);
  const desktop = await syncDesktopProfiles({
    desktopDir: args.desktopDir ?? deps.env.RUNPANE_CLOUD_DESKTOP_DIR ?? deps.defaultDesktopDir,
    upsert: records.map((record) => record.profile),
  });
  const coordinator = await pushDirectory(deps);
  if (!args.json) printCoordinatorOutcome(deps, coordinator);
  report(
    args,
    deps,
    { ok: true, desktop: desktopSummary(desktop), coordinator },
    `Synced ${records.length} cloud host${records.length === 1 ? '' : 's'} into ${desktop.configPath} (added ${desktop.added.length}, updated ${desktop.updated.length}).`,
  );
  return 0;
}

// ---------------------------------------------------------------- shared helpers

function printCoordinatorOutcome(deps: CloudDeps, result: CoordinatorPushResult): void {
  if (result.pushed) {
    deps.stdout(`  coordinator: directory updated (${result.sessions} cloud Session${result.sessions === 1 ? '' : 's'}).`);
  } else if (result.reason !== NO_COORDINATOR) {
    deps.stderr(`runpane cloud: the coordinator's directory was not updated (${result.reason}). Retry with: runpane cloud sync`);
  }
}

async function importIntoDesktop(
  args: CloudArgs,
  deps: CloudDeps,
  upsert: CloudHostProfile[],
  removeSessionIds: string[] = [],
): Promise<DesktopImportResult | { skipped: string }> {
  if (args.noImport) return { skipped: '--no-import' };
  const explicit = args.desktopDir ?? deps.env.RUNPANE_CLOUD_DESKTOP_DIR;
  const desktopDir = explicit || deps.defaultDesktopDir;
  if (!explicit) {
    // Only touch a desktop that exists; a machine without Pane desktop gets instructions instead.
    try {
      await fs.access(`${desktopDir}/config.json`);
    } catch {
      return { skipped: `no Pane desktop config at ${desktopDir}/config.json` };
    }
  }
  try {
    return await syncDesktopProfiles({ desktopDir, upsert, removeSessionIds });
  } catch (error) {
    return { skipped: `could not update ${desktopDir}/config.json: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function desktopSummary(desktop: DesktopImportResult | { skipped: string }) {
  return 'skipped' in desktop
    ? { imported: false, reason: desktop.skipped }
    : { imported: true, configPath: desktop.configPath, added: desktop.added, updated: desktop.updated, removed: desktop.removed };
}

function printDesktopOutcome(deps: CloudDeps, desktop: DesktopImportResult | { skipped: string }, hostname: string): void {
  if ('skipped' in desktop) {
    deps.stdout(`  desktop: not imported (${desktop.skipped}). On the machine with Pane desktop, run \`runpane cloud sync\`, or paste the code from \`runpane cloud pair ${hostname}\` into Settings > Remote Pane.`);
  } else {
    deps.stdout(`  desktop: saved as a remote host in ${desktop.configPath}; pick it in Pane's host switcher.`);
  }
}

function hostSummary(record: CloudHostRecord) {
  return {
    hostname: record.profile.cloud.hostname,
    label: record.profile.label,
    sessionId: record.profile.cloud.sessionId,
    sandboxId: record.profile.cloud.sandboxId,
    nodeId: record.profile.cloud.nodeId,
    baseUrl: record.profile.baseUrl,
    transport: hostTransport(record),
    provider: record.profile.cloud.provider,
    boatOrg: record.meta.boatOrg ?? null,
    createdAt: record.meta.createdAt,
  };
}

/** https: Tailscale Serve with a TLS certificate. http: plain TCP Serve inside the tailnet (no certificate). */
function hostTransport(record: CloudHostRecord): 'https' | 'http' | undefined {
  if (record.profile.baseUrl.startsWith('https://')) return 'https';
  return record.profile.baseUrl.startsWith('http://') ? 'http' : undefined;
}

const HTTP_TRANSPORT_NOTE = 'plain HTTP inside the tailnet (WireGuard-encrypted; no TLS certificate, so the phone app at runpane.com/app cannot connect)';

/** A command's `--json` result; every one carries `ok`. */
interface CloudJsonResult {
  ok: boolean;
}

function report<Result extends CloudJsonResult>(args: CloudArgs, deps: CloudDeps, json: Result, text: string): void {
  deps.stdout(args.json ? JSON.stringify(json, null, 2) : text);
}

function requiredHost(args: CloudArgs): string {
  if (!args.host) throw new Error(`runpane cloud ${args.subcommand} needs a host.`);
  return args.host;
}

/** Credentials and a provider; given a host, the provider is scoped to the wallet that host bills. */
async function loadCloud(deps: CloudDeps, record?: CloudHostRecord) {
  const credentials = await deps.store.readCredentials();
  if (!credentials.boat) throw new Error('No boat API key saved. Run: runpane cloud setup --boat-key-file <path|->');
  if (!credentials.tailscale) {
    throw new Error('No Tailscale OAuth client saved. Run: runpane cloud setup --tailscale-client-id <id> --tailscale-secret-file <path|->');
  }
  const provider = record ? await hostProvider(deps, credentials, record) : deps.createProvider(credentials);
  return { credentials, provider, tailnetCredentials: credentials.tailscale };
}

async function loadCloudWithTailnet(deps: CloudDeps, record?: CloudHostRecord) {
  const loaded = await loadCloud(deps, record);
  return { ...loaded, tailnet: deps.bootstrap.createTailnet(loaded.tailnetCredentials) };
}

async function waitForSandbox(
  provider: CloudProvider,
  sandboxId: string,
  wanted: 'running' | 'stopped',
  timeoutMs: number,
  deps: CloudDeps,
): Promise<CloudSandbox> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const sandbox = await provider.get(sandboxId);
    if (sandbox.state === wanted) return sandbox;
    if (sandbox.state === 'gone' || sandbox.state === 'error') {
      throw new Error(`Sandbox ${sandboxId} is ${sandbox.providerState}${sandbox.error ? `: ${sandbox.error}` : ''}.`);
    }
    if (deps.now() >= deadline) {
      throw new Error(`Sandbox ${sandboxId} did not reach ${wanted} within ${Math.round(timeoutMs / 1000)} s (still ${sandbox.providerState}).`);
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  return [headers, ...rows]
    .map((row) => row.map((cell, column) => (cell ?? '').padEnd(widths[column])).join('  ').trimEnd())
    .join('\n');
}
