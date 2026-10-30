import { preferredMachineColorSlot } from '../../../shared/utils/machineColor';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { MachineCommand, MachineReadChannel, MachineResult, MachineState } from '../../../shared/types/machineConnections';
import type { OrchestrationSessionCreateInput } from '../../../shared/types/orchestrationSession';
import type { CreateSessionRequest } from '../types/session';
import type { MachineEntry, MachineOs } from './machineList';
import { startOwnPaneCreation } from './ownPaneCreations';

/**
 * The New dialog's machines: which ones it offers, which one it starts on, and how it reads
 * another machine's lists and creates there. The machine the app is on keeps today's stores.
 */

/** The machine New last created on from this computer; kept across relaunch. */
const LAST_MACHINE_KEY = 'pane.new.lastMachine';

export interface NewMachine {
  /** `LOCAL_MACHINE_ID` or a saved profile id, as `window.electronAPI.machines` takes it. */
  id: string;
  name: string;
  os: MachineOs | null;
  slot: number;
  status: MachineState['status'];
  /** The machine the app is on now. */
  current: boolean;
}

export interface RepositoryOption {
  id: number;
  name: string;
}

export interface BranchOption {
  name: string;
  isCurrent: boolean;
  hasWorktree: boolean;
  isRemote: boolean;
}

/** A reply in the `{ success, data, error }` shape every listed channel answers with. */
interface MachineReply {
  success: boolean;
  error?: string;
  details?: string;
  command?: string;
}

/**
 * Every machine the desktop keeps a connection to, named and marked as the machine menu shows
 * it. The machine the app is on is always usable, whatever its own connection reports.
 */
export function newMachines(states: readonly MachineState[], entries: readonly MachineEntry[], currentId: string): NewMachine[] {
  const known = states.length > 0 ? states : [{ id: currentId, label: 'This computer', kind: 'local', status: 'online', offlineSince: null } satisfies MachineState];
  return known.map((state) => {
    const entry = entries.find((candidate) => candidate.id === state.id);
    const name = entry?.name ?? state.label;
    const current = state.id === currentId;
    return { id: state.id, name, os: entry?.os ?? null, slot: entry?.slot ?? preferredMachineColorSlot(name), status: current ? 'online' : state.status, current };
  });
}

export function lastNewMachineId(): string | null {
  try {
    return window.localStorage.getItem(LAST_MACHINE_KEY);
  } catch {
    return null;
  }
}

export function rememberNewMachine(machineId: string): void {
  try {
    window.localStorage.setItem(LAST_MACHINE_KEY, machineId);
  } catch {
    // Without storage, New starts on the machine the app is on next time.
  }
}

/** The machine New last created on when it can take a create now; otherwise the machine the app is on. */
export function startingNewMachineId(machines: readonly NewMachine[]): string | undefined {
  const last = lastNewMachineId();
  return machines.find((machine) => machine.id === last && machine.status === 'online')?.id
    ?? machines.find((machine) => machine.current)?.id
    ?? machines[0]?.id;
}

const replySchema = boundary.object({
  success: boundary.boolean,
  error: boundary.optional(boundary.nullable(boundary.string)),
  details: boundary.optional(boundary.nullable(boundary.string)),
  command: boundary.optional(boundary.nullable(boundary.string)),
  data: boundary.optional(boundary.json),
});

const repositoriesSchema = boundary.array(boundary.object({ id: boundary.number, name: boundary.string }));
const branchesSchema = boundary.array(boundary.object({
  name: boundary.string,
  isCurrent: boundary.boolean,
  hasWorktree: boundary.boolean,
  isRemote: boundary.boolean,
}));
const runtimesSchema = boundary.object({ distributions: boundary.array(boundary.string) });
const sessionNamesSchema = boundary.object({ sessions: boundary.array(boundary.object({ name: boundary.string })) });
const createdPaneSchema = boundary.object({ id: boundary.nonEmptyString, clientRequestId: boundary.optional(boundary.string) });
/** `orchestration-sessions:create` answers with the Session's view; its record is `session`. */
const createdSessionSchema = boundary.object({ session: boundary.object({ id: boundary.nonEmptyString }) });

