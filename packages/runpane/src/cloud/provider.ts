/**
 * Provider interface for cloud sandboxes: the only thing `runpane cloud` needs from a sandbox host.
 * boat.dev is the only adapter (./boat.ts).
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
export interface ListedBoatOrg extends BoatOrg {
  /** The account's active wallet: what a request naming no org bills. */
  active: boolean;
}

export interface CreateSandboxRequest {
  name: string;
  size: CloudSize;
  /** Wallet to bill (org id or `personal`); omitted, the provider's own org, then boat's active wallet. */
  org?: string;
  /** Makes a retried create return the same sandbox instead of a second one. */
  idempotencyKey: string;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * What bootstrap needs to run inside a sandbox. Implementations never log scripts, file contents or
 * command output: scripts read secret files and output can carry the pairing code.
 */
export interface SandboxHandle {
  readonly id: string;
  /** Runs a multi-line bash script as the sandbox login user. */
  runScript(script: string, options?: { timeoutSeconds?: number }): Promise<SandboxCommandResult>;
  /** Writes a file under the login user's home or /tmp. Bootstrap sets modes itself afterwards. */
  writeFile(path: string, content: string): Promise<void>;
}

export interface CloudProvider {
  readonly name: 'boat';
  /** Cheap authenticated call, used by setup to check the key. */
  verifyCredentials(): Promise<{ account: string }>;
  /** The wallets this account can bill (boat GET /orgs); the personal one has id `personal`. */
  listOrgs(): Promise<ListedBoatOrg[]>;
  create(request: CreateSandboxRequest): Promise<CloudSandbox>;
  /** Returns a `gone` sandbox (never throws) when the provider answers 404. */
  get(sandboxId: string): Promise<CloudSandbox>;
  /**
   * The same lookup without the wallet scope, to tell "not in this host's wallet" from "gone": a scoped 404 alone
   * can't say which. Returns `gone` on 404.
   */
  getWithoutWallet(sandboxId: string): Promise<CloudSandbox>;
  list(): Promise<CloudSandbox[]>;
  rename(sandboxId: string, name: string): Promise<void>;
  /** Snapshots the disk and powers the sandbox off; a stopped sandbox costs nothing. */
  stop(sandboxId: string): Promise<void>;
  resume(sandboxId: string): Promise<void>;
  /** Permanently deletes the sandbox and its disk. Idempotent: a 404 counts as deleted. */
  destroy(sandboxId: string): Promise<void>;
  handle(sandboxId: string): SandboxHandle;
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
