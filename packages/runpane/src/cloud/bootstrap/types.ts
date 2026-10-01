export interface SandboxCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * The provider-neutral view of one cloud sandbox that bootstrap drives. The provider adapter
 * (boat: files API + commands API) implements it. Implementations must never log scripts,
 * file contents or command output: scripts read secret files and output can carry pairing codes.
 */
export interface SandboxHandle {
  readonly id: string;
  /** Runs a multi-line bash script as the sandbox login user. */
  runScript(script: string, options?: { timeoutSeconds?: number }): Promise<SandboxCommandResult>;
  /** Writes a file under /home/user or /tmp. Bootstrap sets modes itself afterwards. */
  writeFile(path: string, content: string): Promise<void>;
}

export interface TailnetIdentity {
  /** Tailscale's stable node id (e.g. "nxw81ARJfq11CNTRL"); the admin API deletes devices by it. */
  nodeId: string;
  hostname: string;
  /** Fully qualified MagicDNS name without the trailing dot. */
  magicDnsName: string;
  tailscaleIps: string[];
  tags: string[];
  runSsh: boolean;
}

export type PaneSource =
  | { kind: 'deb-url'; url: string; sha256?: string }
  | { kind: 'runpane-npm'; spec: string }
  | { kind: 'preinstalled' };

export type ProvisionStepName =
  | 'upload-scripts'
  | 'identity'
  | 'tailscale-install'
  | 'check'
  | 'firewall'
  | 'tailscale-join'
  | 'install-pane'
  | 'pairing'
  | 'extra-clients'
  | 'clone'
  | 'health'
  | 'cert-check'
  | 'serve-http'
  | 'serve-guard'
  | 'register-repo';

export interface ProvisionStep {
  step: ProvisionStepName;
  state: 'start' | 'done';
  elapsedMs?: number;
  /** Non-secret detail, e.g. the MagicDNS name or the daemon version. */
  detail?: string;
}

export interface DaemonHealthResult {
  ok: boolean;
  status?: number;
  elapsedMs: number;
  version?: string;
  /** `readiness.state` when the daemon reports it, else the legacy `status` field. */
  readiness?: string;
}