function machinesApi() {
  const api = window.electronAPI?.machines;
  if (!api) throw new Error('This version of Pane cannot reach other machines. Nothing was read or created. Update Pane, then try again.');
  return api;
}

// The transport answer of machines:read and machines:run, parsed here once.
function toReply(result: MachineResult): MachineReply & { data?: JsonValue } {
  const reply = decodeBoundary(result.data, replySchema);
  return { success: reply.success, error: reply.error ?? undefined, details: reply.details ?? undefined, command: reply.command ?? undefined, data: reply.data };
}

async function read<Value>(machineId: string, machineName: string, channel: MachineReadChannel, args: string[], schema: BoundarySchema<Value>): Promise<Value> {
  const reply = toReply(await machinesApi().read(machineId, channel, args));
  if (!reply.success) throw new Error(`${machineName} did not answer: ${reply.error ?? 'it gave no reason'}. Pick the machine again to retry.`);
  return decodeBoundary(reply.data, schema);
}

async function run(machineId: string, command: MachineCommand): Promise<MachineReply & { data?: JsonValue }> {
  return toReply(await machinesApi().run(machineId, command));
}

/** The machine's repositories, in its own order. */
export function readRepositories(machine: Pick<NewMachine, 'id' | 'name'>): Promise<RepositoryOption[]> {
  return read(machine.id, machine.name, 'projects:get-all', [], repositoriesSchema);
}

/** The repository's branches on that machine, answered as `projects:list-branches` answers today. */
export async function readBranches(machine: Pick<NewMachine, 'id' | 'name'>, repositoryId: number): Promise<{ success: boolean; data?: BranchOption[] }> {
  return { success: true, data: await read(machine.id, machine.name, 'projects:list-branches', [String(repositoryId)], branchesSchema) };
}

/** The WSL distributions a Session can run in there; none outside Windows. */
export async function readRuntimes(machine: Pick<NewMachine, 'id' | 'name'>): Promise<{ success: boolean; data?: { distributions: string[] } }> {
  return { success: true, data: await read(machine.id, machine.name, 'orchestration-sessions:runtimes', [], runtimesSchema) };
}

/** The names of the machine's Sessions, so an unnamed Session gets the next free name there. */
export async function readSessionNames(machine: Pick<NewMachine, 'id' | 'name'>): Promise<Array<{ name: string }>> {
  return (await read(machine.id, machine.name, 'orchestration-sessions:list', [], sessionNamesSchema)).sessions;
}

export interface PaneCreation {
  reply: MachineReply;
  /** The new Panes' ids, filled as the machine reports each one created; the host may suffix their names. */
  createdIds: string[];
  /** Stops listening for more of them. */
  stop: () => void;
}

/** Creates Panes on the machine and collects their ids, so this desktop opens them once it is on that machine. */
export async function createPaneOn(machine: Pick<NewMachine, 'id'>, request: CreateSessionRequest): Promise<PaneCreation> {
  const api = machinesApi();
  const clientRequestId = startOwnPaneCreation();
  const createdIds: string[] = [];
  const stop = api.onEvent((event) => {
    if (event.type !== 'event' || event.machineId !== machine.id || event.channel !== 'session:created') return;
    const created = decodeOptionalBoundary(event.args[0], createdPaneSchema);
    if (created?.clientRequestId === clientRequestId) createdIds.push(created.id);
  });
  try {
    const reply = await run(machine.id, { type: 'create-pane', request: { ...request, clientRequestId } });
    if (!reply.success) stop();
    return { reply, createdIds, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/** Creates a Session on the machine and returns its id. */
export async function createSessionOn(machine: Pick<NewMachine, 'id' | 'name'>, input: OrchestrationSessionCreateInput): Promise<string> {
  const reply = await run(machine.id, { type: 'create-session', input });
  if (!reply.success) throw new Error(reply.error ?? `${machine.name} did not create the Session and gave no reason. Try again.`);
  return decodeBoundary(reply.data, createdSessionSchema).session.id;
}
