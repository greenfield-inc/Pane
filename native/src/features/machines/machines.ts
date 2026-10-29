import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus } from '@shared/types/remoteDaemon';
import type { TailnetMachine, TailnetMachineList } from '@shared/types/workspaceAccess';
import { assignMachineColorSlots, preferredMachineColorSlot } from '@shared/utils/machineColor';


/**
 * Solid: reachable. Pulsing: the current machine while it reconnects. Dimmed: offline, Pane not
 * open, or the current machine after it gave up.
 */
export type MachineState = 'solid' | 'pulsing' | 'dimmed';

/** One machine as the chips, Settings and Machine details show it. */
export interface Machine {
  /** The saved profile's id, or `tailnet:<name>` for a machine this phone never connected to. */
  key: string;
  name: string;
  /** Unknown for a machine paired with a code that Tailscale doesn't list: drawn as a plain computer. */
  os: TailnetMachine['os'] | null;
  /** Index into the machine palette. */
  slot: number;
  state: MachineState;
  /** "Connected", "Ready", "Offline"… */
  status: string;
  current: boolean;
  /** Tapping it switches (saved) or connects (new). */
  selectable: boolean;
  /** Set for a saved machine. */
  profile?: RemotePaneConnectionProfile;
  /** Its entry in the Tailscale list, when there is one. */
  tailnet?: TailnetMachine;
  /** The list's tailnet domain, needed to connect a new machine. */
  domain?: string;
}

// The same words desktop Pane uses under Settings › Remote Access › Your computers.
export const TAILNET_STATE_TEXT = {
  available: 'Ready',
  'password-required': 'Needs password',
  outdated: 'Older Pane',
  refused: 'Owner only',
  unreachable: 'Pane not open',
  offline: 'Offline',
} satisfies Record<TailnetMachine['state'], string>;

const CONNECTION: Record<RemotePaneConnectionStatus, { status: string; state: MachineState }> = {
  connected: { status: 'Connected', state: 'solid' },
  connecting: { status: 'Connecting…', state: 'pulsing' },
  reconnecting: { status: 'Reconnecting…', state: 'pulsing' },
  restoring: { status: 'Restoring…', state: 'pulsing' },
  error: { status: 'Offline', state: 'dimmed' },
  local: { status: 'Not connected', state: 'dimmed' },
};

/**
 * Saved machines in their saved order (the current one included even when it isn't saved, as in
 * the demo), then your own Tailscale machines this phone never connected to that are Ready or need
 * a password. State comes from the live connection for the current machine and from the Tailscale
 * list for the rest.
 */
export function listMachines({ profiles, current, connection, tailnet }: {
  profiles: readonly RemotePaneConnectionProfile[];
  current: RemotePaneConnectionProfile;
  connection: RemotePaneConnectionStatus;
  tailnet: TailnetMachineList | undefined;
}): Machine[] {
  const listed = tailnet?.ok ? tailnet.machines : [];
  const domain = tailnet?.ok ? tailnet.domain : undefined;
  const savedProfiles = profiles.some(profile => profile.id === current.id) ? profiles : [current, ...profiles];
  const matched = new Set<TailnetMachine>();

  const saved = savedProfiles.map(profile => {
    const entry = listed.find(machine => isSameMachine(profile, machine, domain));
    if (entry) matched.add(entry);
    const isCurrent = profile.id === current.id;
    // The list probes a machine's Workspaces listener. That is a Tailscale profile's own endpoint, but a code
    // pairing answers elsewhere, so for one the entry only lends its OS and name.
    const probed = entry && profile.tailnetMachine ? entry : undefined;
    const live = isCurrent ? CONNECTION[connection] : probed ? fromTailnet(probed.state) : { status: 'Saved', state: 'solid' as const };
    return {
      key: profile.id,
      name: profile.label,
      colorName: entry?.name ?? profile.tailnetMachine ?? profile.label,
      os: entry?.os ?? null,
      ...live,
      current: isCurrent,
      selectable: !isCurrent && live.state !== 'dimmed',
      profile,
      tailnet: entry,
      domain,
    };
  });

  const discovered = listed
    .filter(machine => !matched.has(machine) && machine.mine && (machine.state === 'available' || machine.state === 'password-required'))
    .map(machine => ({
      key: `tailnet:${machine.name}`,
      name: machine.name,
      colorName: machine.name,
      os: machine.os,
      ...fromTailnet(machine.state),
      current: false,
      selectable: true,
      tailnet: machine,
      domain,
    }));

  // The same set desktop Pane colours from (frontend/src/utils/machineList.ts): every machine the
  // listing names except refused ones, so one machine has one colour on both. Machines paired with a
  // code that the listing doesn't name join the set too.
  const slots = assignMachineColorSlots([
    ...listed.filter(machine => machine.state !== 'refused').map(machine => machine.name),
    ...saved.map(machine => machine.colorName),
  ]);
  return [...saved, ...discovered].map(({ colorName, ...machine }) => ({ ...machine, slot: slots.get(colorName) ?? preferredMachineColorSlot(colorName) }));
}

function fromTailnet(state: TailnetMachine['state']): { status: string; state: MachineState } {
  return { status: TAILNET_STATE_TEXT[state], state: state === 'available' || state === 'password-required' ? 'solid' : 'dimmed' };
}

/** By its Tailscale name, or for a machine paired with a code, by the host in its address. */
function isSameMachine(profile: RemotePaneConnectionProfile, machine: TailnetMachine, domain: string | undefined): boolean {
  if (profile.tailnetMachine) return profile.tailnetMachine === machine.name && profile.tailnetDomain === domain;
  return hostOf(profile.baseUrl) === machine.dnsName.toLowerCase().replace(/\.$/, '');
}

/** The host part of a machine's address. */
export function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/:]+)/i.exec(url)?.[1]?.toLowerCase() ?? '';
}
