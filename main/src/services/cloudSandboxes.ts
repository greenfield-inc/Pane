import type {
  CloudCredentialStatus,
  CloudCredentialsUpdate,
  CloudSandboxAction,
  CloudSandboxCreateRequest,
  CloudSandboxesSnapshot,
  CloudSandboxProgressStep,
  CloudLocalStartScript,
  CloudSandboxGitHubView,
  CloudSandboxLocalStartView,
  CloudSandboxStartupScriptView,
  CloudSandboxState,
  CloudSandboxView,
} from '../../../shared/types/cloudSandboxes';
import type {
  CloudCredentialsStatus,
  CloudProgress,
  LocalStartEnv,
  LocalStartStatus,
  CloudProgressListener,
  CloudSandboxes,
  CloudSandboxInfo,
} from '../../../packages/runpane/src/cloud/api';
import type { GitHubAuthStatus, StartupScriptStatus } from '../../../packages/runpane/src/cloud/bootstrap/provision';
import type { CloudLocalStartScriptFile } from './cloudLocalStartScriptFile';
import type { formatLocalEnvFile, runLocalStartScript } from './cloudLocalStartScript';

/**
 * Cloud sandboxes (experimental). runpane's cloud library (packages/runpane/src/cloud/api.ts) creates,
 * stops, starts, updates and removes the sandboxes; this service only calls it, remembers what this app
 * started, and turns both into the snapshot the Remote Access settings and host switcher render.
 */

/** The parts of the cloud library this app calls. */
export type CloudSandboxLibrary = Pick<
  CloudSandboxes,
  | 'setup' | 'getCredentialsStatus' | 'create' | 'list' | 'status' | 'stop' | 'start' | 'update' | 'remove' | 'syncAgentDefaults'
  | 'runStartupScript' | 'readStartupLog'
>;

/** The user's one startup script for every sandbox, kept only on this computer. */
export interface CloudStartupScriptFile {
  /** Empty when there is none. */
  read(): Promise<string>;
  write(script: string): Promise<void>;
}

/** A Pane .deb the cloud library installs on a running sandbox: https only, checked against sha256. */
export interface CloudPaneDeb {
  debUrl: string;
  sha256: string;
}

export class CloudSandboxesUnavailableError extends Error {
  constructor() {
    super('Cloud sandboxes are not available in this build of Pane.');
    this.name = 'CloudSandboxesUnavailableError';
  }
}

interface CloudSandboxOperation {
  action: CloudSandboxAction;
  running: boolean;
  /** Set for creates, so Retry can run the same request again. */
  request?: CloudSandboxCreateRequest;
  steps: CloudSandboxProgressStep[];
  /** The library's latest progress message for a host action in flight. */
  progress?: string;
  error?: string;
}

interface CloudSandboxManagerOptions {
  loadLibrary: () => Promise<CloudSandboxLibrary>;
  onChange: (snapshot: CloudSandboxesSnapshot) => void;
  /** This app's own Pane version, which Update Pane installs on a sandbox; unknown offers no update. */
  appVersion?: string;
  /** Asks a running sandbox's daemon for its Pane version through the saved host profile. */
  readDaemonVersion: (profileId: string) => Promise<string | undefined>;
  /** The Pane .deb for a version, from that release's published checksums. */
  resolvePaneDeb: (version: string) => Promise<CloudPaneDeb>;
  /**
   * The Claude Code default model new panels in a sandbox should start with (null: unknown right now, so nothing is
   * sent and every sandbox keeps the model it has). The library reads the same source when it applies the model, so
   * this only decides when a sandbox needs it again.
   */
  readDefaultClaudeModel: () => Promise<string | null>;
  /** How often a sandbox that is stopping or starting is read again until it settles (default 5 s). */
  pollIntervalMs?: number;
  startupScriptFile: CloudStartupScriptFile;
  /** The local start script; saving it reaches no sandbox (each gets its variables at its own create or start). */
  localStartScriptFile: CloudLocalStartScriptFile;
}

