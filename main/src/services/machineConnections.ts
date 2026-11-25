import type { WebSocket } from 'ws';
import { MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL, MACHINE_HEALTH_CLEANUP_CHANNEL, MACHINE_HEALTH_IGNORE_LEAK_CHANNEL, MACHINE_HEALTH_PAUSE_IDLE_CHANNEL, MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, MACHINE_HEALTH_STOP_APP_CHANNEL, MACHINE_HEALTH_STOP_PROCESSES_CHANNEL } from '../../../shared/types/machineHealth';
import os from 'os';
import { RemotePaneClient, type RemoteRouteCandidate } from '../daemon/client/remotePaneClient';
import { primaryProfile, routeProfile, routesReachableHere, type ComputerRoutesReport, type RemoteComputer } from '../../../shared/types/remoteComputers';
import type { ConfigManager } from './configManager';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { READ_ONLY_ACCESS_CODE } from '../../../shared/types/accessLevel';
import { READ_ONLY_HOST_ANSWERS } from '../../../shared/remoteClient/readOnlyHost';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus } from '../../../shared/types/remoteDaemon';
import type { OrchestrationPanelOverview } from '../../../shared/types/orchestrationSession';
import { configuredAgentSchema } from '../../../shared/agents';
import { SESSION_MOVE_CHANNELS } from '../../../shared/types/sessionMove';
import { agentReportFields } from './workspaceJournalSchema';
import type { RemoteMachineAccess } from './orchestrationSessionManager';
import { readingMachines } from '../daemon/readingMachines';
import {
  LOCAL_MACHINE_ID,
  MACHINE_EVENT_CHANNELS,
  MACHINE_HEALTH_ACTIONS,
  MACHINE_READ_CHANNELS,
  type MachineHealthAction,
  type MachineConnectionsEvent,
  type MachineEventChannel,
  type MachineLatency,
  type MachineResult,
  type MachineState,
} from '../../../shared/types/machineConnections';

/** A client gives up after its reconnect budget; a saved machine may sleep for hours, so try again this often. */
const RETRY_AFTER_GIVE_UP_MS = 60_000;

type RemoteClientOptions = NonNullable<ConstructorParameters<typeof RemotePaneClient>[1]>;
export type MachineClient = Pick<RemotePaneClient, 'connect' | 'disconnect' | 'retryNow' | 'invoke' | 'suspend' | 'resume' | 'openPortStream' | 'measureLatency'>;
export type CreateMachineClient = (profile: RemotePaneConnectionProfile, options: RemoteClientOptions) => MachineClient;

export interface MachineConnectionsDeps {
  configManager: Pick<ConfigManager, 'getConfig' | 'on' | 'off'>;
  /** Runs a command on this computer, as its own command registry does. */
  invokeLocal: (channel: string, args: PaneCommandValue[]) => Promise<PaneCommandValue>;
  createClient?: CreateMachineClient;
  /** Readies a route before it is dialed, and saves what a computer reports about itself; the remote client controller's. */
  routes?: {
    prepare(route: RemoteRouteCandidate): Promise<RemotePaneConnectionProfile>;
    saveReport(computerId: string, routeId: string | undefined, report: ComputerRoutesReport): Promise<void>;
  };
}

interface RemoteMachine {
  key: string;
  profile: RemotePaneConnectionProfile;
  client: MachineClient;
  state: MachineState;
  retryTimer: NodeJS.Timeout | null;
}

/** A host channel and its arguments, for one allowed command. */
interface Invocation {
  channel: string;
  args: PaneCommandValue[];
}

