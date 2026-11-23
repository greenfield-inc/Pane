import type { PaneChatAgent } from '../../../shared/types/paneChat';
import type { RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { computerTailnetName, type RemoteComputer } from '../../../shared/types/remoteComputers';
import { LOCAL_MACHINE_ID, type MachineState } from '../../../shared/types/machineConnections';
import type { TailnetMachine, TailnetMachineList } from '../../../shared/types/workspaceAccess';
import type { PaneCloudSnapshot } from '../../../shared/types/paneCloud';
import { PANE_CLOUD_MACHINE, paneCloudMachine } from '../../../shared/utils/paneCloudMachine';
import type { SessionMoveVia } from './sessionMoveClient';

/**
 * Moving a Session to another host is the existing `runpane handoff`, run by the Session's own
 * agent from its folder: Pane only asks the agent, and the agent writes the note.
 */
export function moveToHostPrompt(agent: PaneChatAgent, machine: string): string {
  return `Hand this Session off to ${agent} on ${machine}. Use the handoff skill: write the note from `
    + '`runpane handoff --template`, check it with `--dry-run`, then run '
    + `\`runpane handoff "${agent} on ${machine}" --note-file <note>\` from this Session's folder. `
    + 'Don\'t push anything. Tell me the Session it created.';
}

/** Where the Sessions on screen live: this computer, a Tailscale machine, or a host Pane cannot place. */
export type SessionHost =
  | { kind: 'local' }
  | { kind: 'tailnet'; machine: string }
  | { kind: 'paired'; reason: string };

function hostOfComputer(computer: RemoteComputer): SessionHost {
  const tailnet = computerTailnetName(computer);
  if (tailnet) return { kind: 'tailnet', machine: tailnet.machine };
  return {
    kind: 'paired',
    reason: `${computer.label} has no Tailscale route, so Pane can't tell which machine it is on your tailnet. `
      + 'Moving a Session works between your machines on Tailscale: switch to it from the sidebar machine menu or Settings → Remote Access → Computers.',
  };
}

/** The host the window shows. */
export function sessionHostFor(config: Pick<RemoteDaemonConfig, 'client'> | undefined): SessionHost {
  const client = config?.client;
  if (client?.mode !== 'remote') return { kind: 'local' };
  const computer = client.computers.find(candidate => candidate.id === client.activeProfileId);
  return computer ? hostOfComputer(computer) : { kind: 'local' };
}

/** The host of one machine in All machines: this computer (`local`), or the saved computer with that id. */
export function sessionHostForMachine(config: Pick<RemoteDaemonConfig, 'client'> | undefined, machineId: string): SessionHost {
  if (machineId === LOCAL_MACHINE_ID) return { kind: 'local' };
  const computer = config?.client.computers.find(candidate => candidate.id === machineId);
  if (computer) return hostOfComputer(computer);
  return {
    kind: 'paired',
    reason: 'Pane no longer has this machine saved, so it can\'t ask its Session to move. Add it again in Settings → Remote Access, then try again.',
  };
}

/**
 * Why Move to machine… can't run for a Session on this host, or null when it can. `machine` is
 * the Session's machine in All machines, which must be connected to take the request.
 */
export function moveBlockedReason(host: SessionHost, machine?: { name: string; status: MachineState['status'] | undefined }): string | null {
  if (host.kind === 'paired') return host.reason;
  if (machine && machine.status !== 'online') {
    return `${machine.name} is ${machine.status === 'connecting' ? 'still connecting' : 'offline'}, so its Session's agent can't be asked to hand off. `
      + `Use Retry on ${machine.name}, then try again once it is back.`;
  }
  return null;
}

export interface MoveTarget {
  name: string;
  os?: TailnetMachine['os'];
  /** The owner's Tailscale login, set only for a teammate's machine. */
  owner?: string;
  available: boolean;
  /** Why the Session can't move there; set only when unavailable. */
  reason?: string;
  /** Set for a saved computer reached over Pane relay, and for Pane Cloud. */
  via?: SessionMoveVia;
}

/**
 * The targets this computer reaches without Tailscale: each saved computer with no Tailscale route
 * (reached over Pane relay, the same network or its public URL), and one "Pane Cloud" target when
 * the person can create cloud machines. Cloud machines show as Pane Cloud, never one by one.
 */
export function linkedMoveTargets(computers: readonly RemoteComputer[], cloud: PaneCloudSnapshot): MoveTarget[] {
  const members = new Set(paneCloudMachine(cloud.sessions)?.members.map(member => member.computerId));
  const targets: MoveTarget[] = computers
    .filter(computer => !members.has(computer.id) && !computerTailnetName(computer)
      && computer.routes.some(route => route.kind === 'relay' || route.kind === 'public' || route.kind === 'lan'))
    .map(computer => ({ name: computer.label, os: computer.os, available: true, via: { computerId: computer.id } }));
  const { signIn } = cloud;
  if (signIn.state === 'signed-in' && signIn.access === 'invited' && signIn.signupState === 'ready') {
    targets.push({ name: PANE_CLOUD_MACHINE.name, available: true, via: { cloud: true } });
  }
  return targets;
}

export type MoveTargetList =
  | { ok: true; targets: MoveTarget[]; noneReachable: boolean }
  | { ok: false; reason: string; fix: string };

/**
 * What `runpane handoff` can reach from the Session's host: machines with Pane answering. A
 * teammate's machine is listed only when its Pane accepts this login (Everyone on tailnet).
 */
function unavailableReason(machine: TailnetMachine): string | undefined {
  switch (machine.state) {
    case 'available': return undefined;
    case 'offline': return 'Offline';
    case 'unreachable': return 'Pane is not open there, or its remote access is off';
    case 'password-required': return 'Asks for a password, which handoff cannot send';
    case 'outdated': return 'Runs an older Pane; update Pane there first';
    // The owner's login is shown next to the name.
    case 'refused': return 'Accepts only its owner\'s Tailscale login; they can set Who can connect → Everyone on tailnet';
  }
}

/**
 * The machines a Session can move to: every listed machine except the Session's own host, plus
 * this computer when the Session lives elsewhere (discovery never lists the machine it runs on).
 * A Session on this computer can also move to the `linked` targets (see linkedMoveTargets).
 */
export function moveTargets({ machines, sessionHost, thisComputer, linked = [] }: {
  machines: TailnetMachineList;
  sessionHost: SessionHost;
  thisComputer?: MoveTarget;
  linked?: readonly MoveTarget[];
}): MoveTargetList {
  const extra = sessionHost.kind === 'local' ? linked : [];
  if (!machines.ok) {
    if (!extra.length) return { ok: false, reason: machines.reason, fix: machines.fix };
    return { ok: true, targets: [...extra], noneReachable: false };
  }
  const host = sessionHost.kind === 'tailnet' ? sessionHost.machine.toLowerCase() : null;
  const targets: MoveTarget[] = machines.machines
    .filter(machine => machine.name.toLowerCase() !== host)
    .map(machine => {
      const target: MoveTarget = { name: machine.name, os: machine.os, available: true };
      if (!machine.mine) target.owner = machine.ownerLogin;
      const reason = unavailableReason(machine);
      if (reason) {
        target.available = false;
        target.reason = reason;
      }
      return target;
    });
  if (host && thisComputer) targets.unshift(thisComputer);
  // A computer on the tailnet too is already listed by its tailnet name.
  const listed = new Set(targets.map(target => target.name.toLowerCase()));
  targets.push(...extra.filter(target => !listed.has(target.name.toLowerCase())));
  return { ok: true, targets, noneReachable: !targets.some(target => target.available) };
}