type HostAction = Exclude<CloudSandboxAction, 'create'>;

const CREATE_ID_PREFIX = 'create:';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const NO_CREDENTIALS: CloudCredentialStatus = { boat: false, tailscale: false, claude: false, github: false };

export class CloudSandboxManager {
  private libraryPromise: Promise<CloudSandboxLibrary> | null = null;
  private available = true;
  private credentials: CloudCredentialStatus = NO_CREDENTIALS;
  private listed: CloudSandboxInfo[] = [];
  private loadError: string | undefined;
  private readonly operations = new Map<string, CloudSandboxOperation>();
  /** Daemon versions by hostname, read while each sandbox runs. */
  private readonly daemonVersions = new Map<string, string>();
  /** The default Claude model each sandbox was last given, by hostname; absent means unknown. */
  private readonly syncedClaudeModels = new Map<string, string | null>();
  private readonly syncingClaudeModels = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  /** Sandboxes whose state could not be read after a failed host action; shown as unknown until read. */
  private readonly unconfirmed = new Set<string>();
  /** Each sandbox's latest startup script run, by hostname, while this app knows it. */
  private readonly startupRuns = new Map<string, CloudSandboxStartupScriptView>();
  /** Each sandbox's local start script run, by hostname, when there is something to show. */
  private readonly localStartStates = new Map<string, CloudSandboxLocalStartView>();
  private localStartScriptSet = false;
  /** Each sandbox's GitHub sign-in from its last create or start, by hostname. */
  private readonly githubStates = new Map<string, CloudSandboxGitHubView>();
  /** Counts runs per hostname, so only the latest run's result is shown. */
  private readonly startupRunIds = new Map<string, number>();

  constructor(private readonly options: CloudSandboxManagerOptions) {}

  getSnapshot(): CloudSandboxesSnapshot {
    const rows: CloudSandboxView[] = [];
    // The library saves a new sandbox part-way through its create; until the create ends it is shown only as that create.
    const creating = new Set<string>();
    for (const [id, operation] of this.operations) {
      if (!id.startsWith(CREATE_ID_PREFIX) || !operation.request) continue;
      if (operation.running) creating.add(operation.request.name);
      rows.push({
        id,
        label: operation.request.name,
        state: operation.running ? 'creating' : 'error',
        size: operation.request.size,
        steps: [...operation.steps],
        error: operation.error,
        failedAction: operation.error ? 'create' : undefined,
      });
    }
    for (const summary of this.listed) {
      if (creating.has(summary.label)) continue;
      const operation = this.operations.get(summary.hostname);
      const daemonVersion = summary.state === 'running'
        ? this.daemonVersions.get(summary.hostname) ?? summary.daemonVersion
        : undefined;
      rows.push({
        id: summary.hostname,
        label: summary.label,
        hostname: summary.hostname,
        profileId: summary.profileId,
        state: getViewState(summary.state),
        size: summary.size ?? 'default',
        startedAt: summary.state === 'running' ? summary.startedAt : undefined,
        daemonVersion,
        updateAvailable: Boolean(this.options.appVersion) && daemonVersion !== undefined
          && comparePaneVersions(daemonVersion, this.options.appVersion ?? '') !== 0,
        pending: operation?.running ? getPendingAction(operation.action) : undefined,
        progress: operation?.running ? operation.progress : undefined,
        stateUnknown: this.unconfirmed.has(summary.hostname) || undefined,
        error: operation?.error ?? (summary.state === 'gone' ? 'boat.dev no longer has this sandbox.' : undefined),
        failedAction: operation?.error ? operation.action : undefined,
        startupScript: this.startupRuns.get(summary.hostname),
        github: this.githubStates.get(summary.hostname),
        localStart: this.localStartStates.get(summary.hostname),
      });
    }
    return {
      available: this.available,
      credentials: { ...this.credentials },
      sandboxes: rows,
      localStartScriptSet: this.localStartScriptSet,
      loadError: this.loadError,
    };
  }