const readChannels = new Set<string>(MACHINE_READ_CHANNELS);
const MACHINE_HEALTH_ACTION_CHANNELS = {
  cleanup: MACHINE_HEALTH_CLEANUP_CHANNEL,
  'pause-idle': MACHINE_HEALTH_PAUSE_IDLE_CHANNEL,
  'archive-finished': MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL,
  'stop-processes': MACHINE_HEALTH_STOP_PROCESSES_CHANNEL,
  'restart-process': MACHINE_HEALTH_RESTART_PROCESS_CHANNEL,
  'ignore-leak': MACHINE_HEALTH_IGNORE_LEAK_CHANNEL,
  'stop-app': MACHINE_HEALTH_STOP_APP_CHANNEL,
} as const satisfies Record<MachineHealthAction, string>;
const eventChannels = new Set<string>(MACHINE_EVENT_CHANNELS);
const isMachineEventChannel = (channel: string): channel is MachineEventChannel => eventChannels.has(channel);
const itemSchema = boundary.object({ kind: boundary.enumeration('pane', 'session'), id: boundary.nonEmptyString });
const commandTypeSchema = boundary.object({
  type: boundary.enumeration('notify', 'answer-permission', 'pin', 'pause', 'resume', 'archive', 'rename', 'create-pane', 'create-session', 'preview-switch-to-chat', 'switch-to-chat', 'submit-to-agent', 'machine-health', 'todo-act', 'todo-create', 'move-session'),
});
const commandSchemas = {
  notify: boundary.object({ command: boundary.jsonObject }),
  'answer-permission': boundary.object({ requestId: boundary.nonEmptyString, response: boundary.jsonObject }),
  pin: boundary.object({ target: itemSchema, pinned: boundary.boolean }),
  archive: boundary.object({ target: itemSchema }),
  pause: boundary.object({ target: itemSchema }),
  resume: boundary.object({ target: itemSchema }),
  rename: boundary.object({ target: itemSchema, name: boundary.nonEmptyString }),
  'create-pane': boundary.object({ request: boundary.jsonObject }),
  'create-session': boundary.object({ input: boundary.jsonObject }),
  'preview-switch-to-chat': boundary.object({ sessionId: boundary.nonEmptyString }),
  'switch-to-chat': boundary.object({ sessionId: boundary.nonEmptyString, panelIds: boundary.array(boundary.nonEmptyString) }),
  'machine-health': boundary.object({ action: boundary.enumeration(...MACHINE_HEALTH_ACTIONS), request: boundary.jsonObject }),
  'submit-to-agent': boundary.object({ panelId: boundary.nonEmptyString, input: boundary.nonEmptyString }),
  'todo-act': boundary.object({ action: boundary.jsonObject }),
  'todo-create': boundary.object({ input: boundary.jsonObject }),
  'move-session': boundary.object({ channel: boundary.enumeration(...Object.values(SESSION_MOVE_CHANNELS)), request: boundary.jsonObject }),
};

/**
 * The desktop's one connection to each saved machine, shared by key sharing and All machines.
 * Forwards each machine's list, permission, Notify and settings events tagged with the machine,
 * serves its list reads, and runs a short list of commands on it. This computer is the machine
 * `LOCAL_MACHINE_ID` and needs no connection.
 */
export class MachineConnections {
  private readonly machines = new Map<string, RemoteMachine>();
  private readonly latencies = new Map<string, Promise<MachineLatency>>();
  private readonly listeners = new Set<(event: MachineConnectionsEvent) => void>();
  private readonly createClient: CreateMachineClient;
  private readonly onConfigUpdated = () => this.refresh();
  private stopRetryOnArrival: (() => void) | null = null;

  constructor(private readonly deps: MachineConnectionsDeps) {
    this.createClient = deps.createClient ?? ((profile, options) => new RemotePaneClient(profile, options));
  }

  start(): void {
    this.deps.configManager.on('config-updated', this.onConfigUpdated);
    // A machine back from sleep reopens its streams to the machines it reads, this one among them,
    // before this one's next retry would reach it: try every offline machine now.
    this.stopRetryOnArrival = readingMachines.onArrive(() => this.retryOffline());
    this.refresh();
  }

