import { randomBytes } from 'node:crypto';
import { createBoatProvider } from './boat';
import {
  applyClaudeModel,
  applyGitHubToken,
  cloudHostname,
  provisionSandbox,
  pushStartupScript,
  readStartupLog,
  repairSandboxTailnet,
  setSandboxHostname,
  writeLocalEnv,
  GITHUB_AUTH_FAILED,
  type GitHubAuthStatus,
  runStartupScript,
  updateSandboxPane,
  type ClaudeModelOutcome,
  type CloudTransportMode,
  type ProvisionStepName,
  type StartupScriptStatus,
} from './bootstrap/provision';
import { createDefaultClaudeModelSource } from './claudeDefaults';
import { waitForDaemonHealth, type DaemonHealthResult } from './bootstrap/health';
import { PERSONAL_ORG, type BoatOrg, type CloudProvider, type CloudSandbox, type CloudSandboxState, type CloudSize, type SandboxHandle } from './provider';
import { createDesktopConfigHosts, type SavedRemoteHosts } from './savedHosts';
import {
  createCloudStore,
  DEFAULT_PANE_SOURCE,
  findHost,
  type CloudCredentials,
  type CloudHostRecord,
  type CloudStore,
  type PaneSource,
} from './store';
import {
  CLOUD_SESSION_TAG,
  createTailscaleApi,
  deletableNodeIds,
  deleteOwnedDevices,
  describeForeignDevice,
  type TailscaleApi,
  type TailscaleDevice,
  type TailscaleOAuthCredentials,
} from './tailscale';

/**
 * Cloud sandboxes: Pane daemons on boat.dev sandboxes, joined to the user's tailnet and saved as remote hosts.
 * The desktop main process and `runpane cloud` both drive this API; neither ever sees a secret value in a result,
 * a progress message or an error.
 */
export interface CloudSandboxes {
  /** Merges the given credentials into the saved ones, checks them against boat and Tailscale, then saves them (0600). */
  setup(input: CloudCredentialsInput): Promise<CloudCredentialsStatus>;
  getCredentialsStatus(): Promise<CloudCredentialsStatus>;
  /** Creates a sandbox, provisions it and saves it as a remote host. A failed create removes what it made. */
  create(options?: CloudCreateOptions, onProgress?: CloudProgressListener): Promise<CloudSandboxInfo>;
  /** Every saved sandbox with its provider state (one provider call per wallet); no daemon health. */
  list(): Promise<CloudSandboxInfo[]>;
  /** One sandbox with its provider state and, when it runs, its daemon's /health. */
  status(host: string): Promise<CloudSandboxInfo>;
  /** Snapshots the sandbox and powers it off (a stopped sandbox costs nothing). Waits until it is stopped. */
  stop(host: string, onProgress?: CloudProgressListener): Promise<CloudSandboxInfo>;
  /** Resumes the sandbox, repairs its tailnet node or Serve config when a resume lost them, and waits for /health. */
  start(host: string, onProgress?: CloudProgressListener): Promise<CloudSandboxInfo>;
  /** Installs another Pane .deb (https and sha256 required) on a running sandbox and restarts its daemon. */
  update(host: string, pane: { debUrl: string; sha256: string }, onProgress?: CloudProgressListener): Promise<CloudSandboxInfo>;
  /** Deletes the sandbox, its tailnet device, its saved remote host and its local record. */
  remove(host: string, onProgress?: CloudProgressListener): Promise<void>;
  /**
   * Gives a running sandbox the user's current Claude Code default model, so its next new Claude panel follows a
   * change. create, start and update do this too; call it after the user's default changes, e.g. on connect.
   */
  syncAgentDefaults(host: string): Promise<CloudSandboxInfo>;
  /**
   * Gives a running sandbox the user's current startup script and runs it once, waiting for it (up to its 10 minute
   * limit). `onlyIfChanged` skips the run when the last one used this script, e.g. the boot run of a start. Resolves
   * the latest run's status; null when no script has run.
   */
  runStartupScript(host: string, options?: { onlyIfChanged?: boolean }): Promise<StartupScriptStatus | null>;
  /** The last 200 lines of a running sandbox's startup log. It holds whatever the script printed: show it, never log it. */
  readStartupLog(host: string): Promise<string>;
}

/** Fields left undefined or empty keep what is saved. */
export interface CloudCredentialsInput {
  boatApiKey?: string;
  /** The boat wallet new sandboxes bill: an org id, its name or `personal`. */
  boatOrg?: string;
  tailscaleClientId?: string;
  tailscaleClientSecret?: string;
  /** Tailnet name; unset, the OAuth client's own tailnet. */
  tailnet?: string;
  /** A Claude subscription token (`claude setup-token`) that agents in every new sandbox sign in with. */
  claudeToken?: string;
  /** A GitHub personal access token that gh and git in every sandbox sign in with. */
  githubToken?: string;
}

export interface CloudCredentialsStatus {
  boat: { configured: boolean; org?: BoatOrg };
  tailscale: { configured: boolean };
  claude: { configured: boolean };
  github: { configured: boolean };
  /** boat and Tailscale are both configured: sandboxes can be created. */
  ready: boolean;
}

export interface CloudCreateOptions {
  label?: string;
  size?: CloudSize;
  /** The Pane to install; default the latest release through `runpane@latest`. */
  paneSource?: PaneSource;
  transport?: CloudTransportMode;
  /** The boat wallet to bill instead of the saved one (an org id, its name or `personal`). */
  boatOrg?: string;
  /** Keep the sandbox (and its record) when provisioning fails, for debugging. */
  keepOnFailure?: boolean;
  /** Prefix of the sandbox and tailnet host name (default `rp`): `<prefix>-<8 characters>`. */
  namePrefix?: string;
}

export type CloudProgressStep =
  | 'sandbox'
  | 'tailnet'
  | 'install'
  | 'pairing'
  | 'health'
  | 'saved-host'
  | 'startup'
  | 'stopping'
  | 'starting'
  | 'repair'
  | 'update'
  | 'removing'
  | 'done';