  /** Re-reads the saved credentials and the provider's list, then each running daemon's version. */
  async refresh(): Promise<CloudSandboxesSnapshot> {
    const library = await this.getLibrary();
    if (!library) return this.getSnapshot();
    try {
      const [credentials, listed] = await Promise.all([library.getCredentialsStatus(), library.list()]);
      this.credentials = toCredentialStatus(credentials);
      this.listed = listed;
      this.loadError = undefined;
    } catch (error) {
      this.loadError = getCloudErrorMessage(error, 'Failed to load cloud sandboxes');
    }
    this.localStartScriptSet = await this.readLocalStartScriptSet();
    const snapshot = this.emit();
    // Versions arrive in a later snapshot so a slow or asleep daemon never holds up the list.
    for (const summary of this.listed) void this.readDaemonVersion(summary);
    void this.syncDefaultClaudeModel();
    this.schedulePoll();
    return snapshot;
  }

  async updateCredentials(update: CloudCredentialsUpdate): Promise<CloudSandboxesSnapshot> {
    const library = await this.requireLibrary();
    this.credentials = toCredentialStatus(await library.setup({
      boatApiKey: update.boatApiKey,
      boatOrg: update.boatOrg,
      tailscaleClientId: update.tailscale?.clientId,
      tailscaleClientSecret: update.tailscale?.clientSecret,
      claudeToken: update.claudeToken,
      githubToken: update.githubToken,
    }));
    return this.emit();
  }

  /** Resolves with the snapshot once the sandbox is ready; a failure stays on its row for Retry. */
  async create(request: CloudSandboxCreateRequest): Promise<CloudSandboxesSnapshot> {
    const library = await this.requireLibrary();
    const id = `${CREATE_ID_PREFIX}${request.name}`;
    if (this.operations.get(id)?.running) throw new Error(`"${request.name}" is already being created.`);
    if (this.listed.some((summary) => summary.label === request.name)) {
      throw new Error(`A cloud sandbox named "${request.name}" already exists.`);
    }
    const operation: CloudSandboxOperation = { action: 'create', running: true, request, steps: [] };
    this.operations.set(id, operation);
    this.emit();
    try {
      const claudeModel = await this.readDefaultClaudeModel();
      const summary = await library.create({ label: request.name, size: request.size }, (progress) => {
        operation.steps = applyProgress(operation.steps, progress);
        this.emit();
      });
      this.operations.delete(id);
      this.replaceListed(summary.hostname, summary);
      this.applyGitHubState(summary.hostname, summary.github);
      this.applyLocalStartState(summary.hostname, summary.localStart);
      const startupScript = getStartupScriptView(summary.startupScript ?? null);
      if (startupScript) this.startupRuns.set(summary.hostname, startupScript);
      if (claudeModel !== null) this.syncedClaudeModels.set(summary.hostname, claudeModel);
      void this.readDaemonVersion(summary);
    } catch (error) {
      operation.running = false;
      operation.error = getCloudErrorMessage(error, `Failed to create ${request.name}`);
    }
    return this.emit();
  }

  async start(id: string): Promise<CloudSandboxesSnapshot> {
    const snapshot = await this.runHostAction(id, 'start', (library, hostname, onProgress) => library.start(hostname, onProgress));
    // The boot ran the script the sandbox had; read how it went, and run the current one if it changed meanwhile.
    if (this.operations.get(id)?.error) return snapshot;
    void this.runStartupScript(id, { onlyIfChanged: true });
    return this.getSnapshot();
  }

  stop(id: string): Promise<CloudSandboxesSnapshot> {
    return this.runHostAction(id, 'stop', (library, hostname, onProgress) => library.stop(hostname, onProgress));
  }

  /** Installs this app's Pane version on a running sandbox. */
  update(id: string): Promise<CloudSandboxesSnapshot> {
    return this.runHostAction(id, 'update', async (library, hostname, onProgress) => {
      const { appVersion } = this.options;
      if (!appVersion) throw new Error('This app does not know its own Pane version.');
      return library.update(hostname, await this.options.resolvePaneDeb(appVersion), onProgress);
    });
  }