  async stop(): Promise<void> {
    this.deps.configManager.off('config-updated', this.onConfigUpdated);
    this.stopRetryOnArrival?.();
    this.stopRetryOnArrival = null;
    const machines = [...this.machines.values()];
    this.machines.clear();
    await Promise.all(machines.map(machine => this.close(machine)));
  }

  /**
   * Closes every saved machine's stream before this computer sleeps, so the machines it reads stop
   * counting it as reading ("Show cards on") instead of holding a half-open stream. `resume` reopens them.
   */
  suspend(): void {
    for (const machine of this.machines.values()) machine.client.suspend();
  }

  resume(): void {
    for (const machine of this.machines.values()) machine.client.resume();
  }

  list(): MachineState[] {
    const local: MachineState = { id: LOCAL_MACHINE_ID, label: 'This computer', kind: 'local', status: 'online', offlineSince: null };
    const installId = this.deps.configManager.getConfig().machineId;
    if (installId) local.installId = installId;
    return [local, ...[...this.machines.values()].map(machine => ({ ...machine.state }))];
  }

  /** Every machine's events, resyncs and state changes. Returns the unsubscribe. */
  subscribe(listener: (event: MachineConnectionsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * The connection to each saved machine this computer has full access to, for main-process callers
   * that share this computer's data (key sharing, secret leases). Never reaches the renderer.
   */
  remotes(): Array<{ id: string; invoke: MachineClient['invoke'] }> {
    return [...this.machines.values()].filter(machine => machine.state.access !== 'read').map(machine => ({ id: machine.profile.id, invoke: (channel, args) => machine.client.invoke(channel, args) }));
  }

  /** Runs any host channel on a saved machine, for main-process callers (Session members). Never reaches the renderer. */
  async invokeOn(machineId: string, channel: string, args: PaneCommandValue[], timeoutMs?: number): Promise<PaneCommandValue> {
    const machine = this.machines.get(machineId);
    if (!machine) throw unknownMachine(machineId);
    // Only a member Pane's overview is read there; everything else is sent for this computer's own work.
    if (channel !== 'runpane:panes:overview') refuseReadOnly(machine);
    const call = machine.client.invoke(channel, args);
    if (timeoutMs === undefined) return call;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PaneError('ERR_MACHINE_TIMEOUT', `${machine.profile.label} did not answer within ${timeoutMs / 1000} s.`, `Check that Pane is running on ${machine.profile.label}.`)), timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One raw byte stream to a loopback port on a saved machine, without switching to it (a linked Mac's device hub). Main only. */
  openPortStream(machineId: string, port: number): WebSocket {
    const machine = this.machines.get(machineId);
    if (!machine) throw unknownMachine(machineId);
    refuseReadOnly(machine);
    return machine.client.openPortStream(port);
  }

  /**
   * A saved machine's round trip over the route its connection is on, named so the caller can tell it
   * is the route it shows. Not online: no answer, without a request. Asked again while one measurement
   * runs, it answers with that one, so quick reopens of a menu never stack handshakes.
   */
  measureLatency(machineId: string): Promise<MachineLatency> {
    const machine = this.machines.get(machineId);
    if (!machine) return Promise.reject(unknownMachine(machineId));
    const routeId = machine.state.routeId ?? null;
    if (machine.state.status !== 'online') return Promise.resolve({ ms: null, routeId });
    const running = this.latencies.get(machineId);
    if (running) return running;
    const measured = machine.client.measureLatency()
      .then((ms): MachineLatency => ({ ms, routeId }))
      .finally(() => this.latencies.delete(machineId));
    this.latencies.set(machineId, measured);
    return measured;
  }

  /** A saved machine's current state, or undefined for an unknown id. */
  machineState(machineId: string): MachineState | undefined {
    const machine = this.machines.get(machineId);
    return machine ? { ...machine.state } : undefined;
  }

  /** An event raised on this computer; list events are forwarded as `LOCAL_MACHINE_ID`'s. */
  forwardLocal(channel: string, args: unknown[]): void {
    if (isMachineEventChannel(channel)) this.emit({ type: 'event', machineId: LOCAL_MACHINE_ID, channel, args });
  }

  async read(machineId: string, channel: string, args: PaneCommandValue[] = []): Promise<MachineResult> {
    if (!readChannels.has(channel)) {
      throw new PaneError('ERR_MACHINE_READ_REFUSED',
        `Pane can't read "${channel}" from another machine: only its lists can be read this way. Nothing was read.`,
        `Use one of ${MACHINE_READ_CHANNELS.join(', ')}.`);
    }
    const answer = this.machines.get(machineId)?.state.access === 'read' ? READ_ONLY_HOST_ANSWERS.get(channel) : undefined;
    return { machineId, data: answer !== undefined ? answer : await this.invoke(machineId, { channel, args }) };
  }

  /** Runs one allowed command on the named machine. Anything outside the list is refused before it is sent. */
  async run(machineId: string, command: PaneCommandValue): Promise<MachineResult> {
    return { machineId, data: await this.invoke(machineId, toInvocation(command), { write: true }) };
  }

  private retryOffline(): void {
    for (const [id, machine] of this.machines) {
      if (machine.state.status === 'offline') void this.retry(id).catch(() => undefined);
    }
  }

  /** Reconnects a saved machine now instead of waiting for its next retry. */
  async retry(machineId: string): Promise<void> {
    const machine = this.machines.get(machineId);
    if (!machine) throw unknownMachine(machineId);
    clearRetry(machine);
    await machine.client.retryNow();
  }

  private async invoke(machineId: string, { channel, args }: Invocation, options: { write?: boolean } = {}): Promise<PaneCommandValue> {
    if (machineId === LOCAL_MACHINE_ID) {
      // This computer's Notify takes the sender the HTTP server would add for a remote screen.
      return this.deps.invokeLocal(channel, channel === 'notify:remote-command' ? [...args, { device: os.hostname().split('.')[0] }] : args);
    }
    const machine = this.machines.get(machineId);
    if (!machine) throw unknownMachine(machineId);
    // Reads work over a stream that is still connecting; a write waits for the machine to answer.
    if (options.write) refuseReadOnly(machine);
    if (options.write && machine.state.status !== 'online') {
      throw new PaneError('ERR_MACHINE_OFFLINE',
        `${machine.profile.label} is not connected, so the action was not sent. Nothing was changed.`,
        `Use Retry on ${machine.profile.label}, then try again once it is back.`);
    }
    return machine.client.invoke(channel, args);
  }

  /** One connection per saved computer; a changed route or credential reconnects. */
  private refresh(): void {
    const computers = this.deps.configManager.getConfig().remoteDaemon?.client.computers ?? [];
    const wanted = new Map(computers.map(computer => [computer.id, computer]));
    let changed = false;
    for (const [id, machine] of this.machines) {
      const computer = wanted.get(id);
      if (computer && connectionKey(computer) === machine.key) {
        if (machine.state.label !== computer.label) { machine.state.label = computer.label; changed = true; }
        continue;
      }
      this.machines.delete(id);
      void this.close(machine);
      changed = true;
    }
    for (const [id, computer] of wanted) {
      if (this.machines.has(id) || !computer.routes.length) continue;
      this.open(computer);
      changed = true;
    }
    if (changed) this.emitMachines();
  }

  private open(computer: RemoteComputer): void {
    const profile = primaryProfile(computer);
    const id = profile.id;
    const isCurrent = (): boolean => this.machines.get(id) === machine;
    const routes = routesReachableHere(computer.routes, Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []))
      .map((route) => ({ routeId: route.id, kind: route.kind, profile: routeProfile(computer, route) }));
    const machine: RemoteMachine = {
      key: connectionKey(computer),
      profile,
      retryTimer: null,
      state: { id, label: profile.label, kind: 'remote', status: 'connecting', offlineSince: null, ...(profile.access && { access: profile.access }) },
      client: this.createClient(profile, {
        machineId: this.deps.configManager.getConfig().machineId,
        routes,
        prepareRoute: (route) => this.deps.routes?.prepare(route) ?? Promise.resolve(route.profile),
        eventSink: { send: (channel, ...args) => { if (isCurrent() && isMachineEventChannel(channel)) this.emit({ type: 'event', machineId: id, channel, args }); } },
        onConnectionStateChange: (status, _error, metadata) => {
          if (!isCurrent()) return;
          if (metadata?.hostRoutes) void this.deps.routes?.saveReport(id, metadata.routeId, metadata.hostRoutes);
          if (metadata?.routeId && machine.state.routeId !== metadata.routeId) { machine.state.routeId = metadata.routeId; this.emitMachines(); }
          // Each ready event ("restoring") says this computer's access anew; no mark means full.
          if (status === 'restoring' && machine.state.access !== metadata?.hostAccess) {
            if (metadata?.hostAccess) machine.state.access = metadata.hostAccess;
            else delete machine.state.access;
            this.emitMachines();
          }
          this.updateStatus(machine, status, metadata?.hostMachineId, metadata?.hostWorkspaceEntries);
          if (status === 'connected') clearRetry(machine);
          if (status === 'error' && !machine.retryTimer) {
            machine.retryTimer = setTimeout(() => {
              machine.retryTimer = null;
              if (isCurrent()) void machine.client.connect().catch(() => undefined);
            }, RETRY_AFTER_GIVE_UP_MS);
          }
        },
        onResyncRequired: () => { if (isCurrent()) this.emit({ type: 'resync', machineId: id }); },
      }),
    };
    this.machines.set(id, machine);
    void machine.client.connect().catch(() => undefined);
  }

  private async close(machine: RemoteMachine): Promise<void> {
    clearRetry(machine);
    await machine.client.disconnect();
  }

  private updateStatus(machine: RemoteMachine, status: RemotePaneConnectionStatus, hostMachineId?: string, workspaceEntries?: boolean): void {
    const { state } = machine;
    const before = `${state.status}|${state.offlineSince}|${state.installId}|${state.workspaceEntries}`;
    if (hostMachineId) state.installId = hostMachineId;
    if (workspaceEntries !== undefined) state.workspaceEntries = workspaceEntries;
    if (status === 'connected') {
      if (state.status !== 'online') state.onlineSince = new Date().toISOString();
      state.status = 'online';
      state.offlineSince = null;
    } else if (status === 'reconnecting' || status === 'error') {
      // The time it first stopped answering, kept through every retry.
      if (state.status !== 'offline') state.offlineSince = new Date().toISOString();
      state.status = 'offline';
      delete state.onlineSince;
    }
    if (`${state.status}|${state.offlineSince}|${state.installId}|${state.workspaceEntries}` !== before) this.emitMachines();
  }

  private emitMachines(): void {
    this.emit({ type: 'machines', machines: this.list() });
  }

  private emit(event: MachineConnectionsEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[MachineConnections] A listener failed:', reasonOf(error));
      }
    }
  }
}

