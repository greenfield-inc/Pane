import { assignMachineColorSlots, preferredMachineColorSlot } from '../../../shared/utils/machineColor';
import type { TailnetMachine, TailnetMachineList } from '../../../shared/types/workspaceAccess';
import type { RemotePaneConnectionProfile, RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';

export type MachineOs = TailnetMachine['os'];

/** Solid when usable, pulsing while the active machine reconnects, dimmed when out of reach. */
export type MachinePresence = 'solid' | 'pulsing' | 'dimmed';

/**
 * What picking a machine does: switch to a saved one, save and connect a discovered one,
 * ask for its password first, retry the active one, or nothing.
 */
export type MachineAction = 'switch' | 'connect' | 'password' | 'retry' | 'none';

/** Id of "this computer": the local runtime, next to saved profile ids. */
export const LOCAL_RUNTIME_ID = 'local';

export interface MachineEntry {
  /** `local`, a saved profile id, or `tailnet:<dnsName>` for a machine never connected. */
  id: string;
  name: string;
  os: MachineOs | null;
  kind: 'local' | 'tailnet' | 'code';
  slot: number;
  active: boolean;
  presence: MachinePresence;
  /** "Ready", "Agents run here", "Reconnecting…": the state part of the subtitle. */
  stateText: string;
  /** "<OS> · <state>", as menus and Settings rows show it. */
  subtitle: string;
  action: MachineAction;
  profile?: RemotePaneConnectionProfile;
  tailnet?: TailnetMachine;
}

export interface MachineListInput {
  connectionState: RemotePaneConnectionState;
  profiles: readonly RemotePaneConnectionProfile[];
  /** Null until the first Tailscale listing answers. */
  tailnet: TailnetMachineList | null;
  /** This computer's Tailscale name, when it has one. */
  localName: string | null;
  localOs: MachineOs | null;
}

const TAILNET_STATE_TEXT = {
  available: 'Ready',
  'password-required': 'Needs password',
  outdated: 'Older Pane',
  refused: 'Owner only',
  unreachable: 'Pane not open',
  offline: 'Offline',
} satisfies Record<TailnetMachine['state'], string>;

export const THIS_COMPUTER = 'This computer';

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

function activePresence(state: RemotePaneConnectionState): MachinePresence {
  if (state.status === 'connected') return 'solid';
  return state.status === 'error' ? 'dimmed' : 'pulsing';
}

function subtitle(os: MachineOs | null, ...parts: Array<string | false | null | undefined>): string {
  return [os, ...parts].filter(Boolean).join(' · ');
}

/**
 * Every machine agents can run on, in one list: this computer first, then the Tailscale
 * machines in the order the listing gives, then saved Tailscale machines it did not list,
 * then hosts added with a connection code.
 */
export function buildMachineList({ connectionState, profiles, tailnet, localName, localOs }: MachineListInput): MachineEntry[] {
  const remote = connectionState.mode === 'remote';
  const activeProfileId = remote ? connectionState.activeProfileId : null;
  const listed = tailnet?.ok ? tailnet.machines : [];
  // The phone colours from the same set: the computers it can reach, itself included.
  const slots = assignMachineColorSlots([
    ...(localName ? [localName] : []),
    ...listed.filter((machine) => machine.state !== 'refused').map((machine) => machine.name),
  ]);
  const slotFor = (name: string) => slots.get(name) ?? preferredMachineColorSlot(name);
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));

  const local: MachineEntry = {
    id: LOCAL_RUNTIME_ID,
    name: localName ?? THIS_COMPUTER,
    os: localOs,
    kind: 'local',
    slot: slotFor(localName ?? THIS_COMPUTER),
    active: !remote,
    presence: 'solid',
    stateText: remote ? THIS_COMPUTER : 'Agents run here',
    subtitle: subtitle(localOs, localName && THIS_COMPUTER, !remote && 'Agents run here'),
    action: remote ? 'switch' : 'none',
  };

  const remoteEntry = (entry: Omit<MachineEntry, 'active' | 'presence' | 'stateText' | 'subtitle' | 'action'>, idle: {
    presence: MachinePresence; stateText: string; action: MachineAction; extra?: Array<string | false | undefined>;
  }): MachineEntry => {
    const active = entry.profile !== undefined && entry.profile.id === activeProfileId;
    const prefix = entry.kind === 'code' ? 'Added with a code' : null;
    const stateText = active ? activeStateText(connectionState) : idle.stateText;
    return {
      ...entry,
      active,
      presence: active ? activePresence(connectionState) : idle.presence,
      stateText,
      subtitle: subtitle(entry.os, prefix, stateText, ...(active ? [] : idle.extra ?? [])),
      action: active ? (connectionState.status === 'connected' ? 'none' : 'retry') : idle.action,
    };
  };

  const listedProfileIds = new Set<string>();
  const tailnetEntries = listed.map((machine) => {
    const profile = machine.profileId ? profilesById.get(machine.profileId) : undefined;
    if (profile) listedProfileIds.add(profile.id);
    const reachable = machine.state === 'available' || machine.state === 'outdated';
    return remoteEntry({
      id: profile?.id ?? `tailnet:${machine.dnsName}`,
      name: machine.name,
      os: machine.os,
      kind: 'tailnet',
      slot: slotFor(machine.name),
      profile,
      tailnet: machine,
    }, {
      presence: reachable || machine.state === 'password-required' ? 'solid' : 'dimmed',
      stateText: TAILNET_STATE_TEXT[machine.state],
      action: machine.state === 'password-required' ? 'password' : !reachable ? 'none' : profile ? 'switch' : 'connect',
      extra: [!profile && 'Never connected', !machine.mine && machine.ownerLogin],
    });
  });

  // Saved Tailscale machines the listing left out stay pickable, as they always were.
  const unlisted = profiles
    .filter((profile) => profile.tailnetMachine && !listedProfileIds.has(profile.id))
    .map((profile) => remoteEntry({
      id: profile.id,
      name: profile.tailnetMachine ?? profile.label,
      os: null,
      kind: 'tailnet',
      slot: slotFor(profile.tailnetMachine ?? profile.label),
      profile,
    }, {
      presence: tailnet?.ok ? 'dimmed' : 'solid',
      stateText: tailnet?.ok ? 'Not on Tailscale' : 'Saved',
      action: 'switch',
    }));

  const codeHosts = profiles
    .filter((profile) => !profile.tailnetMachine)
    .map((profile) => remoteEntry({
      id: profile.id,
      name: profile.label,
      os: null,
      kind: 'code',
      slot: slotFor(profile.label),
      profile,
    }, { presence: 'solid', stateText: '', action: 'switch' }));

  return [local, ...tailnetEntries, ...unlisted, ...codeHosts];
}

/** Set when this machine is also hosting, so the switcher can link to it. */
export function getHostingSummary(hostState: { status: string; connectedClients: readonly unknown[] }): string | null {
  const clientCount = hostState.connectedClients.length;
  if (hostState.status === 'live') return `Hosting · ${clientCount} ${clientCount === 1 ? 'client' : 'clients'} connected`;
  return hostState.status === 'error' ? 'Hosting offline' : null;
}