  remove(id: string): Promise<CloudSandboxesSnapshot> {
    return this.runHostAction(id, 'remove', async (library, hostname, onProgress) => {
      await library.remove(hostname, onProgress);
      return null;
    });
  }

  /**
   * Puts a failure that happened before the library ran (e.g. leaving the connected sandbox) on the row, so a renderer
   * that missed the reply still sees it in the next snapshot; also written to the app log.
   */
  recordFailure(id: string, action: Exclude<CloudSandboxAction, 'create'>, message: string): CloudSandboxesSnapshot {
    console.warn(`[cloud] ${action} ${id} failed: ${message}`);
    if (this.listed.some((summary) => summary.hostname === id) && !this.operations.get(id)?.running) {
      this.operations.set(id, { action, running: false, steps: [], error: message });
    }
    return this.emit();
  }

  getStartupScript(): Promise<string> {
    return this.options.startupScriptFile.read();
  }

  /**
   * Saves the user's startup script on this computer (nothing else keeps it), then gives it to every running sandbox
   * that is not busy and runs it there once. Stopped sandboxes get it when they start.
   */
  async saveStartupScript(script: string): Promise<CloudSandboxesSnapshot> {
    await this.options.startupScriptFile.write(script);
    for (const summary of this.listed) {
      if (summary.state === 'running' && !this.operations.get(summary.hostname)?.running) {
        void this.runStartupScript(summary.hostname, { onlyIfChanged: false });
      }
    }
    return this.emit();
  }

  /** Whether a local start script is saved; an unreadable file keeps what was known (the list must still load). */
  private async readLocalStartScriptSet(): Promise<boolean> {
    try {
      return Boolean((await this.options.localStartScriptFile.read()).script.trim());
    } catch {
      return this.localStartScriptSet;
    }
  }

  getLocalStartScript(): Promise<CloudLocalStartScript> {
    return this.options.localStartScriptFile.read();
  }

  /**
   * Saves the local start script on this computer. It reaches NO sandbox now: each one runs it at its own next create
   * or start, and only that sandbox gets the variables.
   */
  async saveLocalStartScript(settings: CloudLocalStartScript): Promise<CloudSandboxesSnapshot> {
    await this.options.localStartScriptFile.write(settings);
    this.localStartScriptSet = Boolean(settings.script.trim());
    return this.emit();
  }

  /** The last 200 lines of a sandbox's startup log, for View log only: it may hold anything the script printed. */
  async readStartupLog(id: string): Promise<string> {
    const library = await this.requireLibrary();
    const listed = this.listed.find((summary) => summary.hostname === id);
    if (!listed) throw new Error(`Unknown cloud sandbox "${id}".`);
    return library.readStartupLog(listed.hostname);
  }

  /** Runs the startup script on a sandbox in the background; the row shows it running, then how it ended. */
  private async runStartupScript(hostname: string, options: { onlyIfChanged: boolean }): Promise<void> {
    const runId = (this.startupRunIds.get(hostname) ?? 0) + 1;
    this.startupRunIds.set(hostname, runId);
    this.startupRuns.set(hostname, { state: 'running' });
    this.emit();
    let view: CloudSandboxStartupScriptView | undefined;
    try {
      view = getStartupScriptView(await (await this.requireLibrary()).runStartupScript(hostname, options));
    } catch (error) {
      view = { state: 'error', error: getCloudErrorMessage(error, 'The startup script could not run') };
    }
    if (this.startupRunIds.get(hostname) !== runId) return;
    if (view) this.startupRuns.set(hostname, view);
    else this.startupRuns.delete(hostname);
    this.emit();
  }

  /** Runs a failed row's action again. */
  async retry(id: string): Promise<CloudSandboxesSnapshot> {
    const operation = this.operations.get(id);
    if (!operation?.error) throw new Error('Nothing to retry for this cloud sandbox.');
    if (operation.action === 'create') {
      if (!operation.request) throw new Error('Nothing to retry for this cloud sandbox.');
      this.operations.delete(id);
      return this.create(operation.request);
    }
    return this.runListedAction(id, operation.action);
  }

