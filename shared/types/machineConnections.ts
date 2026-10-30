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
}

/** The reads `machines:read` serves; each takes the arguments the same channel takes today. */
export const MACHINE_READ_CHANNELS = [
  'sessions:get-all-with-projects',
  'orchestration-sessions:list',
  'orchestration-sessions:runtimes',
  'permission:getPending',
  'notify:remote-snapshot',
  'panels:agent-statuses',
  'projects:get-all',
  'projects:list-branches',
  'projects:detect-branch',
  'remote:pwa-affordances',
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
  'project:updated',
  'project:list-changed',
  'permission:request',
  'permission:resolved',
  'notify:shared-changed',
  'remote:settings-changed',
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
  | { type: 'rename'; target: MachineItemRef; name: string }
  /** `request` is the `CreateSessionRequest` that `sessions:create` takes. */
  | { type: 'create-pane'; request: object }
  | { type: 'create-session'; input: OrchestrationSessionCreateInput };

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
