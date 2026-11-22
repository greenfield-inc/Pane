import type { JsonObject } from '../validation/boundaryDecoder';
import type { TodoAction, TodoCreateInput } from './todos';
import type { NotifyRemoteCommand } from './notify';
import type { OrchestrationSessionCreateInput } from './orchestrationSession';
import type { PanePermissionResponse } from './permissions';

/**
 * The renderer's way to read from, hear from and act on any machine the desktop knows: this
 * computer and every saved machine. Main keeps one connection per saved machine.
 */

/** The machine id of this computer; every other machine's id is its saved profile id. */
export const LOCAL_MACHINE_ID = 'local';

export interface MachineState {
  /** `LOCAL_MACHINE_ID`, or the saved profile id. */
  id: string;
  /** "This computer", or the saved profile's label. */
  label: string;
  kind: 'local' | 'remote';
  /** `connecting` until a saved machine first answers; `offline` once it stops answering. */
  status: 'online' | 'connecting' | 'offline';
  /** When it went offline (ISO 8601); null unless `status` is `offline`. */
  offlineSince: string | null;
  /** When a saved machine last came online (ISO 8601); absent unless `status` is `online`. */
  onlineSince?: string;
  /** The machine's install id ("Show cards on" names it by this): this computer's own, or a saved machine's from its last connection. Absent until it answers, and from releases before it. */
  installId?: string;
  /** The route a saved computer's connection is on (`ComputerRoute.id`): the dot on its pill. */
  routeId?: string;
  /** Whether the machine's Pane sends its Session members' reports; absent until it first answers. */
  workspaceEntries?: boolean;
}

/** A saved machine's round trip: `ms` null when it did not answer; `routeId` the route it was measured over (`ComputerRoute.id`). */
export interface MachineLatency {
  ms: number | null;
  routeId: string | null;
}

/** The reads `machines:read` serves; each takes the arguments the same channel takes today. */
export const MACHINE_READ_CHANNELS = [
  'sessions:get-all-with-projects',
  'orchestration-sessions:list',
  'orchestration-sessions:runtimes',
  'permission:getPending',
  'notify:remote-snapshot',
  // To-dos (D-409): another machine's to-dos, for the To-dos list.
  'todos:snapshot',
  'todos:detail',
  'autopilot:read-doc',
  'notify:summary-page',
  'panels:agent-statuses',
  'orchestration-sessions:activity-list',
  // A machine's loops, so the Sessions list can leave its loop Sessions out as that machine's own list does.
  'loops:list',
  'projects:get-all',
  'projects:list-branches',
  'projects:detect-branch',
  'remote:pwa-affordances',
  // Machine health (Resources): the snapshot, inventory, finished Panes, relief offer, cleanup history and other apps.
  'resource-monitor:machine-health',
  'resource-monitor:machine-inventory',
  'resource-monitor:machine-finished-panes',
  'resource-monitor:machine-relief',
  'resource-monitor:machine-cleanup-history',
  'resource-monitor:machine-apps',
  // Usage & Limits: one machine's usage report, accounts and provider limits.
  'usage:get-report',
] as const;
export type MachineReadChannel = typeof MACHINE_READ_CHANNELS[number];

/** The events forwarded on `machines:event`: lists, statuses, permissions, Notify and settings, never terminal output. */
export const MACHINE_EVENT_CHANNELS = [
  'session:created',
  'session:updated',
  'session:deleted',
  'sessions:loaded',
  'panel:created',
  'panel:updated',
  'panel:deleted',
  'panel:agentStatus',
  'panel:activityStatus',
  'orchestration-sessions:changed',
  'orchestration-sessions:activity',
  'project:updated',
  'project:list-changed',
  'permission:request',
  'permission:resolved',
  'notify:shared-changed',
  'remote:settings-changed',
  'workspace:entry',
  'resource-monitor:machine-health-changed',
  'resource-monitor:machine-inventory-changed',
] as const;
export type MachineEventChannel = typeof MACHINE_EVENT_CHANNELS[number];

/** A Pane (`sessions:*` row) or a Session (orchestration Session) on one machine. */
export interface MachineItemRef {
  kind: 'pane' | 'session';
  id: string;
}

/** The only actions `machines:run` performs on a named machine. Anything else is refused. */
export type MachineCommand =
  | { type: 'notify'; command: NotifyRemoteCommand }
  | { type: 'answer-permission'; requestId: string; response: PanePermissionResponse }
  | { type: 'pin'; target: MachineItemRef; pinned: boolean }
  | { type: 'archive'; target: MachineItemRef }
  /** Pause stops every tab of the Pane, or the Session's chat and Panes; resume restarts them. */
  | { type: 'pause' | 'resume'; target: MachineItemRef }
  | { type: 'rename'; target: MachineItemRef; name: string }
  /** `request` is the `CreateSessionRequest` that `sessions:create` takes. */
  | { type: 'create-pane'; request: object }
  | { type: 'create-session'; input: OrchestrationSessionCreateInput }
  /** What switching a Session's terminal agent tabs to chat would do, then doing it to the confirmed `panelIds`. */
  | { type: 'preview-switch-to-chat'; sessionId: string }
  | { type: 'switch-to-chat'; sessionId: string; panelIds: string[] }
  /** Sends `input` to an agent tab as the person's message (`runpane panels submit`); Move to machine… uses it. */
  | { type: 'submit-to-agent'; panelId: string; input: string }
  /** The Move dialog's calls on the machine the Session lives on (`SESSION_MOVE_CHANNELS`). */
  | { type: 'move-session'; channel: string; request: JsonObject }
  /** Machine health on that machine, through its own engine and protections. */
  | { type: 'machine-health'; action: MachineHealthAction; request: object }
  /** To-dos (D-409): the person's action on that machine's to-do (Stop, Resume, Start anyway…), or a new to-do there. */
  | { type: 'todo-act'; action: TodoAction }
  | { type: 'todo-create'; input: TodoCreateInput };

/** What Resources and its cards can ask another machine to do, each through that machine's own checks. */
export const MACHINE_HEALTH_ACTIONS = ['cleanup', 'pause-idle', 'archive-finished', 'stop-processes', 'restart-process', 'ignore-leak', 'stop-app'] as const;
export type MachineHealthAction = typeof MACHINE_HEALTH_ACTIONS[number];

/** A read's or command's answer, exactly as the machine gave it, tagged with that machine. */
export interface MachineResult {
  machineId: string;
  data: unknown;
}

/** What `machines:event` carries. */
export type MachineConnectionsEvent =
  /** One machine's event, as its own channel would deliver it. */
  | { type: 'event'; machineId: string; channel: MachineEventChannel; args: unknown[] }
  /** The machine (re)connected and sends no replay: read its lists again. */
  | { type: 'resync'; machineId: string }
  /** A machine was added, removed, or went online or offline. */
  | { type: 'machines'; machines: MachineState[] };