  /** Clears a row's error; a failed create's row goes away. */
  dismiss(id: string): CloudSandboxesSnapshot {
    if (!this.operations.get(id)?.running) this.operations.delete(id);
    return this.emit();
  }

  private runListedAction(id: string, action: HostAction): Promise<CloudSandboxesSnapshot> {
    if (action === 'start') return this.start(id);
    if (action === 'stop') return this.stop(id);
    if (action === 'update') return this.update(id);
    return this.remove(id);
  }

  private async runHostAction(
    id: string,
    action: HostAction,
    run: (library: CloudSandboxLibrary, hostname: string, onProgress: CloudProgressListener) => Promise<CloudSandboxInfo | null>,
  ): Promise<CloudSandboxesSnapshot> {
    const library = await this.requireLibrary();
    const listed = this.listed.find((summary) => summary.hostname === id);
    if (!listed) throw new Error(`Unknown cloud sandbox "${id}".`);
    if (this.operations.get(id)?.running) throw new Error(`${listed.label} is busy; try again when it finishes.`);
    const operation: CloudSandboxOperation = { action, running: true, steps: [] };
    this.operations.set(id, operation);
    this.emit();
    console.info(`[cloud] ${action} ${id}: started`);
    try {
      // start and update give the sandbox the user's default model; remember which one it got.
      const claudeModel = action === 'start' || action === 'update' ? await this.readDefaultClaudeModel() : undefined;
      // Steps and failures go to the app log (names and ids only), so a host action that went wrong can be traced.
      const summary = await run(library, listed.hostname, (progress) => {
        if (progress.step === 'done') return;
        console.info(`[cloud] ${action} ${id}: ${progress.message}`);
        operation.progress = progress.message;
        this.emit();
      });
      console.info(`[cloud] ${action} ${id}: done`);
      this.operations.delete(id);
      this.daemonVersions.delete(id);
      // A stopped or removed sandbox's last run says nothing about its next one.
      if (action === 'stop' || action === 'remove') this.forgetStartupRun(id);
      if (!summary) {
        this.syncedClaudeModels.delete(id);
        this.githubStates.delete(id);
        this.localStartStates.delete(id);
      } else {
        if (claudeModel) this.syncedClaudeModels.set(id, claudeModel);
        this.applyGitHubState(id, summary.github);
        this.applyLocalStartState(id, summary.localStart);
      }
      this.replaceListed(id, summary);
      if (summary) void this.readDaemonVersion(summary);
    } catch (error) {
      operation.running = false;
      const message = getCloudErrorMessage(error, `Failed to ${action} ${listed.label}`);
      console.warn(`[cloud] ${action} ${id} failed: ${message}`);
      // Never keep the pre-action summary: show what the provider says now.
      const current = await this.readProviderState(library, listed.hostname);
      operation.error = message;
      if (current) this.applyProviderState(current);
      // Unreadable too: the old summary is not the state any more, so show it as unknown and keep asking.
      else this.unconfirmed.add(id);
    }
    this.schedulePoll();
    return this.emit();
  }

  /** A run that went fine shows nothing (unless it dropped reserved names); a failure shows until the next run. */
  private applyLocalStartState(hostname: string, localStart: LocalStartStatus | undefined): void {
    if (!localStart) return;
    const view = getLocalStartView(localStart);
    if (view) this.localStartStates.set(hostname, view);
    else this.localStartStates.delete(hostname);
  }

  /** `none` (no token saved) shows nothing; every other state replaces what the row showed. */
  private applyGitHubState(hostname: string, github: GitHubAuthStatus | undefined): void {
    if (!github) return;
    if (github.state === 'none') this.githubStates.delete(hostname);
    else this.githubStates.set(hostname, github);
  }

