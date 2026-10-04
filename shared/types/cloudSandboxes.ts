/**
 * Cloud sandboxes (experimental): remote hosts that runpane's cloud library creates on a provider
 * sandbox, joins to the user's tailnet, and saves as a remote host profile. The desktop main process
 * drives the library and pushes a CloudSandboxesSnapshot to the renderer whenever anything changes.
 */

export const CLOUD_SANDBOX_SIZES = ['small', 'default', 'large'] as const;
export type CloudSandboxSize = typeof CLOUD_SANDBOX_SIZES[number];

/** What the provider says, as the badge shows it. */
export type CloudSandboxState = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/** An action this app started and is still waiting on. */
export type CloudSandboxPendingAction = 'starting' | 'stopping' | 'removing' | 'updating';

/** The action a failed row's Retry runs again. */
export type CloudSandboxAction = 'create' | 'start' | 'stop' | 'remove' | 'update';

/** Which credentials are saved. Values never leave the main process. */
export interface CloudCredentialStatus {
  boat: boolean;
  tailscale: boolean;
  claude: boolean;
  /** A GitHub token is saved; every sandbox signs gh and git in with it on create and start. */
  github: boolean;
  /** The boat wallet new sandboxes bill, by name (not a secret). */
  boatOrg?: string;
}

/** A partial credentials update; omitted fields keep their saved value. */
export interface CloudCredentialsUpdate {
  boatApiKey?: string;
  /** A boat wallet id or name, or `personal`. */
  boatOrg?: string;
  tailscale?: { clientId: string; clientSecret: string };
  claudeToken?: string;
  /** A GitHub personal access token for gh and git on every sandbox. Blank keeps the saved one. */
  githubToken?: string;
}

/**
 * How a sandbox's GitHub sign-in with the saved token went, as read after its last create or start. `invalid`: GitHub
 * refused the token. `error`: it could not be applied or checked (gh missing, the sandbox or network failing); the
 * message is fixed text, never gh's output.
 */
export type CloudSandboxGitHubView =
  /** `user` is '' when gh is signed in but the account name couldn't be read. */
  | { state: 'signed-in'; user: string }
  | { state: 'invalid' }
  | { state: 'error'; message: string };

export interface CloudSandboxCreateRequest {
  name: string;
  size: CloudSandboxSize;
}

/** One provisioning step as the library reports it; `message` is user-facing and never secret. */
export interface CloudSandboxProgressStep {
  step: string;
  state: 'start' | 'done';
  message?: string;
}

/**
 * The user's startup script's latest run on a sandbox, as read after a create, a start or an edit. `error`: it could
 * not be run at all (for example, the sandbox did not answer); `error` then says why.
 */
export interface CloudSandboxStartupScriptView {
  state: 'running' | 'succeeded' | 'failed' | 'error';
  exitCode?: number;
  /** Killed at the 10 minute limit. */
  timedOut?: boolean;
  error?: string;
}

/** The shell the local start script runs in: sh on macOS and Linux; PowerShell or cmd on Windows. */
export type CloudLocalStartScriptShell = 'sh' | 'powershell' | 'cmd';

/** The user's local start script, run on this computer before each sandbox create and start. */
export interface CloudLocalStartScript {
  shell: CloudLocalStartScriptShell;
  script: string;
}

/**
 * The local start script's last run for a sandbox, when there is something to say. `ok` with the reserved names it
 * printed and that were dropped; `failed`, `timeout` or `error` (fixed text): the sandbox kept its previous variables.
 * Never a value.
 */
export type CloudSandboxLocalStartView =
  | { state: 'ok'; reserved: string[] }
  | { state: 'failed'; exitCode: number }
  | { state: 'timeout'; seconds: number }
  | { state: 'error'; message: string };

export interface CloudSandboxView {
  /** The tailnet hostname once known; a create in flight uses `create:<name>`. */
  id: string;
  label: string;
  hostname?: string;
  /** The saved remote host profile this sandbox connects through. */
  profileId?: string;
  state: CloudSandboxState;
  size: CloudSandboxSize;
  /** When the sandbox last started (ISO), for the "running for" hint. */
  startedAt?: string;
  /** The Pane version its daemon reports to this app's paired client, once read. */
  daemonVersion?: string;
  /** The daemon runs a different Pane version than this app; Update Pane installs this app's. */
  updateAvailable?: boolean;
  pending?: CloudSandboxPendingAction;
  /** The library's latest progress message while `pending`, e.g. "Saving the sandbox…" during a Stop. */
  progress?: string;
  /** The provider could not be read after a failed action, so `state` may be out of date; it is being read again. */
  stateUnknown?: boolean;
  /** Provisioning steps so far, while creating or after a failed create. */
  steps?: CloudSandboxProgressStep[];
  error?: string;
  failedAction?: CloudSandboxAction;
  /** The startup script's latest run; absent when none ran since this app created or started the sandbox. */
  startupScript?: CloudSandboxStartupScriptView;
  /** GitHub sign-in with the saved token; absent when no token is saved or it wasn't applied since this app started. */
  github?: CloudSandboxGitHubView;
  /** The local start script's last run for this sandbox; absent when it ran fine or there is none. */
  localStart?: CloudSandboxLocalStartView;
}

export interface CloudSandboxesSnapshot {
  /** False when this build has no cloud library; the section explains instead of offering actions. */
  available: boolean;
  credentials: CloudCredentialStatus;
  sandboxes: CloudSandboxView[];
  /** A non-blank local start script is saved. */
  localStartScriptSet: boolean;
  /** Listing failed (for example, the provider is unreachable); the last known rows are kept. */
  loadError?: string;
}

export function createDefaultCloudSandboxesSnapshot(): CloudSandboxesSnapshot {
  return {
    available: false,
    credentials: { boat: false, tailscale: false, claude: false, github: false },
    sandboxes: [],
    localStartScriptSet: false,
  };
}

/** Lowercase letters, digits and dashes: the name becomes part of the tailnet hostname. */
export function getCloudSandboxNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Enter a name';
  if (trimmed.length > 40) return 'Use at most 40 characters';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) return 'Use lowercase letters, digits and dashes';
  return null;
}