export interface CloudProgress {
  step: CloudProgressStep;
  /** User-facing and never secret. */
  message: string;
}

export type CloudProgressListener = (progress: CloudProgress) => void;

export interface CloudSandboxInfo {
  hostname: string;
  label: string;
  /** The saved remote host profile's id. */
  profileId: string;
  sessionId: string;
  sandboxId: string;
  state: CloudSandboxState;
  providerState: string;
  baseUrl: string;
  /** https: Tailscale Serve with a certificate; http: plain HTTP inside the tailnet (no certificate). */
  transport: 'https' | 'http';
  size?: CloudSize;
  createdAt: string;
  /** When this library last created or started the sandbox. */
  startedAt?: string;
  /** The Pane package version this library last installed (create or update); the daemon's /health does not report one. */
  daemonVersion?: string;
  org?: BoatOrg;
  health?: { ok: boolean; version?: string };
  /**
   * The model new Claude panels in the sandbox start with, after this call gave it the user's default, and what
   * happened; set by create, start, update and syncAgentDefaults. Absent when the user's default is unknown (a failed
   * detection): then nothing is sent and the sandbox keeps the model it had.
   */
  claudeModel?: { model: string | null; outcome: ClaudeModelOutcome };
  /** The local start script's run for this create or start; absent when the caller has no local start script (the CLI). */
  localStart?: LocalStartStatus;
  /** The sandbox's GitHub sign-in with the saved token, from create and start (`none` when no token is saved). */
  github?: GitHubAuthStatus;
  /** The user's startup script's run on create; absent when no script ran. */
  startupScript?: StartupScriptStatus;
}

/**
 * How the user's LOCAL start script went. `ok`: its variables went to the sandbox (count only; `reserved` = names it
 * printed that the sandbox keeps for itself, dropped). `none`: no script, so the sandbox has no variables from it.
 * `failed`, `timeout` and `error` (fixed text): the sandbox keeps the variables it had. Never a value.
 */
export type LocalStartStatus =
  | { state: 'ok'; keys: number; reserved: string[] }
  | { state: 'none' }
  | { state: 'failed'; exitCode: number }
  | { state: 'timeout'; seconds: number }
  | { state: 'error'; message: string };

/**
 * One run of the user's local start script for one sandbox. `envFile`: `export NAME='value'` lines for the sandbox,
 * '' to remove its variables, or null to leave them as they are (the run failed: a fetch that failed must not wipe
 * values that still work).
 */
export interface LocalStartEnv {
  status: LocalStartStatus;
  envFile: string | null;
}

/** The outside world, swappable in tests. */
export interface CloudSandboxesOptions {
  /** Credentials and host records; default `$RUNPANE_CLOUD_DIR`, else `~/.config/runpane-cloud`. */
  dir?: string;
  /** The desktop's saved remote hosts; default the desktop's config.json on disk. */
  savedHosts?: SavedRemoteHosts;
  store?: CloudStore;
  createProvider?: (apiKey: string, org?: string) => CloudProvider;
  createTailscale?: (credentials: TailscaleOAuthCredentials) => TailscaleApi;
  bootstrap?: CloudBootstrap;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Defaults for `create` that tests and pinned rollouts set without a UI: `RUNPANE_CLOUD_PANE_DEB_URL` with
   * `RUNPANE_CLOUD_PANE_DEB_SHA256` (the Pane .deb to install) and `RUNPANE_CLOUD_NAME_PREFIX`. Default process.env.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The user's default Claude model on this machine (default: createDefaultClaudeModelSource, explicit setting else
   * detected); null when it is unknown (detection failed), and then nothing is sent to the sandbox.
   */
  localClaudeModel?: () => Promise<string | null>;
  /**
   * The user's startup script, which create and start push to every sandbox (blank: none, so the sandbox's is removed).
   * Unset (the CLI), nothing is pushed and each sandbox keeps the script it has.
   */
  readStartupScript?: () => Promise<string>;
  /**
   * Runs the user's local start script on this computer for the sandbox being created or started, right then. Unset
   * (the CLI), no local start script runs and each sandbox keeps the variables it has.
   */
  readLocalStartEnv?: () => Promise<LocalStartEnv>;
}

export interface CloudBootstrap {
  provision: typeof provisionSandbox;
  repair: typeof repairSandboxTailnet;
  update: typeof updateSandboxPane;
  applyClaudeModel: typeof applyClaudeModel;
  setHostname: typeof setSandboxHostname;
  writeLocalEnv: typeof writeLocalEnv;
  applyGitHubToken: typeof applyGitHubToken;
  pushStartupScript: typeof pushStartupScript;
  runStartupScript: typeof runStartupScript;
  readStartupLog: typeof readStartupLog;
  waitForHealth: (baseUrl: string, options: { timeoutMs: number; intervalMs?: number }) => Promise<DaemonHealthResult>;
}

const SANDBOX_READY_TIMEOUT_MS = 180_000;
/** How long a resumed sandbox may take to run commands before the start goes on anyway. */
const COMMANDS_READY_TIMEOUT_MS = 120_000;
const GITHUB_APPLY_ATTEMPTS = 3;
const GITHUB_APPLY_RETRY_MS = 5_000;
const LOCAL_START_FAILED = "Pane couldn't run the local start script.";
const LOCAL_ENV_NOT_SENT = "Couldn't send the local start script's variables to the sandbox.";
/**
 * How long a Stop boat accepted may take. boat snapshots the disk before it powers off ("archiving"), and has taken
 * over 5 minutes; until it is stopped that is progress, not a failure.
 */
