import os from 'os';
import { RemotePaneClient } from '../daemon/client/remotePaneClient';
import type { ConfigManager } from './configManager';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus } from '../../../shared/types/remoteDaemon';
import {
  LOCAL_MACHINE_ID,
  MACHINE_EVENT_CHANNELS,
  MACHINE_READ_CHANNELS,
  type MachineConnectionsEvent,
  type MachineEventChannel,
  type MachineResult,
  type MachineState,
} from '../../../shared/types/machineConnections';

/** A client gives up after its reconnect budget; a saved machine may sleep for hours, so try again this often. */
const RETRY_AFTER_GIVE_UP_MS = 60_000;

type RemoteClientOptions = NonNullable<ConstructorParameters<typeof RemotePaneClient>[1]>;
export type MachineClient = Pick<RemotePaneClient, 'connect' | 'disconnect' | 'retryNow' | 'invoke'>;
export type CreateMachineClient = (profile: RemotePaneConnectionProfile, options: RemoteClientOptions) => MachineClient;

export interface MachineConnectionsDeps {
  configManager: Pick<ConfigManager, 'getConfig' | 'on' | 'off'>;
  /** Runs a command on this computer, as its own command registry does. */
  invokeLocal: (channel: string, args: PaneCommandValue[]) => Promise<PaneCommandValue>;
  createClient?: CreateMachineClient;
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
const eventChannels = new Set<string>(MACHINE_EVENT_CHANNELS);
const isMachineEventChannel = (channel: string): channel is MachineEventChannel => eventChannels.has(channel);
const itemSchema = boundary.object({ kind: boundary.enumeration('pane', 'session'), id: boundary.nonEmptyString });
const commandTypeSchema = boundary.object({
  type: boundary.enumeration('notify', 'answer-permission', 'pin', 'archive', 'rename', 'create-pane', 'create-session'),
});
const commandSchemas = {
  notify: boundary.object({ command: boundary.jsonObject }),
  'answer-permission': boundary.object({ requestId: boundary.nonEmptyString, response: boundary.jsonObject }),
  pin: boundary.object({ target: itemSchema, pinned: boundary.boolean }),
  archive: boundary.object({ target: itemSchema }),
  rename: boundary.object({ target: itemSchema, name: boundary.nonEmptyString }),
  'create-pane': boundary.object({ request: boundary.jsonObject }),
  'create-session': boundary.object({ input: boundary.jsonObject }),
};

/**
 * The desktop's one connection to each saved machine, shared by key sharing and All machines.
 * Forwards each machine's list, permission, Notify and settings events tagged with the machine,
 * serves its list reads, and runs a short list of commands on it. This computer is the machine
 * `LOCAL_MACHINE_ID` and needs no connection.
 */
export class MachineConnections {
  private readonly machines = new Map<string, RemoteMachine>();
  private readonly listeners = new Set<(event: MachineConnectionsEvent) => void>();
  private readonly createClient: CreateMachineClient;
  private readonly onConfigUpdated = () => this.refresh();

  constructor(private readonly deps: MachineConnectionsDeps) {
    this.createClient = deps.createClient ?? ((profile, options) => new RemotePaneClient(profile, options));
  }

  start(): void {
    this.deps.configManager.on('config-updated', this.onConfigUpdated);
    this.refresh();
  }

  async stop(): Promise<void> {
    this.deps.configManager.off('config-updated', this.onConfigUpdated);
    const machines = [...this.machines.values()];
    this.machines.clear();
    await Promise.all(machines.map(machine => this.close(machine)));
  }

  list(): MachineState[] {
    const local: MachineState = { id: LOCAL_MACHINE_ID, label: 'This computer', kind: 'local', status: 'online', offlineSince: null };
    return [local, ...[...this.machines.values()].map(machine => ({ ...machine.state }))];
  }

