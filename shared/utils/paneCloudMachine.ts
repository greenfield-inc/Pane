import type { PaneCloudSession } from '../types/paneCloud';

/**
 * All of a person's cloud Session VMs show as this one machine (D-90): machine lists, the switcher,
 * runpane and the pane MCP name it "Pane Cloud", with its Sessions under it. Each Session still runs
 * on its own VM, which stays a saved computer underneath.
 */
export const PANE_CLOUD_MACHINE = { id: 'pane-cloud', name: 'Pane Cloud' } as const;

/** The daemon command that answers `PaneCloudMachine | null` on the computer signed in to Pane Cloud. */
export const PANE_CLOUD_MACHINE_CHANNEL = 'pane-cloud:machine';

/** One cloud Session in the "Pane Cloud" machine: the saved computer its VM is, and the Session it runs. */
export interface PaneCloudMember {
  /** The saved computer's id (`client.computers[].id`), which `machines:*`, runpane and the MCP address. */
  computerId: string;
  vmId: string;
  /** The cloud Session's name as the service holds it, from when it was created. */
  sessionName: string;
  /** Creating, starting or running. */
  awake: boolean;
}

export interface PaneCloudMachine {
  id: typeof PANE_CLOUD_MACHINE.id;
  name: typeof PANE_CLOUD_MACHINE.name;
  /** Paired cloud Sessions, newest first. */
  members: PaneCloudMember[];
}

/**
 * The "Pane Cloud" machine from the service's list of cloud Sessions, or null when no cloud Session is
 * paired with this computer. A cloud Session belongs to it by its VM's vouched relay id, which the
 * manager resolves to a saved computer (`PaneCloudSession.machineId`); nothing else is stored.
 */
export function paneCloudMachine(sessions: readonly PaneCloudSession[]): PaneCloudMachine | null {
  const members = sessions
    .filter((session): session is PaneCloudSession & { machineId: string } => session.machineId !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((session) => ({ computerId: session.machineId, vmId: session.vmId, sessionName: session.name, awake: session.awake }));
  return members.length > 0 ? { ...PANE_CLOUD_MACHINE, members } : null;
}

/** A machine list with Pane Cloud's members taken out and paired with the member each one is. */
export interface PaneCloudGrouping<Machine> {
  machines: Machine[];
  members: Array<{ machine: Machine; member: PaneCloudMember }>;
}

/**
 * Splits a machine list into the machines shown as themselves and Pane Cloud's members, each with
 * the machine entry it is, in member order. `idOf` gives an entry's saved computer id.
 */
export function groupPaneCloud<Machine>(machines: readonly Machine[], cloud: PaneCloudMachine | null, idOf: (machine: Machine) => string): PaneCloudGrouping<Machine> {
  const byComputer = new Map((cloud?.members ?? []).map((member) => [member.computerId, member]));
  const members = (cloud?.members ?? []).flatMap((member) => {
    const machine = machines.find((candidate) => idOf(candidate) === member.computerId);
    return machine === undefined ? [] : [{ machine, member }];
  });
  return { machines: machines.filter((machine) => !byComputer.has(idOf(machine))), members };
}