  private forgetStartupRun(hostname: string): void {
    this.startupRuns.delete(hostname);
    this.startupRunIds.set(hostname, (this.startupRunIds.get(hostname) ?? 0) + 1);
  }

  /** The sandbox's state as the provider reports it now, or null when that can't be read. */
  private async readProviderState(library: CloudSandboxLibrary, hostname: string): Promise<CloudSandboxInfo | null> {
    try {
      return await library.status(hostname);
    } catch (error) {
      console.warn(`[CloudSandboxes] Could not read ${hostname}'s state:`, getCloudErrorMessage(error, 'status failed'));
      return null;
    }
  }

  /** Reads sandboxes that are stopping or starting again, every poll interval, until they settle. */
  private schedulePoll(): void {
    if (this.pollTimer || !this.listed.some((summary) => this.isSettling(summary))) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollSettling();
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  /** Takes what the provider says as the row's state; a Stop it is still saving, or has saved, is not a failure. */
  private applyProviderState(current: CloudSandboxInfo): void {
    this.unconfirmed.delete(current.hostname);
    this.replaceListed(current.hostname, current);
    const operation = this.operations.get(current.hostname);
    if (operation?.action === 'stop' && !operation.running && (current.state === 'stopping' || current.state === 'stopped')) {
      this.operations.delete(current.hostname);
    }
  }

  private isSettling(summary: CloudSandboxInfo): boolean {
    if (this.operations.get(summary.hostname)?.running) return false;
    return summary.state === 'stopping' || summary.state === 'starting' || this.unconfirmed.has(summary.hostname);
  }

  private async pollSettling(): Promise<void> {
    const library = await this.getLibrary();
    if (!library) return;
    const settling = this.listed.filter((summary) => this.isSettling(summary));
    const read = await Promise.all(settling.map((summary) => this.readProviderState(library, summary.hostname)));
    for (const current of read) {
      // A host action started meanwhile owns the row; its result replaces it.
      if (current && !this.operations.get(current.hostname)?.running) this.applyProviderState(current);
    }
    this.emit();
    this.schedulePoll();
  }

  /**
   * Gives running sandboxes the user's default Claude model when it differs from the one they last got. With a
   * profile id (the desktop just connected to that host) it syncs that sandbox whatever it last got. Best effort:
   * a failure leaves the sandbox's record unchanged, so the next refresh tries again.
   */
  async syncDefaultClaudeModel(target?: { profileId: string }): Promise<void> {
    const library = await this.getLibrary();
    if (!library) return;
    if (target && !this.listed.some((summary) => summary.profileId === target.profileId)) await this.refresh();
    const candidates = this.listed.filter((summary) => summary.state === 'running'
      && !this.operations.get(summary.hostname)?.running
      && !this.syncingClaudeModels.has(summary.hostname)
      && (!target || summary.profileId === target.profileId));
    // Reading the default can run the user's own claude, so only when a running sandbox could need it.
    if (candidates.length === 0) return;
    const model = await this.readDefaultClaudeModel();
    // Unknown (a failed detection) is not a change: send nothing and keep what each sandbox last got.
    if (model === null) return;
    // Another sync may have started one of them while the default was read.
    const due = candidates.filter((summary) => !this.syncingClaudeModels.has(summary.hostname) && (target
      || !this.syncedClaudeModels.has(summary.hostname) || this.syncedClaudeModels.get(summary.hostname) !== model));
    await Promise.all(due.map(async (summary) => {
      this.syncingClaudeModels.add(summary.hostname);
      try {
        await library.syncAgentDefaults(summary.hostname);
        this.syncedClaudeModels.set(summary.hostname, model);
      } catch (error) {
        console.warn(`[CloudSandboxes] ${summary.label} kept its Claude model:`, getCloudErrorMessage(error, 'sync failed'));
      } finally {
        this.syncingClaudeModels.delete(summary.hostname);
      }
    }));
  }

  private async readDefaultClaudeModel(): Promise<string | null> {
    try {
      return await this.options.readDefaultClaudeModel();
    } catch {
      return null;
    }
  }

  private replaceListed(hostname: string, summary: CloudSandboxInfo | null): void {
    if (!summary) this.unconfirmed.delete(hostname);
    const others = this.listed.filter((current) => current.hostname !== hostname);
    const index = this.listed.findIndex((current) => current.hostname === hostname);
    if (!summary) {
      this.listed = others;
    } else if (index === -1) {
      this.listed = [...others, summary];
    } else {
      this.listed = this.listed.map((current, currentIndex) => currentIndex === index ? summary : current);
    }
  }

  private async readDaemonVersion(summary: CloudSandboxInfo): Promise<void> {
    if (summary.state !== 'running') return;
    try {
      const version = await this.options.readDaemonVersion(summary.profileId);
      if (!version || this.daemonVersions.get(summary.hostname) === version) return;
      this.daemonVersions.set(summary.hostname, version);
      this.emit();
    } catch {
      // An unreachable daemon just shows no version; the row's state already says why.
    }
  }

  private async getLibrary(): Promise<CloudSandboxLibrary | null> {
    this.libraryPromise ??= this.options.loadLibrary();
    try {
      const library = await this.libraryPromise;
      this.available = true;
      return library;
    } catch (error) {
      if (!(error instanceof CloudSandboxesUnavailableError)) {
        // A transient load failure is retried on the next call.
        this.libraryPromise = null;
        this.loadError = getCloudErrorMessage(error, 'Failed to load the cloud library');
      }
      this.available = false;
      return null;
    }
  }

  private async requireLibrary(): Promise<CloudSandboxLibrary> {
    const library = await this.getLibrary();
    if (!library) throw new CloudSandboxesUnavailableError();
    return library;
  }

  private emit(): CloudSandboxesSnapshot {
    const snapshot = this.getSnapshot();
    this.options.onChange(snapshot);
    return snapshot;
  }
}

function getPendingAction(action: CloudSandboxAction): CloudSandboxView['pending'] {
  if (action === 'start') return 'starting';
  if (action === 'stop') return 'stopping';
  if (action === 'remove') return 'removing';
  if (action === 'update') return 'updating';
  return undefined;
}

/** The library reports the step it starts; every earlier step is then done, and `done` ends them all. */
function applyProgress(steps: CloudSandboxProgressStep[], progress: CloudProgress): CloudSandboxProgressStep[] {
  const finished = steps.map((step): CloudSandboxProgressStep => ({ ...step, state: 'done' }));
  if (progress.step === 'done') return finished;
  const current: CloudSandboxProgressStep = { step: progress.step, state: 'start', message: progress.message };
  const index = finished.findIndex((step) => step.step === progress.step);
  if (index === -1) return [...finished, current];
  return finished.map((step, stepIndex) => stepIndex === index ? current : step);
}

/** A local start script run as the row shows it: nothing when it ran fine (and dropped no reserved names) or there is none. */
function getLocalStartView(status: LocalStartStatus): CloudSandboxLocalStartView | undefined {
  if (status.state === 'none') return undefined;
  if (status.state === 'ok') return status.reserved.length > 0 ? { state: 'ok', reserved: status.reserved } : undefined;
  return status;
}

/** How long the local start script may run on this computer before it is stopped. */
const LOCAL_START_TIMEOUT_MS = 60_000;

/**
 * The desktop's local start script for one sandbox create or start: runs it here and turns its output into that
 * sandbox's env file. A failed run leaves the sandbox's previous variables alone (envFile null); none or no variables
 * remove them (''). The status never carries a value.
 */
export function createLocalStartEnvReader(deps: {
  file: CloudLocalStartScriptFile;
  run: typeof runLocalStartScript;
  format: typeof formatLocalEnvFile;
}): () => Promise<LocalStartEnv> {
  return async () => {
    const { shell, script } = await deps.file.read();
    if (!script.trim()) return { status: { state: 'none' }, envFile: '' };
    const result = await deps.run(script, { shell, timeoutMs: LOCAL_START_TIMEOUT_MS });
    if (result.timedOut) return { status: { state: 'timeout', seconds: LOCAL_START_TIMEOUT_MS / 1000 }, envFile: null };
    if (!result.ok && result.exitCode !== null) return { status: { state: 'failed', exitCode: result.exitCode }, envFile: null };
    if (!result.ok) return { status: { state: 'error', message: result.failureSummary ?? "Pane couldn't run the local start script." }, envFile: null };
    return { status: { state: 'ok', keys: result.keys.length, reserved: result.reservedKeys }, envFile: result.keys.length > 0 ? deps.format(result.env) : '' };
  };
}

/** How a startup script run shows on the row; undefined when no script has run. */
export function getStartupScriptView(status: StartupScriptStatus | null): CloudSandboxStartupScriptView | undefined {
  if (!status) return undefined;
  if (status.exitCode === null || status.finishedAt === null) return { state: 'running' };
  if (status.timedOut) return { state: 'failed', exitCode: status.exitCode, timedOut: true };
  return { state: status.exitCode === 0 ? 'succeeded' : 'failed', exitCode: status.exitCode };
}

function toCredentialStatus(status: CloudCredentialsStatus): CloudCredentialStatus {
  return {
    boat: status.boat.configured,
    tailscale: status.tailscale.configured,
    claude: status.claude.configured,
    github: status.github.configured,
    boatOrg: status.boat.org?.name,
  };
}

function getViewState(state: CloudSandboxInfo['state']): CloudSandboxState {
  return state === 'gone' ? 'error' : state;
}

// The library redacts its own messages; this catches a token-shaped string that slipped through anyway.
const TOKEN_PATTERN = /\b(?:tskey-[\w-]+|sk-ant-[\w-]+|[A-Za-z0-9_]{32,})\b/g;

export function getCloudErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error && cause.message ? cause.message : fallback;
  return message.replace(TOKEN_PATTERN, '[redacted]');
}

