import { assignMachineColorSlots, preferredMachineColorSlot } from '../../../shared/utils/machineColor';
import { assignMachineLetters, machineMarkKey, resolveMachineMark, type MachineMarkOverrides } from '../../../shared/utils/machineMarks';
import { formatDistanceToNow } from './timestampUtils';
import {
  COMPUTER_ROUTE_LABELS,
  findComputer,
  isWatchedComputer,
  routeProfile,
  type ComputerRouteKind,
  type RemoteComputer,
} from '../../../shared/types/remoteComputers';
import type { TailnetMachine, TailnetMachineList } from '../../../shared/types/workspaceAccess';
import type { RemoteDaemonHostRuntimeState, RemotePaneConnectionProfile, RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';
import type { MachineState } from '../../../shared/types/machineConnections';
import type { ConnectionPresence } from '../../../shared/remoteClient/connectionPresence';

export type MachineOs = TailnetMachine['os'];

/** Solid when usable, pulsing while the active machine reconnects, dimmed when out of reach. */
export type MachinePresence = 'solid' | 'pulsing' | 'dimmed';

/**
 * What picking a machine does: switch to a saved one, save and connect a discovered one,
 * ask for its password first, retry the active one, or nothing.
 */
type MachineAction = 'switch' | 'connect' | 'password' | 'retry' | 'none';

/** Id of "this computer": the local runtime, next to saved computer ids. */
const LOCAL_RUNTIME_ID = 'local';

/** One way Pane reaches a computer, as its pill shows it. */
export interface RoutePill {
  /** The saved route's id; `tailscale:<url>` for a Tailscale machine not saved yet. */
  id: string;
  kind: ComputerRouteKind;
  /** "Same network", "Tailscale", "SSH", "Public URL", "Pane relay". */
  label: string;
  /** The route the connection uses now: the pill's dot. */
  inUse: boolean;
  /** It cannot work from here now (a Tailscale route while Tailscale is signed out here): struck through. */
  down: boolean;
}

export interface MachineEntry {
  /** `local`, a saved computer id, or `tailnet:<dnsName>` for a Tailscale machine not saved yet. */
  id: string;
  name: string;
  os: MachineOs | null;
  /** This computer, a saved computer, or a Tailscale machine not saved yet. */
  kind: 'local' | 'computer' | 'tailnet';
  /** Its colour slot, a saved colour included. */
  slot: number;
  /** Its letter mark, saved letters included. */
  letters: string;
  /** Where its saved mark lives in `AppConfig.machineMarks`. */
  markKey: string;
  /** A mark saved on this computer changed its letters or colour. */
  customMark: boolean;
  active: boolean;
  /** This computer only watches it: it gave read-only access. */
  readOnly?: boolean;
  presence: MachinePresence;
  /** "Online", "Agents run here", "Reconnecting…": the state part of the subtitle. */
  stateText: string;
  /** "<OS> · <state>", as menus and Settings rows show it. */
  subtitle: string;
  action: MachineAction;
  /** Its routes in the order Pane tries them; none for this computer. */
  routes?: RoutePill[];
  /** Every route it has is down from here, so it takes a new link (the row's Link button). */
  needsLink?: boolean;
  computer?: RemoteComputer;
  /** The saved computer on the route in use, else its first: the shape the connection code takes. */
  profile?: RemotePaneConnectionProfile;
  tailnet?: TailnetMachine;
}

export interface MachineListInput {
  connectionState: RemotePaneConnectionState;
  /** `config.remoteDaemon.client.computers`. */
  computers: readonly RemoteComputer[];
  /** Null until the first Tailscale listing answers. */
  tailnet: TailnetMachineList | null;
  /** This computer's Tailscale name, when it has one. */
  localName: string | null;
  localOs: MachineOs | null;
  /** The active connection after the grace window (`useConnectionPresence`); without it the raw status decides. */
  connectionPresence?: ConnectionPresence;
  /** Marks chosen on this computer (`AppConfig.machineMarks`). */
  marks?: MachineMarkOverrides;
  /** What All machines knows of each saved computer (online, route in use); empty while it is off. */
  machineStates?: readonly MachineState[];
}

const TAILNET_STATE_TEXT = {
  available: 'Online',
  'password-required': 'Needs password',
  outdated: 'Older Pane',
  refused: 'Owner only',
  unreachable: 'Pane not open',
  offline: 'Offline',
} satisfies Record<TailnetMachine['state'], string>;

export const THIS_COMPUTER = 'This computer';

const SIGNED_OUT = 'Only on Tailscale, which is signed out here';

export function machineOsFromPlatform(platform: string): MachineOs | null {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return null;
}

function activeStateText(state: RemotePaneConnectionState): string {
  if (state.status === 'connected') return 'Agents run here';
  if (state.status === 'error') return 'Connection failed · Retry';
  return 'Reconnecting…';
}

function activePresence(state: RemotePaneConnectionState, presence: ConnectionPresence | undefined): MachinePresence {
  if (state.status === 'connected') return 'solid';
  if (presence) return presence === 'unreachable' ? 'dimmed' : 'pulsing';
  return state.status === 'error' ? 'dimmed' : 'pulsing';
}

function subtitle(os: MachineOs | null, ...parts: Array<string | false | null | undefined>): string {
  return [os, ...parts].filter(Boolean).join(' · ');
}

/**
 * Every machine agents can run on, in one list: this computer first, then each saved computer
 * with its routes, then the Tailscale machines not saved yet. A Tailscale machine that is a saved
 * computer joins its row.
 */
export function buildMachineList(input: MachineListInput): MachineEntry[] {
  const machines = listMachines(input);
  const letters = assignMachineLetters(machines.map((machine) => machine.name));
  return machines.map((machine) => {
    const markKey = machineMarkKey(machine);
    const mark = resolveMachineMark({ letters: letters.get(machine.name) ?? '?', slot: machine.slot }, input.marks?.[markKey]);
    return { ...machine, slot: mark.slot, letters: mark.letters, markKey, customMark: mark.custom };
  });
}

type ListedMachine = Omit<MachineEntry, 'letters' | 'markKey' | 'customMark'>;

/** The listed Tailscale machine each saved computer is, keyed by computer id; the rest are not saved. */
function joinTailnet(computers: readonly RemoteComputer[], listed: readonly TailnetMachine[]) {
  const joined = new Map<string, TailnetMachine>();
  const unsaved: TailnetMachine[] = [];
  for (const machine of listed) {
    const free = computers.filter((computer) => !joined.has(computer.id));
    // The install id wins; a name joins only a computer whose id does not say otherwise (journey 16).
    const byProfile = free.find((computer) => computer.id === machine.profileId
      && (!machine.machineId || !computer.machineId || computer.machineId === machine.machineId));
    const computer = findComputer(free, { machineId: machine.machineId, tailnetName: machine.name }) ?? byProfile;
    if (computer) joined.set(computer.id, machine);
    else unsaved.push(machine);
  }
  return { joined, unsaved };
}

function listMachines({ connectionState, computers, tailnet, localName, localOs, connectionPresence, machineStates = [] }: MachineListInput): ListedMachine[] {
  const remote = connectionState.mode === 'remote';
  const activeId = remote ? connectionState.activeProfileId : null;
  const tailscaleDown = tailnet?.ok === false;
  const listed = tailnet?.ok ? tailnet.machines : [];
  // The phone colours from the same set: the computers it can reach, itself included.
  const slots = assignMachineColorSlots([
    ...(localName ? [localName] : []),
    ...listed.filter((machine) => machine.state !== 'refused').map((machine) => machine.name),
  ]);
  const slotFor = (name: string) => slots.get(name) ?? preferredMachineColorSlot(name);
  const statesById = new Map(machineStates.map((state) => [state.id, state]));
  const { joined, unsaved } = joinTailnet(computers, listed);

  const local: ListedMachine = {
    id: LOCAL_RUNTIME_ID,
    name: localName ?? THIS_COMPUTER,
    os: localOs,
    kind: 'local',
    slot: slotFor(localName ?? THIS_COMPUTER),
    active: !remote,
    presence: 'solid',
    stateText: remote ? THIS_COMPUTER : 'Agents run here',
    // The active row is checked, so the subtitle stays one short line in the menu.
    subtitle: subtitle(localOs, localName && THIS_COMPUTER),
    action: remote ? 'switch' : 'none',
    routes: [],
    needsLink: false,
  };

  const saved = computers.map((computer): ListedMachine => {
    const active = computer.id === activeId;
    const machine = joined.get(computer.id);
    const state = statesById.get(computer.id);
    const routeInUse = active ? connectionState.activeRouteId : state?.routeId;
    const routes = computer.routes.map((route): RoutePill => ({
      id: route.id,
      kind: route.kind,
      label: COMPUTER_ROUTE_LABELS[route.kind],
      inUse: route.id === routeInUse,
      down: tailscaleDown && route.kind === 'tailscale',
    }));
    const needsLink = routes.every((route) => route.down);
    const tailscaleOnly = computer.routes.every((route) => route.kind === 'tailscale');
    const inUse = computer.routes.find((route) => route.id === routeInUse) ?? computer.routes[0];
    const os = computer.os ?? machine?.os ?? null;
    const base = { id: computer.id, name: computer.label, os, kind: 'computer' as const, slot: slotFor(computer.label), routes, needsLink, computer, profile: routeProfile(computer, inUse), tailnet: machine, readOnly: isWatchedComputer(computer) };

    const idle = idleState({ machine, state, needsLink, tailscaleOnly, tailnetListed: tailnet?.ok === true });
    // An active computer that now wants a password asks for it instead of retrying the stored one.
    const needsPassword = active && connectionState.status !== 'connected' && idle.action === 'password';
    if (!active) return { ...base, active, presence: idle.presence, stateText: idle.stateText, subtitle: subtitle(os, idle.stateText), action: idle.action };
    const stateText = needsPassword ? idle.stateText : activeStateText(connectionState);
    return {
      ...base,
      active,
      presence: activePresence(connectionState, connectionPresence),
      stateText,
      subtitle: subtitle(os, stateText),
      action: needsPassword ? 'password' : connectionState.status === 'connected' ? 'none' : 'retry',
    };
  });

  const discovered = unsaved.map((machine): ListedMachine => {
    const reachable = machine.state === 'available' || machine.state === 'outdated';
    const stateText = TAILNET_STATE_TEXT[machine.state];
    return {
      id: `tailnet:${machine.dnsName}`,
      name: machine.name,
      os: machine.os,
      kind: 'tailnet',
      slot: slotFor(machine.name),
      active: false,
      presence: reachable || machine.state === 'password-required' ? 'solid' : 'dimmed',
      stateText,
      subtitle: subtitle(machine.os, stateText, 'Not linked', !machine.mine && machine.ownerLogin),
      action: machine.state === 'password-required' ? 'password' : reachable ? 'connect' : 'none',
      routes: [{ id: `tailscale:${machine.url}`, kind: 'tailscale', label: COMPUTER_ROUTE_LABELS.tailscale, inUse: false, down: false }],
      needsLink: false,
      tailnet: machine,
    };
  });

  return [local, ...saved, ...discovered];
}

/** How a computer agents do not run on now shows in a list. */
interface IdleState {
  presence: MachinePresence;
  stateText: string;
  action: MachineAction;
}

/** A saved computer agents do not run on now: what All machines or the Tailscale listing says of it. */
function idleState({ machine, state, needsLink, tailscaleOnly, tailnetListed }: {
  machine: TailnetMachine | undefined;
  /** The Tailscale listing answered. */
  tailnetListed: boolean;
  state: MachineState | undefined;
  needsLink: boolean;
  tailscaleOnly: boolean;
}): IdleState {
  if (needsLink) return { presence: 'dimmed', stateText: SIGNED_OUT, action: 'none' };
  if (state?.status === 'online') return { presence: 'solid', stateText: 'Online', action: 'switch' };
  if (state?.status === 'offline') {
    return { presence: 'dimmed', stateText: state.offlineSince ? `Last seen ${formatDistanceToNow(state.offlineSince)}` : 'Offline', action: 'switch' };
  }
  if (state?.status === 'connecting') return { presence: 'solid', stateText: 'Connecting…', action: 'switch' };
  // Only the Tailscale listing knows; it speaks for the computer when Tailscale is its only route.
  if (machine && (tailscaleOnly || machine.state === 'available')) {
    const reachable = machine.state === 'available' || machine.state === 'outdated';
    return {
      presence: reachable || machine.state === 'password-required' ? 'solid' : 'dimmed',
      stateText: TAILNET_STATE_TEXT[machine.state],
      action: machine.state === 'password-required' ? 'password' : reachable ? 'switch' : 'none',
    };
  }
  if (tailscaleOnly && tailnetListed) return { presence: 'dimmed', stateText: 'Not on this tailnet', action: 'switch' };
  return { presence: 'solid', stateText: 'Saved', action: 'switch' };
}

/** The switcher's Hosting row: "Hosting · 2 clients connected", or "Hosting offline". */
export interface HostingSummary {
  label: string;
  detail?: string;
  state: 'live' | 'error';
}

/** Set when this machine is also hosting, so the switcher can link to it. */
export function getHostingSummary(hostState: Pick<RemoteDaemonHostRuntimeState, 'status' | 'connectedClients'>): HostingSummary | null {
  const clientCount = hostState.connectedClients.length;
  if (hostState.status === 'live') return { label: 'Hosting', detail: `${clientCount} ${clientCount === 1 ? 'client' : 'clients'} connected`, state: 'live' };
  return hostState.status === 'error' ? { label: 'Hosting offline', state: 'error' } : null;
}
