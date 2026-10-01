/**
 * Provider interface for `runpane cloud`: the only thing the CLI needs from a sandbox host.
 * boat.dev is the v1 adapter (./boat.ts); a second adapter is post-v1.
 */

export type CloudSize = 'small' | 'default' | 'large';
export const CLOUD_SIZES: readonly CloudSize[] = ['small', 'default', 'large'];

/** Provider-neutral lifecycle state. `gone` means the provider no longer knows the sandbox. */
export type CloudSandboxState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error' | 'gone';

export interface CloudSandbox {
  id: string;
  name: string;
  state: CloudSandboxState;
  /** The provider's own state string, for display and debugging. */
  providerState: string;
  size?: CloudSize;
  error?: string | null;
  createdAt?: string | null;
  /** The wallet this sandbox bills, fixed when it was created; undefined when the provider did not say. */
  org?: BoatOrg;
}

/**
 * A boat billing wallet: an organization (`team_…`) or the account's own personal wallet, whose id is
 * always the word `personal` here (boat accepts it wherever an org is passed).
 */
export interface BoatOrg {
  id: string;
  name: string;
}

export const PERSONAL_ORG: BoatOrg = { id: 'personal', name: 'Personal' };

/** One wallet the account can bill, as boat's GET /orgs lists it. */
interface ListedBoatOrg extends BoatOrg {
  /** The account's active wallet: what a request naming no org bills. */
  active: boolean;
}

export interface CreateSandboxRequest {
  name: string;
  size: CloudSize;
  /** Named snapshot (golden image) to start from. */
  fromSnapshot?: string;
  /** Wallet to bill (org id, name or `personal`); omitted, the provider's own org, then boat's active wallet. */
  org?: string;
  /**
   * Makes a retried create return the same sandbox instead of a second one.
   * The CLI derives it from the cloud Session id.
   */
  idempotencyKey: string;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * The home of the user that runs bootstrap and the Pane daemon in every sandbox (boat's login user). Code
 * that writes into a Session builds its paths from this, so a provider with another login user changes one
 * place. Bootstrap itself takes it as `sandboxHome`.
 */
export const SANDBOX_HOME = '/home/user';

/**
 * What bootstrap needs to run inside a sandbox. It matches bootstrap's SandboxHandle
 * (bootstrap/types.ts): scripts and file contents are never logged, because
 * they can carry secrets and stdout can carry the pairing code.
 */
export interface SandboxHandle {
  readonly id: string;
  runScript(script: string, options?: { timeoutSeconds?: number }): Promise<SandboxCommandResult>;
  writeFile(path: string, content: string): Promise<void>;
}

/** The largest file one `readFile` call returns (boat answers 400 above 5 MiB). */
export const MAX_SANDBOX_READ_BYTES = 4 * 1024 * 1024;

/** A provider API key limited to some actions, e.g. the coordinator's stop/resume-only key. */
export interface ScopedKeyRequest {
  name: string;
  /** Provider duration string, e.g. "365d". */
  ttl: string;
  actions: string[];
}

interface ScopedKey {
  id: string;
  /** Returned once by the provider; callers write it to a 0600 file and never print it. */
  secret: string;
}

export interface CloudProvider {
  readonly name: 'boat';
  /** Cheap authenticated call, used by `runpane cloud setup` to check the key. */
  verifyCredentials(): Promise<{ account: string }>;
  /** The wallets this account can bill (boat GET /orgs); the personal one has id `personal`. */
  listOrgs(): Promise<ListedBoatOrg[]>;
  create(request: CreateSandboxRequest): Promise<CloudSandbox>;
  /** Returns a `gone` sandbox (never throws) when the provider answers 404. */
  get(sandboxId: string): Promise<CloudSandbox>;
  list(): Promise<CloudSandbox[]>;
  rename(sandboxId: string, name: string): Promise<void>;
  stop(sandboxId: string): Promise<void>;
  resume(sandboxId: string, options?: { size?: CloudSize }): Promise<void>;
  /** Permanently deletes the sandbox and its disk. Idempotent: a 404 counts as deleted. */
  destroy(sandboxId: string): Promise<void>;
  handle(sandboxId: string): SandboxHandle;
  /**
   * Reads one file from the sandbox (under /home/user or /tmp). boat caps a read at 5 MiB, so callers
   * split bigger files first (see MAX_SANDBOX_READ_BYTES).
   */
  readFile(sandboxId: string, path: string): Promise<Buffer>;
  createScopedKey(request: ScopedKeyRequest): Promise<ScopedKey>;
  /** Revokes an API key. Idempotent: a 404 counts as revoked. */
  revokeKey(keyId: string): Promise<void>;
}

export class CloudProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CloudProviderError';
  }
}
