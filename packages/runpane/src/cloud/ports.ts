import type { CloudTransport } from './args';
import type { SandboxHandle } from './provider';
import type { CloudCredentials, PaneSource } from './store';

/**
 * What the `runpane cloud` commands need from bootstrap (src/cloud/bootstrap/**, src/cloud/tailscale.ts)
 * and from the Tailscale API. `wiring.ts` adapts the
 * real modules to these ports, and tests pass fakes.
 */

export interface TailnetDevice {
  nodeId: string;
  hostname: string;
  /** MagicDNS name, e.g. rp-abc12345.tailnet-example.ts.net */
  name?: string;
  online?: boolean;
  lastSeen?: string;
  /** ACL tags; runpane deletes only devices tagged like its own nodes (see partitionOwnedDevices). */
  tags?: string[];
}

export interface TailnetPort {
  findDevicesByHostname(hostname: string): Promise<TailnetDevice[]>;
  /** Resolves false (or nothing) when the device was already gone. */
  deleteDevice(nodeId: string): Promise<boolean | void>;
}

export interface ProvisionRequest {
  sessionId: string;
  label: string;
  hostname: string;
  paneSource: PaneSource;
  repo?: { url: string; ref?: string };
  transport?: CloudTransport;
  /** Local 0600 file that receives the pane-remote:// code. */
  pairingOutputPath: string;
  extraClients?: { label: string; outputPath: string; scope?: 'coordinator' }[];
  healthTimeoutMs?: number;
  onStep?: (step: string) => void;
}

interface ProvisionOutcome {
  hostname: string;
  magicDnsName: string;
  nodeId: string;
  baseUrl: string;
  transport?: 'https' | 'http';
  pairingPath: string;
  daemonVersion?: string;
  timings: Partial<Record<string, number>>;
}

interface HealthResult {
  ok: boolean;
  status?: number;
  elapsedMs: number;
  version?: string;
}

export interface BootstrapPort {
  cloudHostname(sessionId: string, prefix: string): string;
  provision(sandbox: SandboxHandle, request: ProvisionRequest, tailnet: TailnetCredentials): Promise<ProvisionOutcome>;
  waitForDaemonHealth(baseUrl: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<HealthResult>;
  createTailnet(credentials: TailnetCredentials): TailnetPort;
  /** Joins a sandbox to the tailnet as tag:rp-session without installing Pane (the coordinator's box). */
  joinTailnet(sandbox: SandboxHandle, request: JoinTailnetRequest, tailnet: TailnetCredentials): Promise<JoinedNode>;
  /** Re-enrols the node under the same hostname only if it is logged out (a resume can lose its state). */
  repairTailnet(sandbox: SandboxHandle, request: { hostname: string; oldNodeId?: string; restoreServe?: boolean }, tailnet: TailnetCredentials): Promise<TailnetRepair>;
  /**
   * On a running Session: installs the tailscaled.state and Serve guards and re-applies Tailscale Serve
   * if a resume lost it. Never stops anything.
   */
  repairServe(sandbox: SandboxHandle, request: { transport: 'https' | 'http' }): Promise<ServeRepair>;
}

interface ServeRepair {
  backendState: string;
  serveApplied: boolean;
  detail: string;
}

type TailnetRepair =
  | { reenrolled: false; backendState: string }
  | { reenrolled: true; previousBackendState: string; nodeId: string; magicDnsName: string; deletedNodeIds: string[] };

interface JoinTailnetRequest {
  sessionId: string;
  hostname: string;
  /** The only tcp ports the node accepts from the tailnet. */
  tailnetTcpPorts: number[];
  onStep?: (step: string) => void;
}

interface JoinedNode {
  nodeId: string;
  magicDnsName: string;
  tailscaleIps: string[];
}

type TailnetCredentials = NonNullable<CloudCredentials['tailscale']>;