/** The one host channel each allowed command runs, with its arguments. */
function toInvocation(command: PaneCommandValue): Invocation {
  const type = decodeOptionalBoundary(command, commandTypeSchema)?.type;
  if (!type) {
    const named = decodeOptionalBoundary(command, boundary.object({ type: boundary.string }))?.type;
    throw new PaneError('ERR_MACHINE_COMMAND_REFUSED',
      `Pane can't run ${named ? `"${named}"` : 'that command'} on another machine: only answering Notify and permissions, pin, pause, resume, archive, rename, create, switching a Session to chat, asking a Session's agent to hand it off, machine health actions and moving a Session are allowed. Nothing was sent.`,
      'Switch to that machine to do this there.');
  }
  try {
    switch (type) {
      case 'notify':
        return { channel: 'notify:remote-command', args: [decodeBoundary(command, commandSchemas.notify).command] };
      case 'answer-permission': {
        const { requestId, response } = decodeBoundary(command, commandSchemas['answer-permission']);
        return { channel: 'permission:respond', args: [requestId, response] };
      }
      case 'pin': {
        const { target, pinned } = decodeBoundary(command, commandSchemas.pin);
        // `sessions:toggle-favorite` flips; this sets the state, so overlapping pins agree.
        return target.kind === 'pane'
          ? { channel: 'runpane:panes:pin', args: [{ paneId: target.id, pinned }] }
          : { channel: 'orchestration-sessions:update', args: [{ sessionId: target.id }, { isPinned: pinned }] };
      }
      case 'pause':
      case 'resume': {
        const { target } = decodeBoundary(command, commandSchemas[type]);
        return target.kind === 'pane'
          ? { channel: `runpane:panes:${type}`, args: [{ paneId: target.id }] }
          : { channel: `runpane:sessions:${type}`, args: [{ sessionId: target.id }] };
      }
      case 'archive': {
        const { target } = decodeBoundary(command, commandSchemas.archive);
        return target.kind === 'pane'
          ? { channel: 'sessions:delete', args: [target.id] }
          : { channel: 'orchestration-sessions:update', args: [{ sessionId: target.id }, { archived: true }] };
      }
      case 'rename': {
        const { target, name } = decodeBoundary(command, commandSchemas.rename);
        return target.kind === 'pane'
          ? { channel: 'sessions:rename', args: [target.id, name] }
          : { channel: 'orchestration-sessions:update', args: [{ sessionId: target.id }, { name }] };
      }
      case 'create-pane':
        return { channel: 'sessions:create', args: [decodeBoundary(command, commandSchemas['create-pane']).request] };
      case 'create-session':
        // This desktop shows chat tabs, so the Session may start as one (D-203).
        return { channel: 'orchestration-sessions:create', args: [decodeBoundary(command, commandSchemas['create-session']).input, { chatTabs: true, chatAgents: true }] };
      case 'preview-switch-to-chat':
        return { channel: 'chat-tab:preview-session-switch', args: [decodeBoundary(command, commandSchemas['preview-switch-to-chat']).sessionId] };
      case 'switch-to-chat': {
        const { sessionId, panelIds } = decodeBoundary(command, commandSchemas['switch-to-chat']);
        return { channel: 'chat-tab:switch-session', args: [sessionId, panelIds] };
      }
      case 'move-session': {
        // The Move dialog in All machines drives a move that machine runs; only the dialog's own calls pass.
        const { channel, request } = decodeBoundary(command, commandSchemas['move-session']);
        return { channel, args: [request] };
      }
      case 'machine-health': {
        // The host decodes the request and applies its own tiers and protections.
        const { action, request } = decodeBoundary(command, commandSchemas['machine-health']);
        return { channel: MACHINE_HEALTH_ACTION_CHANNELS[action], args: [request] };
      }
      case 'submit-to-agent': {
        // Sent as the person's message, the way the move dialog sends it to the host on screen.
        const { panelId, input } = decodeBoundary(command, commandSchemas['submit-to-agent']);
        return { channel: 'runpane:panels:submit', args: [{ panelId, input, source: 'user' }] };
      }
      // To-dos (D-409): the host decodes the action and applies its own rules, as the person.
      case 'todo-act':
        return { channel: 'todos:act', args: [decodeBoundary(command, commandSchemas['todo-act']).action] };
      case 'todo-create':
        return { channel: 'todos:create', args: [decodeBoundary(command, commandSchemas['todo-create']).input] };
    }
  } catch (error) {
    throw new PaneError('ERR_MACHINE_COMMAND_INVALID',
      `Pane can't send "${type}" to another machine: ${reasonOf(error)}. Nothing was sent.`,
      'Fix the field named above and try again.');
  }
}

