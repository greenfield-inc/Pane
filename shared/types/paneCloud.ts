/**
 * Pane Cloud as desktop Pane sees it. Main signs in to the Pane Cloud service, creates one Session
 * VM per cloud Session, pairs this desktop with it over the relay (the VM is then a saved computer),
 * and creates the Session on it. The renderer never calls the service itself.
 */

export type PaneCloudSignIn =
  | { state: 'signed-out' }
  /** The person signs in on the service's page in the system browser; main polls until they finish. */
  | { state: 'pending'; userCode: string; verificationUri: string }
  | {
    state: 'signed-in';
    email: string;
    name: string | null;
    /** `waitlisted`: "You're on the list", and nothing can be created. */
    access: 'invited' | 'waitlisted';
    /** The next sign-up step on the service's page; nothing can be created until `ready`. */
    signupState: 'needs_phone' | 'needs_card' | 'ready';
    /** The service's sign-up page, for `needs_phone` and `needs_card`. */
    signupUrl: string;
    /** The organization cloud Sessions are created in: the account's personal one in the slice. */
    organizationId: string;
  };

/** A failure said the PaneError way: what happened and the next step. */
export interface PaneCloudError {
  message: string;
  next: string | null;
  /** The service's error code, when the service answered (`awake_limit_reached`, `no_capacity`…). */
  code?: string;
}

/** One cloud Session: its VM, and the saved computer it is once paired. No machine states: awake or stopped. */
export interface PaneCloudSession {
  vmId: string;
  name: string;
  /** Creating, starting or running: it counts toward the awake limit. */
  awake: boolean;
  /** Paused while Greenfield reviews unusual usage; it can't be started until the review ends. */
  underReview: boolean;
  /** The saved computer this desktop reaches it as; null until it is paired. */
  machineId: string | null;
  paneVersion: string | null;
  createdAt: string;
}

export interface PaneCloudMemberUsage {
  accountId: string;
  name: string | null;
  you: boolean;
  agentHours: number;
  awakeNow: number;
  awakeLimit: number;
}

/** The organization's month, as Usage & Limits shows it. */
export interface PaneCloudUsage {
  plan: 'free' | 'pro' | 'max';
  /** The month's hours reset then: the 1st of the next month, UTC. */
  resetsAt: string;
  agentHoursUsed: number;
  /** Pooled across the organization; null when the organization has no hour limit. */
  agentHoursLimit: number | null;
  /** Your Sessions awake now, across every organization (D-74), and your limit. */
  awakeNow: number;
  awakeLimit: number;
  members: PaneCloudMemberUsage[];
}

/** One entry of a cloud Session's action log: every lifecycle step and operation, with who and why (D-6). */
export interface PaneCloudAction {
  id: string;
  operation: string;
  actor: 'you' | 'Pane Cloud' | 'the host';
  reason: string;
  failed: boolean;
  error: string | null;
  requestedAt: string;
}

/** What New cloud Session is doing, in order. */
export type PaneCloudCreateStep = 'creating' | 'pairing' | 'starting-session';

export interface PaneCloudSnapshot {
  signIn: PaneCloudSignIn;
  sessions: PaneCloudSession[];
  usage: PaneCloudUsage | null;
  /** A cloud Session being created from this desktop, with the step it is on. */
  creating: { name: string; step: PaneCloudCreateStep } | null;
  /** VMs with a stop, start or delete in flight. */
  busy: string[];
  /** The last failure, said the PaneError way. */
  error: PaneCloudError | null;
}

/** The fields of Create Session that New cloud Session passes on to the Session on the VM. */
export interface PaneCloudCreateRequest {
  name: string;
  goal?: string;
  agent?: string;
  isPinned?: boolean;
}

/** A cloud Session made: the saved computer it is, and the Session on it, to open. */
export interface PaneCloudCreated {
  machineId: string;
  sessionId: string;
  snapshot: PaneCloudSnapshot;
}

export const SIGNED_OUT_PANE_CLOUD: PaneCloudSnapshot = { signIn: { state: 'signed-out' }, sessions: [], usage: null, creating: null, busy: [], error: null };
