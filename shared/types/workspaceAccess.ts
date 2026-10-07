/**
 * Who may reach this machine's Pane over Tailscale without a connection code: "owner" is
 * machines signed into this machine's own Tailscale login, "tailnet" is any person on the
 * current tailnet. "off" stops serving entirely.
 */
export type WorkspaceVisibility = 'off' | 'owner' | 'tailnet';

/** A scrypt hash of the optional password every codeless client must also present. */
export interface WorkspacePasswordHash {
  salt: string;
  hash: string;
}

export interface WorkspaceAccessConfig {
  /** Unset means on for the desktop Pane that owns ~/.pane. false is visibility "off". */
  enabled?: boolean;
  /** Unset means "owner". */
  visibility?: Exclude<WorkspaceVisibility, 'off'>;
  password?: WorkspacePasswordHash;
}

export interface WorkspaceAccessSummary {
  visibility: WorkspaceVisibility;
  passwordProtected: boolean;
  state: 'on' | 'off';
  /** Why this machine is not reachable, and the one step that fixes it. */
  reason?: string;
  fix?: string;
  machineName?: string;
  url?: string;
}

export interface WorkspaceAccessUpdate {
  visibility?: WorkspaceVisibility;
  /** A new password turns protection on; null turns it off. */
  password?: string | null;
}

export const WORKSPACE_PASSWORD_MIN_LENGTH = 8;

/** What a reachable machine says about itself to a client allowed to see it. */
export interface WorkspaceMachineDescription {
  machineName: string;
  visibility: Exclude<WorkspaceVisibility, 'off'>;
  passwordProtected: boolean;
  paneVersion: string;
}

export type TailnetMachineState =
  /** Pane answers and this client may connect. */
  | 'available'
  /** Pane answers, but needs the password before it lets this client in. */
  | 'password-required'
  /** Pane answers but predates visibility; it accepts only its owner. */
  | 'outdated'
  /** Online on Tailscale, but Pane is closed there or remote access is off. */
  | 'unreachable'
  | 'offline';

export interface TailnetMachine {
  name: string;
  dnsName: string;
  os: 'macOS' | 'Windows' | 'Linux';
  ownerLogin: string;
  /** Signed into the same Tailscale login as this machine. */
  mine: boolean;
  state: TailnetMachineState;
  visibility?: Exclude<WorkspaceVisibility, 'off'>;
  paneVersion?: string;
  /** A saved connection exists for this machine. */
  profileId?: string;
}

export type TailnetMachineList =
  /** `domain` is the tailnet's MagicDNS domain, such as `tail1234.ts.net`. */
  | { ok: true; tailnet: string; domain: string; machines: TailnetMachine[] }
  | { ok: false; reason: string; fix: string };
