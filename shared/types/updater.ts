import type { HostNavigationMemory } from './hostNavigation';

export type UpdateMode = 'seamless' | 'manual';

export type UpdateModeReason =
  | 'platform-supported'
  | 'development-build'
  | 'trusted-dcouple-signature'
  | 'untrusted-signature';

export interface UpdateCapabilities {
  mode: UpdateMode;
  reason: UpdateModeReason;
}

/** What started a restart to update. `runpane` is reserved for runpane's in-app install. */
export type RestartToUpdateSource = 'toast' | 'pill' | 'tonight' | 'runpane';

/** The first reason that applies, in this order, when something is still running. */
export type UpdateBusyReason = 'agents' | 'run-script' | 'archive';

export interface UpdateBusyState {
  reason: UpdateBusyReason;
  /** Agents working or waiting for the user (blocked), counted across every Pane. */
  agentCount: number;
}

/** Restart-to-update state main publishes on `updater:restart-state` and returns from `updater:get-restart-state`. */
export interface RestartToUpdateState {
  /** Downloaded and ready to install on restart. */
  readyVersion: string | null;
  /** macOS manual mode only: a newer release exists but cannot be downloaded in the background. */
  availableVersion: string | null;
  /** Null when nothing is running. */
  busy: UpdateBusyState | null;
  /** Everything has been idle for the quiet hold, and neither Later nor Tonight is active. */
  idleToastDue: boolean;
  /** Epoch ms until which Later hides the idle toast; null when not snoozed. */
  snoozedUntil: number | null;
  /** The user chose Tonight for the ready update. */
  tonight: boolean;
}

/** Where the user was when Pane restarted to update, on the host shown then. */
export interface RestoredNavigation {
  /** Null means this computer. */
  hostId: string | null;
  memory: HostNavigationMemory;
}

/** Returned once on the launch after a restart to update. */
export interface UpdateRestoreResult {
  source: RestartToUpdateSource;
  fromVersion: string;
  /** The version now running. */
  toVersion: string;
  /** False when the relaunch kept the old version. */
  installed: boolean;
  /** Open (not archived) Panes that came back, resumed or reopened without an agent. */
  panesRestored: number;
  /** Panes with an agent that could not resume; they stay interrupted. */
  panesFailed: number;
  /** Null when nothing was remembered. */
  navigation: RestoredNavigation | null;
}