const STOP_TIMEOUT_MS = 15 * 60_000;
/** The progress text while boat saves the sandbox (desktop shows it as is). */
const SAVING_MESSAGE = 'Saving the sandbox…';
/** How long a delete boat accepted (202) may take to finish; until boat stops listing the sandbox, it isn't removed. */
const REMOVE_CONFIRM_TIMEOUT_MS = 3 * 60_000;
const REMOVE_POLL_MS = 2_000;
const START_HEALTH_CHECK_MS = 30_000;
const REPAIRED_HEALTH_TIMEOUT_MS = 90_000;
const CREATE_HEALTH_TIMEOUT_MS = 180_000;
const UPDATE_HEALTH_TIMEOUT_MS = 120_000;
const STATUS_HEALTH_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_NAME_PREFIX = 'rp';
const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function createCloudSandboxes(options: CloudSandboxesOptions = {}): CloudSandboxes {
  const store = options.store ?? createCloudStore(options.dir);
  const savedHosts = options.savedHosts ?? createDesktopConfigHosts();
  const createProvider = options.createProvider ?? ((apiKey: string, org?: string) => createBoatProvider({ apiKey, org }));
  const createTailscale = options.createTailscale ?? ((credentials: TailscaleOAuthCredentials) => createTailscaleApi(credentials));
  const bootstrap: CloudBootstrap = options.bootstrap ?? {
    provision: provisionSandbox,
    repair: repairSandboxTailnet,
    update: updateSandboxPane,
    applyClaudeModel,
    setHostname: setSandboxHostname,
    writeLocalEnv,
    applyGitHubToken,
    pushStartupScript,
    runStartupScript,
    readStartupLog,
    waitForHealth: (baseUrl, healthOptions) => waitForDaemonHealth(baseUrl, healthOptions),
  };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const localClaudeModel = options.localClaudeModel ?? createDefaultClaudeModelSource({ env });

  /**
   * After a start or an update the sandbox is already usable, so a failure here is reported, not thrown: the
   * sandbox keeps the model it had, and the next start, update or syncAgentDefaults tries again.
   */
  async function syncClaudeModelBestEffort(handle: SandboxHandle, label: string, step: CloudProgressStep, onProgress?: CloudProgressListener) {
    const report = (message: string) => onProgress?.({ step, message });
    try {
      return await syncClaudeModel(handle, report);
    } catch (error) {
      report(`${label} kept its Claude model: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** The user's default Claude model into the sandbox; new panels start with it (see applyClaudeModel). */
  async function syncClaudeModel(handle: SandboxHandle, report: (message: string) => void) {
    const model = await localClaudeModel();
    if (model === null) {
      // Unknown is not "Claude's own default": a failed detection must not undo a model given earlier.
      report('Your Claude Code default model is unknown right now, so the sandbox keeps the model it has.');
      return undefined;
    }
    report(`Using your Claude Code default model (${model})...`);
    return bootstrap.applyClaudeModel(handle, model);
  }

  /**
   * Pushes the user's startup script; false when there is no reader or the push failed (reported, never thrown: a
   * script must never cost the user a sandbox or a start). Resolves whether a script is now in place.
   */
  async function pushStartupScriptBestEffort(handle: SandboxHandle, report: (message: string) => void, failure: string): Promise<boolean> {
    if (!options.readStartupScript) return false;
    try {
      const pushed = await bootstrap.pushStartupScript(handle, await options.readStartupScript());
      return pushed.sha256 !== null;
    } catch (error) {
      report(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** A resume lands on a pool machine with its own OS name; give it the sandbox's again. Reported, never thrown. */
  async function setHostnameBestEffort(handle: SandboxHandle, record: CloudHostRecord, report: (message: string) => void): Promise<void> {
    try {
      await bootstrap.setHostname(handle, record.profile.cloud.hostname);
    } catch (error) {
      report(`${record.profile.label} kept the OS name it came back with: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Signs the sandbox's gh and git in with the saved GitHub token. Never throws (the sandbox works without GitHub), and
   * never puts the token in a message: a failure is reported with fixed text.
   */
  async function applyGitHubBestEffort(handle: SandboxHandle, credentials: CloudCredentials): Promise<GitHubAuthStatus> {
    // A sandbox that just resumed can fail a command or two while it settles: try again before warning about GitHub.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await bootstrap.applyGitHubToken(handle, credentials.github?.token);
      } catch {
        if (attempt >= GITHUB_APPLY_ATTEMPTS) return { state: 'error', message: GITHUB_AUTH_FAILED };
        await sleep(GITHUB_APPLY_RETRY_MS);
      }
    }
  }

  /**
   * Waits until a resumed sandbox runs commands: boat reports it running before its command service answers, and the
   * steps after a start (OS name, GitHub, local env, startup script) all go through it. Gives up quietly at the limit;
   * each step then reports its own failure.
   */
  async function waitForCommands(handle: SandboxHandle): Promise<void> {
    const deadline = now() + COMMANDS_READY_TIMEOUT_MS;
    for (;;) {
      try {
        const answer = await handle.runScript('true', { timeoutSeconds: 15 });
        if (answer.exitCode === 0) return;
      } catch {
        // not ready yet
      }
      if (now() >= deadline) return;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Runs the local start script for one sandbox; a throw becomes a fixed-text error (never output or values). */
  async function runLocalStart(): Promise<LocalStartEnv | undefined> {
    if (!options.readLocalStartEnv) return undefined;
    try {
      return await options.readLocalStartEnv();
    } catch {
      return { status: { state: 'error', message: LOCAL_START_FAILED }, envFile: null };
    }
  }

  /** Sends a local start script's result to this one sandbox. Reported, never thrown: the sandbox works without it. */
  async function applyLocalStart(handle: SandboxHandle, run: LocalStartEnv): Promise<LocalStartStatus> {
    if (run.envFile === null) return run.status;
    try {
      const written = await bootstrap.writeLocalEnv(handle, run.envFile);
      if (run.status.state !== 'ok') return run.status;
      return { state: 'ok', keys: written.keys, reserved: [...new Set([...run.status.reserved, ...written.reserved])].sort() };
    } catch {
      return { state: 'error', message: LOCAL_ENV_NOT_SENT };
    }
  }

  async function loadRunningHost(host: string, stoppedMessage: string) {
    const loaded = await loadHost(host);
    const sandbox = await loaded.provider.get(loaded.record.profile.cloud.sandboxId);
    if (sandbox.state !== 'running') throw new Error(`${loaded.record.profile.label} is ${sandbox.state}; ${stoppedMessage}.`);
    return { ...loaded, handle: loaded.provider.handle(sandbox.id) };
  }

  async function credentialsStatus(): Promise<CloudCredentialsStatus> {
    const credentials = await store.readCredentials();
    const settings = await store.readSettings();
    const status: CloudCredentialsStatus = {
      boat: { configured: Boolean(credentials.boat) },
      tailscale: { configured: Boolean(credentials.tailscale) },
      claude: { configured: Boolean(credentials.claude) },
      github: { configured: Boolean(credentials.github) },
      ready: Boolean(credentials.boat && credentials.tailscale),
    };
    if (settings.boatOrg) status.boat.org = settings.boatOrg;
    return status;
  }

  async function loadCloud() {
    const credentials = await store.readCredentials();
    if (!credentials.boat) throw new Error('No boat API key is saved. Add it in Settings > Remote Access, or run runpane cloud setup.');
    if (!credentials.tailscale) throw new Error('No Tailscale OAuth client is saved. Add it in Settings > Remote Access, or run runpane cloud setup.');
    return { credentials, boatKey: credentials.boat.apiKey, tailscale: credentials.tailscale };
  }

  async function loadHost(host: string) {
    const loaded = await loadCloud();
    const record = findHost(await store.listHosts(), host);
    return { ...loaded, record, provider: createProvider(loaded.boatKey, record.meta.boatOrg?.id) };
  }

  /**
   * Waits for a Stop boat accepted. `archiving` (stopping) is the normal way to stopped and only reports progress;
   * boat's error state, a sandbox boat no longer has, or the long ceiling fail the Stop.
   */
  async function waitForStopped(provider: CloudProvider, record: CloudHostRecord, onProgress?: CloudProgressListener): Promise<CloudSandbox> {
    const { sandboxId } = record.profile.cloud;
    const { label } = record.profile;
    const deadline = now() + STOP_TIMEOUT_MS;
    let saving = false;
    for (;;) {
      const sandbox = await provider.get(sandboxId);
      if (sandbox.state === 'stopped') return sandbox;
      if (sandbox.state === 'gone') throw new Error(`boat no longer has ${label}'s sandbox ${sandboxId}; it was removed while stopping.`);
      if (sandbox.state === 'error') {
        throw new Error(`boat reported an error while stopping ${label} (${sandbox.providerState}${sandbox.error ? `: ${sandbox.error}` : ''}).`);
      }
      if (sandbox.state === 'stopping' && !saving) {
        saving = true;
        onProgress?.({ step: 'stopping', message: SAVING_MESSAGE });
      }
      if (now() >= deadline) {
        throw new Error(`${label} was still ${sandbox.providerState} after ${Math.round(STOP_TIMEOUT_MS / 60_000)} min; boat may still finish stopping it. Check its state again later.`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async function waitForSandbox(provider: CloudProvider, sandboxId: string, wanted: 'running' | 'stopped', timeoutMs: number): Promise<CloudSandbox> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const sandbox = await provider.get(sandboxId);
      if (sandbox.state === wanted) return sandbox;
      if (sandbox.state === 'gone' || sandbox.state === 'error') {
        throw new Error(`Sandbox ${sandboxId} is ${sandbox.providerState}${sandbox.error ? `: ${sandbox.error}` : ''}.`);
      }
      if (now() >= deadline) {
        throw new Error(`Sandbox ${sandboxId} did not reach ${wanted} within ${Math.round(timeoutMs / 1000)} s (still ${sandbox.providerState}).`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Tailnet devices first, then the sandbox (a live node would otherwise linger as an orphan). */
  /**
   * Deletes the sandbox and its tailnet node, and returns only once both are confirmed gone. boat accepts a delete
   * (202) and finishes it later; its calls are scoped to the host's wallet, where a sandbox in another wallet also
   * answers 404, so a scoped 404 is double-checked without the wallet before it counts as gone. The recorded node is
   * deleted and checked by id (a name search misses a renamed node), and the name is swept again at the end for a
   * node that rejoined while the sandbox still ran. Anything left over throws "Remove didn't finish: …", so the
   * caller keeps the record (and the row).
   */
  async function destroyHost(
    record: CloudHostRecord,
    provider: CloudProvider,
    tailnet: TailscaleApi,
    onProgress?: CloudProgressListener,
  ): Promise<void> {
    const { hostname, nodeId, sandboxId } = record.profile.cloud;
    const { label } = record.profile;
    const progress = (message: string) => onProgress?.({ step: 'removing', message });

    // The recorded node id is deleted only when that device is this sandbox's: its name AND runpane's tag. A wrong
    // id (another sandbox's node, a member's machine) stops the remove before anything is deleted.
    const belongsHere = (device: TailscaleDevice) => (device.tags ?? []).includes(CLOUD_SESSION_TAG)
      && [device.hostname, device.name.split('.')[0]].some((name) => name.toLowerCase() === hostname.toLowerCase());
    const recordedNode = nodeId ? await tailnet.getDevice(nodeId) : null;
    if (recordedNode && !belongsHere(recordedNode)) {
      throw new Error(`Remove didn't finish: the recorded tailnet device doesn't belong to this sandbox: ${nodeId} is `
        + `${describeForeignDevice(recordedNode)}, not ${hostname} tagged ${CLOUD_SESSION_TAG}. Nothing was deleted.`);
    }

    let sandboxGone = (await provider.get(sandboxId)).state === 'gone';
    if (sandboxGone) {
      const anywhere = await provider.getWithoutWallet(sandboxId);
      if (anywhere.state !== 'gone') {
        throw new Error(`Remove didn't finish: boat doesn't show ${label}'s sandbox ${sandboxId} in this host's wallet `
          + `(${record.meta.boatOrg?.name ?? 'boat\'s active wallet'}), but it still exists (${anywhere.providerState}). Check the wallet and try Remove again.`);
      }
      progress(`boat no longer has ${label}'s sandbox; removing what is left...`);
    }

    if (recordedNode) {
      const deleted = await tailnet.deleteDevice(recordedNode.nodeId);
      progress(`Tailnet node ${nodeId}: ${deleted ? 'deleted' : 'already gone'}.`);
    } else if (nodeId) {
      progress(`Tailnet node ${nodeId}: already gone.`);
    }
    await deleteOwnedDevices(tailnet, hostname, undefined, () => undefined);

    if (!sandboxGone) {
      await provider.destroy(sandboxId);
      progress(`boat accepted the delete of ${sandboxId}.`);
    }
    const deadline = now() + REMOVE_CONFIRM_TIMEOUT_MS;
    for (let waiting = false; !sandboxGone; waiting = true) {
      const sandbox = await provider.get(sandboxId);
      sandboxGone = sandbox.state === 'gone';
      if (sandboxGone) break;
      if (now() >= deadline) {
        throw new Error(`Remove didn't finish: boat still lists ${label}'s sandbox ${sandboxId} (${sandbox.providerState}) `
          + `${REMOVE_CONFIRM_TIMEOUT_MS / 60_000} minutes after accepting the delete. Try Remove again.`);
      }
      if (!waiting) progress(`Waiting for boat to finish removing ${label}...`);
      await sleep(REMOVE_POLL_MS);
    }
    progress(`boat no longer lists ${sandboxId}.`);

    // The sandbox can't rejoin any more: sweep again for a node that came back while it was still running.
    await deleteOwnedDevices(tailnet, hostname, undefined, () => undefined);
    if (recordedNode && await tailnet.getDevice(recordedNode.nodeId)) {
      throw new Error(`Remove didn't finish: the tailnet still lists ${hostname}'s node ${nodeId} after deleting it. Try Remove again.`);
    }
    const remaining = deletableNodeIds(await tailnet.findDevicesByHostname(hostname), [CLOUD_SESSION_TAG]).nodeIds;
    if (remaining.length > 0) {
      throw new Error(`Remove didn't finish: tailnet devices for ${hostname} are still listed after delete: ${remaining.join(', ')}. Try Remove again.`);
    }
    progress(`No tailnet node is left for ${hostname}.`);
  }

  return {
    async setup(input) {
      const credentials = await store.readCredentials();
      const settings = await store.readSettings();
      const boatApiKey = nonEmpty(input.boatApiKey);
      if (boatApiKey) credentials.boat = { apiKey: boatApiKey };
      const clientId = nonEmpty(input.tailscaleClientId) ?? credentials.tailscale?.clientId;
      const clientSecret = nonEmpty(input.tailscaleClientSecret) ?? credentials.tailscale?.clientSecret;
      const tailnet = nonEmpty(input.tailnet) ?? credentials.tailscale?.tailnet;
      const tailscaleChanged = Boolean(nonEmpty(input.tailscaleClientId) || nonEmpty(input.tailscaleClientSecret) || nonEmpty(input.tailnet));
      if (tailscaleChanged) {
        if (!clientId || !clientSecret) throw new Error('The Tailscale OAuth client needs both its client id and its secret.');
        credentials.tailscale = tailnet ? { clientId, clientSecret, tailnet } : { clientId, clientSecret };
      }
      const claudeToken = nonEmpty(input.claudeToken);
      if (claudeToken) credentials.claude = { oauthToken: claudeToken };
      const githubToken = nonEmpty(input.githubToken);
      if (githubToken) credentials.github = { token: githubToken };

      const wantedOrg = nonEmpty(input.boatOrg);
      if (wantedOrg && !credentials.boat) throw new Error('Choosing a boat wallet needs the boat API key.');
      if (credentials.boat && (boatApiKey || wantedOrg)) {
        const provider = createProvider(credentials.boat.apiKey);
        try {
          await provider.verifyCredentials();
        } catch (error) {
          throw new Error(`The boat API key was not accepted: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (wantedOrg) settings.boatOrg = await resolveBoatOrg(provider, wantedOrg);
      }
      if (credentials.tailscale && tailscaleChanged) {
        try {
          await createTailscale(credentials.tailscale).listDevices();
        } catch (error) {
          throw new Error(`The Tailscale OAuth client was not accepted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await store.writeCredentials(credentials);
      await store.writeSettings(settings);
      return credentialsStatus();
    },

    getCredentialsStatus: credentialsStatus,

    async create(createOptions = {}, onProgress) {
      const progress = (step: CloudProgressStep, message: string) => onProgress?.({ step, message });
      const { credentials, boatKey, tailscale } = await loadCloud();
      const settings = await store.readSettings();
      const org = createOptions.boatOrg
        ? await resolveBoatOrg(createProvider(boatKey), createOptions.boatOrg)
        : settings.boatOrg;
      const provider = createProvider(boatKey, org?.id);
      const size = createOptions.size ?? 'default';
      const paneSource = createOptions.paneSource ?? paneSourceFromEnv(env) ?? DEFAULT_PANE_SOURCE;
      const sessionId = randomSessionId();
      const hostname = cloudHostname(sessionId, createOptions.namePrefix ?? nonEmpty(env.RUNPANE_CLOUD_NAME_PREFIX) ?? DEFAULT_NAME_PREFIX);
      const label = createOptions.label?.trim() || hostname;
      const startedAt = new Date(now()).toISOString();

      progress('sandbox', `Creating a ${size} sandbox ${hostname}...`);
      const sandbox = await provider.create({ name: hostname, size, org: org?.id, idempotencyKey: `runpane-cloud-new-${sessionId}` });
      // Recorded before provisioning, so a failure part-way still leaves something remove() can find.
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
        meta: { createdAt: startedAt, startedAt, size, magicDnsName: '', paneSource },
      };
      const billedOrg = sandbox.org ?? org;
      if (billedOrg) record.meta.boatOrg = billedOrg;
      await store.writeHost(record);

      let health: DaemonHealthResult;
      let claudeModel: CloudSandboxInfo['claudeModel'];
      let github: GitHubAuthStatus = { state: 'none' };
      const localRun = await runLocalStart();
      let localStart = localRun?.status;
      try {
        if (sandbox.name !== hostname) await provider.rename(sandbox.id, hostname);
        const ready = await waitForSandbox(provider, sandbox.id, 'running', SANDBOX_READY_TIMEOUT_MS);
        if (ready.org) record.meta.boatOrg = ready.org;
        if (org && record.meta.boatOrg && record.meta.boatOrg.id !== org.id) {
          throw new Error(`boat billed ${describeOrg(record.meta.boatOrg)} instead of the requested ${describeOrg(org)}.`);
        }
        progress('tailnet', `Sandbox ${sandbox.id} is up; joining your tailnet...`);
        const outcome = await bootstrap.provision(provider.handle(sandbox.id), {
          sessionId,
          label,
          hostname,
          tailscale: createTailscale(tailscale),
          paneSource,
          agentEnv: agentEnvironment(credentials),
          localEnv: localRun?.envFile ?? undefined,
          transport: createOptions.transport ?? 'auto',
          healthTimeoutMs: CREATE_HEALTH_TIMEOUT_MS,
          onStep: (step) => {
            if (step.state === 'start') progress(progressStepFor(step.step), describeStep(step.step));
          },
        });
        health = outcome.health;
        record.profile = {
          ...record.profile,
          baseUrl: outcome.pairing.baseUrl,
          token: outcome.pairing.token,
          cloud: { ...record.profile.cloud, nodeId: outcome.nodeId },
        };
        if (outcome.pairing.tunnel?.kind === 'tailscale') {
          record.profile.tunnel = { kind: 'tailscale', selected: true };
          if (outcome.pairing.tunnel.note) record.profile.tunnel.note = outcome.pairing.tunnel.note;
        }
        record.meta.magicDnsName = outcome.magicDnsName;
        if (outcome.daemonVersion) record.meta.daemonVersion = outcome.daemonVersion;
        await store.writeHost(record);
        claudeModel = await syncClaudeModel(provider.handle(sandbox.id), (message) => progress('install', message));
        if (credentials.github) progress('install', 'Signing in to GitHub with your token...');
        github = await applyGitHubBestEffort(provider.handle(sandbox.id), credentials);
        progress('saved-host', `Saving ${label} as a remote host...`);
        await savedHosts.upsert(record.profile);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!createOptions.keepOnFailure) {
          progress('removing', `Setup failed; removing ${hostname}...`);
          try {
            await destroyHost(record, provider, createTailscale(tailscale));
            await store.removeHost(hostname);
          } catch (cleanupError) {
            throw new Error(`Creating ${hostname} failed (${reason}), and removing it failed too (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}). Remove it with runpane cloud remove ${hostname}.`);
          }
        }
        throw new Error(`Creating ${hostname} failed: ${reason}`);
      }
      // The sandbox is ready and saved; the user's script runs last, and its failure is shown, never thrown.
      let startupScript: StartupScriptStatus | null = null;
      const handle = provider.handle(sandbox.id);
      const couldNotRun = 'Your startup script could not run';
      if (await pushStartupScriptBestEffort(handle, (message) => progress('startup', message), couldNotRun)) {
        progress('startup', 'Running your startup script…');
        try {
          startupScript = (await bootstrap.runStartupScript(handle, 'always')).status;
        } catch (error) {
          progress('startup', `${couldNotRun}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      progress('done', `${label} is ready at ${record.profile.baseUrl}.`);
      const created: CloudSandboxInfo = { ...sandboxInfo(record, await provider.get(sandbox.id), health, claudeModel, startupScript), github };
      if (localStart) created.localStart = localStart;
      return created;
    },

    async list() {
      const records = await store.listHosts();
      if (records.length === 0) return [];
      const { boatKey } = await loadCloud();
      // One list call per wallet the records bill, each scoped to that wallet.
      const sandboxes = new Map<string, CloudSandbox>();
      for (const org of new Set(records.map((record) => record.meta.boatOrg?.id))) {
        for (const sandbox of await createProvider(boatKey, org).list()) sandboxes.set(sandbox.id, sandbox);
      }
      return records.map((record) => sandboxInfo(record, sandboxes.get(record.profile.cloud.sandboxId)));
    },

    async status(host) {
      const { record, provider } = await loadHost(host);
      const sandbox = await provider.get(record.profile.cloud.sandboxId);
      const health = sandbox.state === 'running' && record.profile.baseUrl
        ? await bootstrap.waitForHealth(record.profile.baseUrl, { timeoutMs: STATUS_HEALTH_TIMEOUT_MS, intervalMs: 1_000 })
        : undefined;
      return sandboxInfo(record, sandbox, health);
    },

    async stop(host, onProgress) {
      const { record, provider } = await loadHost(host);
      const { sandboxId, hostname } = record.profile.cloud;
      const sandbox = await provider.get(sandboxId);
      if (sandbox.state === 'gone') throw new Error(`The provider no longer has ${hostname}'s sandbox ${sandboxId}.`);
      if (sandbox.state === 'stopped') return sandboxInfo(record, sandbox);
      onProgress?.({ step: 'stopping', message: `Stopping ${record.profile.label}...` });
      if (sandbox.state === 'running') {
        // boat powers off right after its snapshot, with no SIGTERM: flush the page cache first. Best effort.
        await provider.handle(sandboxId).runScript('sync; sleep 0.2; sync', { timeoutSeconds: 30 }).catch(() => undefined);
      }
      if (sandbox.state !== 'stopping') await provider.stop(sandboxId);
      const stopped = await waitForStopped(provider, record, onProgress);
      onProgress?.({ step: 'done', message: `${record.profile.label} is stopped.` });
      return sandboxInfo(record, stopped);
    },

    async start(host, onProgress) {
      const { record, provider, tailscale, credentials } = await loadHost(host);
      const { sandboxId, hostname } = record.profile.cloud;
      if (!record.profile.baseUrl) throw new Error(`${hostname} never finished its setup. Remove it and create a new one.`);
      let sandbox = await provider.get(sandboxId);
      if (sandbox.state === 'gone' || sandbox.state === 'error') {
        throw new Error(`${hostname} is lost: the provider reports ${sandbox.providerState} for ${sandboxId}.`);
      }
      onProgress?.({ step: 'starting', message: `Starting ${record.profile.label}...` });
      if (sandbox.state === 'stopping') sandbox = await waitForSandbox(provider, sandboxId, 'stopped', STOP_TIMEOUT_MS);
      if (sandbox.state === 'stopped') {
        await provider.resume(sandboxId);
        record.meta.startedAt = new Date(now()).toISOString();
        await store.writeHost(record);
      }
      sandbox = await waitForSandbox(provider, sandboxId, 'running', SANDBOX_READY_TIMEOUT_MS);
      await waitForCommands(provider.handle(sandboxId));
      await setHostnameBestEffort(provider.handle(sandboxId), record, (message) => onProgress?.({ step: 'starting', message }));
      const github = await applyGitHubBestEffort(provider.handle(sandboxId), credentials);
      // Fresh variables for THIS sandbox only, before its startup script runs with them.
      const localRun = await runLocalStart();
      const localStart = localRun ? await applyLocalStart(provider.handle(sandboxId), localRun) : undefined;
      // The boot already ran the script the sandbox had; an edit since then runs through runStartupScript.
      await pushStartupScriptBestEffort(provider.handle(sandboxId), (message) => onProgress?.({ step: 'starting', message }),
        'Your startup script could not be updated');
      // A healthy start answers in about 10 s; after that, check the node before waiting longer.
      let health = await bootstrap.waitForHealth(record.profile.baseUrl, { timeoutMs: START_HEALTH_CHECK_MS, intervalMs: 500 });
      if (!health.ok) {
        onProgress?.({ step: 'repair', message: `${record.profile.label} is not answering yet; checking its tailnet node...` });
        const repair = await bootstrap.repair(provider.handle(sandboxId), {
          hostname,
          tailscale: createTailscale(tailscale),
          oldNodeId: record.profile.cloud.nodeId || undefined,
          transport: hostTransport(record),
        });
        if (repair.reenrolled) {
          // Same MagicDNS name and address; only the node id changes.
          record.profile.cloud = { ...record.profile.cloud, nodeId: repair.nodeId, version: record.profile.cloud.version + 1 };
          await store.writeHost(record);
          await savedHosts.upsert(record.profile);
        }
        health = await bootstrap.waitForHealth(record.profile.baseUrl, { timeoutMs: REPAIRED_HEALTH_TIMEOUT_MS, intervalMs: 500 });
      }
      if (!health.ok) throw new Error(`${record.profile.label} is running, but its Pane daemon did not answer at ${record.profile.baseUrl}.`);
      const claudeModel = await syncClaudeModelBestEffort(provider.handle(sandboxId), record.profile.label, 'starting', onProgress);
      onProgress?.({ step: 'done', message: `${record.profile.label} is running.` });
      const started: CloudSandboxInfo = { ...sandboxInfo(record, sandbox, health, claudeModel), github };
      if (localStart) started.localStart = localStart;
      return started;
    },

    async update(host, pane, onProgress) {
      const { record, provider } = await loadHost(host);
      const { sandboxId } = record.profile.cloud;
      const sandbox = await provider.get(sandboxId);
      if (sandbox.state !== 'running') throw new Error(`${record.profile.label} is ${sandbox.state}; start it before updating Pane.`);
      onProgress?.({ step: 'update', message: `Installing Pane on ${record.profile.label}...` });
      const installed = await bootstrap.update(provider.handle(sandboxId), pane);
      const health = await bootstrap.waitForHealth(record.profile.baseUrl, { timeoutMs: UPDATE_HEALTH_TIMEOUT_MS, intervalMs: 1_000 });
      if (!health.ok) throw new Error(`Pane was installed on ${record.profile.label}, but its daemon did not come back at ${record.profile.baseUrl}.`);
      const version = health.version ?? installed.version;
      if (version) record.meta.daemonVersion = version;
      record.meta.paneSource = { kind: 'deb-url', url: pane.debUrl, sha256: pane.sha256 };
      await store.writeHost(record);
      // Older sandboxes get the OS name (and its boot unit) here.
      await setHostnameBestEffort(provider.handle(sandboxId), record, (message) => onProgress?.({ step: 'update', message }));
      const claudeModel = await syncClaudeModelBestEffort(provider.handle(sandboxId), record.profile.label, 'update', onProgress);
      onProgress?.({ step: 'done', message: `${record.profile.label} runs Pane ${version ?? '(version unknown)'}.` });
      return sandboxInfo(record, sandbox, health, claudeModel);
    },

    async syncAgentDefaults(host) {
      const { record, provider } = await loadHost(host);
      const sandbox = await provider.get(record.profile.cloud.sandboxId);
      if (sandbox.state !== 'running') throw new Error(`${record.profile.label} is ${sandbox.state}; it gets your default model when it starts.`);
      return sandboxInfo(record, sandbox, undefined, await syncClaudeModel(provider.handle(sandbox.id), () => undefined));
    },

    async runStartupScript(host, runOptions = {}) {
      const { handle } = await loadRunningHost(host, 'it runs your startup script when it starts');
      // Running the old script after a failed push would report on the wrong script: let the push fail the run.
      if (options.readStartupScript) await bootstrap.pushStartupScript(handle, await options.readStartupScript());
      return (await bootstrap.runStartupScript(handle, runOptions.onlyIfChanged ? 'if-changed' : 'always')).status;
    },

    async readStartupLog(host) {
      const { handle } = await loadRunningHost(host, 'start it to read its startup log');
      return bootstrap.readStartupLog(handle);
    },

    async remove(host, onProgress) {
      const { record, provider, tailscale } = await loadHost(host);
      onProgress?.({ step: 'removing', message: `Removing ${record.profile.label}...` });
      await destroyHost(record, provider, createTailscale(tailscale), onProgress);
      await savedHosts.remove(record.profile.cloud.sessionId);
      await store.removeHost(record.profile.cloud.hostname);
      onProgress?.({ step: 'done', message: `${record.profile.label} is removed.` });
    },
  };
}

function sandboxInfo(
  record: CloudHostRecord,
  sandbox?: CloudSandbox,
  health?: DaemonHealthResult,
  claudeModel?: CloudSandboxInfo['claudeModel'],
  startupScript?: StartupScriptStatus | null,
): CloudSandboxInfo {
  const info: CloudSandboxInfo = {
    hostname: record.profile.cloud.hostname,
    label: record.profile.label,
    profileId: record.profile.id,
    sessionId: record.profile.cloud.sessionId,
    sandboxId: record.profile.cloud.sandboxId,
    state: sandbox?.state ?? 'gone',
    providerState: sandbox?.providerState ?? 'not_found',
    baseUrl: record.profile.baseUrl,
    transport: hostTransport(record),
    size: sandbox?.size ?? record.meta.size,
    createdAt: record.meta.createdAt,
  };
  if (record.meta.startedAt) info.startedAt = record.meta.startedAt;
  if (record.meta.daemonVersion) info.daemonVersion = record.meta.daemonVersion;
  const org = sandbox?.org ?? record.meta.boatOrg;
  if (org) info.org = org;
  if (health) info.health = health.version ? { ok: health.ok, version: health.version } : { ok: health.ok };
  if (claudeModel) info.claudeModel = claudeModel;
  if (startupScript) info.startupScript = startupScript;
  return info;
}

function paneSourceFromEnv(env: NodeJS.ProcessEnv): PaneSource | undefined {
  const url = nonEmpty(env.RUNPANE_CLOUD_PANE_DEB_URL);
  if (!url) return undefined;
  const sha256 = nonEmpty(env.RUNPANE_CLOUD_PANE_DEB_SHA256);
  // Installed as root: the digest is what vouches for the package.
  if (!sha256) throw new Error('RUNPANE_CLOUD_PANE_DEB_URL needs RUNPANE_CLOUD_PANE_DEB_SHA256.');
  return { kind: 'deb-url', url, sha256 };
}

function hostTransport(record: CloudHostRecord): 'https' | 'http' {
  return record.profile.baseUrl.startsWith('http://') ? 'http' : 'https';
}

/** The agent sign-in every new sandbox gets, as `KEY=value` lines; undefined when none is saved. */
function agentEnvironment(credentials: CloudCredentials): string | undefined {
  return credentials.claude ? `CLAUDE_CODE_OAUTH_TOKEN=${credentials.claude.oauthToken}\n` : undefined;
}

function progressStepFor(step: ProvisionStepName): CloudProgressStep {
  switch (step) {
    case 'agent-env':
    case 'agent-prompts':
    case 'install-pane':
      return 'install';
    case 'pairing':
      return 'pairing';
    case 'health':
    case 'cert-check':
    case 'serve-http':
    case 'serve-guard':
      return 'health';
    default:
      return 'tailnet';
  }
}

function describeStep(step: ProvisionStepName): string {
  switch (step) {
    case 'upload-scripts': return 'Uploading the setup scripts...';
    case 'identity': return 'Resetting the sandbox identity...';
    case 'os-hostname': return 'Naming the sandbox after its tailnet name...';
    case 'tailscale-install': return 'Installing Tailscale...';
    case 'check': return 'Checking the sandbox identity...';
    case 'firewall': return 'Closing inbound tailnet ports...';
    case 'tailscale-join': return 'Joining your tailnet...';
    case 'agent-env': return 'Signing agents in...';
    case 'local-env': return 'Sending your local start script\'s variables...';
    case 'agent-prompts': return 'Answering Claude Code\'s first-run prompts...';
    case 'install-pane': return 'Installing Pane...';
    case 'pairing': return 'Pairing...';
    case 'health': return 'Waiting for the Pane daemon...';
    case 'cert-check': return 'Checking the HTTPS certificate...';
    case 'serve-http': return 'Serving over plain HTTP inside your tailnet (no HTTPS certificate)...';
    case 'serve-guard': return 'Keeping Tailscale Serve across restarts...';
  }
}

/** Finds a wallet by id, name (case-insensitive) or `personal`. */
async function resolveBoatOrg(provider: CloudProvider, wanted: string): Promise<BoatOrg> {
  const orgs = await provider.listOrgs();
  const needle = wanted.trim().toLowerCase();
  const byId = orgs.find((org) => org.id.toLowerCase() === needle);
  const matches = byId ? [byId] : orgs.filter((org) => org.name.toLowerCase() === needle);
  if (matches.length > 1) throw new Error(`Several boat organizations are named "${wanted}"; use the id: ${matches.map((org) => org.id).join(', ')}.`);
  const [match] = matches;
  if (!match) {
    throw new Error(`No boat wallet "${wanted}". Yours: ${orgs.map((org) => `${org.name} (${org.id})${org.active ? ' [active]' : ''}`).join(', ')}.`);
  }
  return { id: match.id, name: match.name };
}

function describeOrg(org: BoatOrg): string {
  return org.id === PERSONAL_ORG.id ? 'Personal' : `${org.name} (${org.id})`;
}

function randomSessionId(): string {
  let id = '';
  for (const byte of randomBytes(10)) id += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length];
  return id;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
