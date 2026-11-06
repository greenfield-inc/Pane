/**
 * Pane Cloud as desktop Pane sees it (Settings › Remote Access › Cloud sandboxes › Pane Cloud).
 * Main signs in to the Pane Cloud service with GitHub's device flow (identity only), creates the
 * seat's one machine, and saves it as a codeless Tailscale host once it joins the user's tailnet.
 * No user token reaches the service: GitHub and agent sign-in happen on the machine itself.
 */

export type PaneCloudSignIn =
  | { state: 'signed-out' }
  /** The device code to enter at `verificationUri`; main polls until the person approves. */
  | { state: 'pending'; userCode: string; verificationUri: string; expiresAt: string }
  | { state: 'signed-in'; githubLogin: string; name: string | null; access: 'invited' | 'waitlisted' };

export type PaneCloudMachineState =
  | 'creating' | 'running' | 'stopping' | 'stopped' | 'resuming' | 'deleting' | 'deleted' | 'error' | 'suspended';

/** Every lifecycle step and named operation the action log records. */
export type PaneCloudOperation =
  | 'create' | 'start' | 'stop' | 'delete' | 'bootstrap' | 'update_pane' | 'prepare_to_stop' | 'collect_diagnostics';

/** Why a machine last stopped or failed. */
export type PaneCloudStopReason =
  | 'user' | 'idle' | 'memory_pressure' | 'host_maintenance' | 'host_lost' | 'abuse' | 'billing' | 'end_of_beta' | 'failed';

/** A failure said the PaneError way: what happened and the next step. */
export interface PaneCloudError {
  message: string;
  next: string | null;
}

export interface PaneCloudUsage {
  cpuSecondsUsed: number;
  dailyCpuSeconds: number;
  /** The day's CPU budget is used; the machine runs at 0.5 vCPU until `resetsAt`. */
  throttled: boolean;
  resetsAt: string;
}

/** One entry of the machine's action log: every lifecycle step and operation, with who and why. */
export interface PaneCloudAction {
  id: string;
  operation: PaneCloudOperation;
  actor: 'you' | 'Pane Cloud' | 'the host';
  reason: string;
  status: 'accepted' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  requestedAt: string;
}

export interface PaneCloudMachineView {
  id: string;
  name: string;
  state: PaneCloudMachineState;
  /** Why it last stopped or failed (`idle`, `user`, `memory_pressure`…); null while it runs normally. */
  stateReason: PaneCloudStopReason | null;
  paneVersion: string | null;
  /** Open this link to join the machine to your tailnet; null once it has joined. */
  tailnetLoginUrl: string | null;
  /** MagicDNS name once joined. */
  tailnetHostname: string | null;
  /** The saved host Pane connects to, once the machine has joined. */
  profileId: string | null;
  usage: PaneCloudUsage | null;
  actions: PaneCloudAction[];
}

export type PaneCloudBusy = 'sign-in' | 'create' | 'start' | 'stop' | 'delete' | 'update';

export interface PaneCloudSnapshot {
  signIn: PaneCloudSignIn;
  machine: PaneCloudMachineView | null;
  busy: PaneCloudBusy | null;
  /** The last failure, said the PaneError way: what happened and the next step. */
  error: PaneCloudError | null;
}

export const SIGNED_OUT_PANE_CLOUD: PaneCloudSnapshot = { signIn: { state: 'signed-out' }, machine: null, busy: null, error: null };