function clearRetry(machine: RemoteMachine): void {
  if (machine.retryTimer) clearTimeout(machine.retryTimer);
  machine.retryTimer = null;
}

/** Nothing is sent to a machine this computer is paired Read only with, so it never sees what its host would refuse. */
function refuseReadOnly(machine: RemoteMachine): void {
  if (machine.state.access !== 'read') return;
  throw new PaneError(READ_ONLY_ACCESS_CODE,
    `This computer is paired Read only with ${machine.profile.label}, so the action was not sent. Nothing was changed.`,
    `Ask ${machine.profile.label}'s owner for full access.`);
}

function unknownMachine(machineId: string): PaneError {
  return new PaneError('ERR_MACHINE_UNKNOWN',
    `No saved machine has the id "${machineId}", so nothing was sent.`,
    'Read the machine list again with machines:list and use one of its ids.');
}

/** A route's level is in its token, so a new level arrives as a new token. */
function connectionKey(computer: RemoteComputer): string {
  return computer.routes.map((route) => `${route.id}\n${route.baseUrl}\n${route.token}`).join('\n');
}

/** How long a Session overview waits for a member's machine before showing it unreachable. */
const MEMBER_READ_TIMEOUT_MS = 4_000;
const panelOverviewSchema: BoundarySchema<OrchestrationPanelOverview> = boundary.object({
  panelId: boundary.string,
  title: boundary.string,
  type: boundary.optional(boundary.enumeration('terminal', 'chat', 'diff', 'explorer', 'editor', 'logs', 'dashboard', 'setup-tasks', 'browser', 'notes', 'device')),
  agentType: boundary.optional(configuredAgentSchema),
  state: boundary.enumeration('blocked', 'working', 'idle', 'unknown'),
  initialized: boundary.boolean,
  lastActivityAt: boundary.optional(boundary.string),
  missing: boundary.optional(boundary.boolean),
  report: boundary.optional(boundary.object({ ...agentReportFields, data: boundary.optional(boundary.jsonObject) })),
});
/** A member's row as its machine's `runpane:panes:overview` returns it. */
const paneOverviewResultSchema = boundary.object({
  pane: boundary.object({
    paneId: boundary.string,
    name: boundary.string,
    worktreePath: boundary.optional(boundary.string),
    branch: boundary.optional(boundary.string),
    archived: boundary.boolean,
    missing: boundary.boolean,
    panels: boundary.array(panelOverviewSchema),
    git: boundary.optional(boundary.object({
      state: boundary.string,
      ahead: boundary.optional(boundary.number),
      behind: boundary.optional(boundary.number),
      hasUncommittedChanges: boundary.optional(boundary.boolean),
      hasUntrackedFiles: boundary.optional(boundary.boolean),
      prNumber: boundary.optional(boundary.number),
      prUrl: boundary.optional(boundary.string),
      prTitle: boundary.optional(boundary.string),
      prState: boundary.optional(boundary.string),
    })),
    report: boundary.optional(boundary.object({ ...agentReportFields, panelId: boundary.string })),
  }),
});

/** The Session manager's view of the saved machines: remote members' rows and whether each machine sends their reports. */
export function remoteMachineAccess(machines: MachineConnections): RemoteMachineAccess {
  return {
    forwardsReports: machineId => machines.machineState(machineId)?.workspaceEntries,
    readPane: async (machineId, paneId) => {
      const state = machines.machineState(machineId);
      if (!state || state.status === 'offline') return 'unreachable';
      if (state.workspaceEntries === false) return 'older-pane';
      try {
        const result = decodeBoundary(await machines.invokeOn(machineId, 'runpane:panes:overview', [{ paneId }], MEMBER_READ_TIMEOUT_MS), paneOverviewResultSchema);
        return result.pane;
      } catch {
        return 'unreachable';
      }
    },
  };
}