interface PaneVersion {
  core: number[];
  prerelease: string[];
}

/**
 * A Pane version as semver. The .deb's version (dpkg) writes a prerelease with Debian's `~`, the app with `-`;
 * a leading `v`, a Debian epoch (`1:`) and build metadata (`+…`) are not part of the version.
 */
function parsePaneVersion(version: string): PaneVersion | null {
  const normalized = version.trim().replace(/^v/i, '').replace(/^\d+:/, '').split('+')[0].replace('~', '-');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver precedence of two Pane versions (-1, 0 or 1), whichever separator each uses. Versions that don't
 * parse compare as their trimmed text, so they only match themselves.
 */
export function comparePaneVersions(left: string, right: string): number {
  const a = parsePaneVersion(left);
  const b = parsePaneVersion(right);
  if (!a || !b) return left.trim() === right.trim() ? 0 : left.trim() < right.trim() ? -1 : 1;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  // A release ranks above its prereleases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index += 1) {
    const order = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (order !== 0) return order;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

const RELEASE_BASE_URL = 'https://github.com/greenfield-inc/Pane/releases/download';

/**
 * The linux amd64 .deb of a published Pane release and its sha256 from the release's SHA256SUMS.txt.
 * Cloud sandboxes run amd64 Linux whatever this app's own platform is.
 */
export async function resolvePaneReleaseDeb(
  version: string,
  fetchText: (url: string) => Promise<string> = fetchReleaseText,
): Promise<CloudPaneDeb> {
  const fileName = `Pane-${version}-linux-amd64.deb`;
  const sums = await fetchText(`${RELEASE_BASE_URL}/v${version}/SHA256SUMS.txt`);
  const sha256 = sums.split('\n')
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === fileName)?.[0];
  if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error(`Pane ${version} has no published checksum for ${fileName}.`);
  }
  return { debUrl: `${RELEASE_BASE_URL}/v${version}/${fileName}`, sha256: sha256.toLowerCase() };
}

async function fetchReleaseText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Could not read ${url} (HTTP ${response.status}).`);
  return response.text();
}