  /** Every machine's events, resyncs and state changes. Returns the unsubscribe. */
  subscribe(listener: (event: MachineConnectionsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Each saved machine's connection, for main-process callers such as key sharing. Never reaches the renderer. */
  remotes(): Array<{ id: string; invoke: MachineClient['invoke'] }> {
    return [...this.machines.values()].map(machine => ({ id: machine.profile.id, invoke: (channel, args) => machine.client.invoke(channel, args) }));
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
    return { machineId, data: await this.invoke(machineId, { channel, args }) };
  }

  /** Runs one allowed command on the named machine. Anything outside the list is refused before it is sent. */
  async run(machineId: string, command: PaneCommandValue): Promise<MachineResult> {
    return { machineId, data: await this.invoke(machineId, toInvocation(command), { write: true }) };
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
      return this.deps.invokeLocal(channel, channel === 'notify:remote-command' ? [...args, { device: os.hostname() }] : args);
    }
    const machine = this.machines.get(machineId);
    if (!machine) throw unknownMachine(machineId);
    // Reads work over a stream that is still connecting; a write waits for the machine to answer.
    if (options.write && machine.state.status !== 'online') {
      throw new PaneError('ERR_MACHINE_OFFLINE',
        `${machine.profile.label} is not connected, so the action was not sent. Nothing was changed.`,
        `Use Retry on ${machine.profile.label}, then try again once it is back.`);
    }
    return machine.client.invoke(channel, args);
  }

  /** One connection per saved profile; a changed address or credential reconnects. */
  private refresh(): void {
    const profiles = this.deps.configManager.getConfig().remoteDaemon?.client.profiles ?? [];
    const wanted = new Map(profiles.map(profile => [profile.id, profile]));
    let changed = false;
    for (const [id, machine] of this.machines) {
      const profile = wanted.get(id);
      if (profile && connectionKey(profile) === machine.key) {
        if (machine.state.label !== profile.label) { machine.state.label = profile.label; changed = true; }
        continue;
      }
      this.machines.delete(id);
      void this.close(machine);
      changed = true;
    }
    for (const [id, profile] of wanted) {
      if (this.machines.has(id)) continue;
      this.open(profile);
      changed = true;
    }
    if (changed) this.emitMachines();
  }

  private open(profile: RemotePaneConnectionProfile): void {
    const id = profile.id;
    const isCurrent = (): boolean => this.machines.get(id) === machine;
    const machine: RemoteMachine = {
      key: connectionKey(profile),
      profile,
      retryTimer: null,
      state: { id, label: profile.label, kind: 'remote', status: 'connecting', offlineSince: null },
      client: this.createClient(profile, {
        eventSink: { send: (channel, ...args) => { if (isCurrent() && isMachineEventChannel(channel)) this.emit({ type: 'event', machineId: id, channel, args }); } },
        onConnectionStateChange: (status) => {
          if (!isCurrent()) return;
          this.updateStatus(machine, status);
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

  private updateStatus(machine: RemoteMachine, status: RemotePaneConnectionStatus): void {
    const { state } = machine;
    const before = `${state.status}|${state.offlineSince}`;
    if (status === 'connected') {
      state.status = 'online';
      state.offlineSince = null;
    } else if (status === 'reconnecting' || status === 'error') {
      // The time it first stopped answering, kept through every retry.
      if (state.status !== 'offline') state.offlineSince = new Date().toISOString();
      state.status = 'offline';
    }
    if (`${state.status}|${state.offlineSince}` !== before) this.emitMachines();
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
      `Pane can't run ${named ? `"${named}"` : 'that command'} on another machine: only answering Notify and permissions, pin, archive, rename and create are allowed. Nothing was sent.`,
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
        return { channel: 'orchestration-sessions:create', args: [decodeBoundary(command, commandSchemas['create-session']).input] };
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

function unknownMachine(machineId: string): PaneError {
  return new PaneError('ERR_MACHINE_UNKNOWN',
    `No saved machine has the id "${machineId}", so nothing was sent.`,
    'Read the machine list again with machines:list and use one of its ids.');
}

function connectionKey(profile: RemotePaneConnectionProfile): string {
  return `${profile.baseUrl}\n${profile.token}`;
}
