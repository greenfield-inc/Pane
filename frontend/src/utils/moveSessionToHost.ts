import type { PaneChatAgent } from '../../../shared/types/paneChat';
import type { RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { LOCAL_MACHINE_ID, type MachineState } from '../../../shared/types/machineConnections';
import type { TailnetMachine, TailnetMachineList } from '../../../shared/types/workspaceAccess';

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

function hostOfProfile(profile: RemoteDaemonConfig['client']['profiles'][number]): SessionHost {
  if (profile.tailnetMachine) return { kind: 'tailnet', machine: profile.tailnetMachine };
  return {
    kind: 'paired',
    reason: `${profile.label} is connected with a pairing code, not over Tailscale, so Pane can't tell which machine it is. `
      + 'Moving a Session works between your machines on Tailscale: switch to it from the sidebar machine menu or Settings → Remote Access → Switch to.',
  };
}

/** The host the window shows. */
export function sessionHostFor(config: Pick<RemoteDaemonConfig, 'client'> | undefined): SessionHost {
  const client = config?.client;
  if (client?.mode !== 'remote') return { kind: 'local' };
  const profile = client.profiles.find(candidate => candidate.id === client.activeProfileId);
  return profile ? hostOfProfile(profile) : { kind: 'local' };
}

/** The host of one machine in All machines: this computer (`local`), or the saved profile with that id. */
export function sessionHostForMachine(config: Pick<RemoteDaemonConfig, 'client'> | undefined, machineId: string): SessionHost {
  if (machineId === LOCAL_MACHINE_ID) return { kind: 'local' };
  const profile = config?.client.profiles.find(candidate => candidate.id === machineId);
  if (profile) return hostOfProfile(profile);
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
 */
export function moveTargets({ machines, sessionHost, thisComputer }: {
  machines: TailnetMachineList;
  sessionHost: SessionHost;
  thisComputer?: MoveTarget;
}): MoveTargetList {
  if (!machines.ok) return { ok: false, reason: machines.reason, fix: machines.fix };
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
  return { ok: true, targets, noneReachable: !targets.some(target => target.available) };
}
