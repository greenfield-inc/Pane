import { useState, type ReactElement } from 'react';
import { Plus, Radio, Settings, SquareTerminal } from 'lucide-react';
import { Dropdown, DropdownMenuItem, type DropdownItem, type DropdownProps } from './ui/Dropdown';
import { MachineMark, MachineMarkStack } from './machines/MachineMark';
import { showActionError } from '../stores/errorStore';
import { getHostTerminalPresentation, openHostTerminal } from '../utils/hostTerminal';
import { getCloudHostSwitcherEntry } from '../utils/cloudSandboxPresentation';
import { API } from '../utils/api';
import type { MachineEntry } from '../utils/machineList';
import type { MachineSelectOutcome } from '../hooks/useMachines';
import type { CloudSandboxView } from '../../../shared/types/cloudSandboxes';

interface RemoteHostSwitcherProps {
  trigger: ReactElement;
  position: DropdownProps['position'];
  machines: MachineEntry[];
  /** Cloud sandboxes behind saved hosts, so a stopped one offers Start instead of a dead connection. */
  cloudSandboxes: CloudSandboxView[];
  switching: boolean;
  hostingSummary: string | null;
  onSelect: (machine: MachineEntry) => Promise<MachineSelectOutcome>;
  /** A machine that needs its password opens Remote Access with its password field. */
  onNeedsPassword: (machine: MachineEntry) => void;
  onOpenChange?: (open: boolean) => void;
  onAddMachine: () => void;
  onOpenRemoteAccess: () => void;
  /** The first item: every saved machine's rows in one sidebar. */
  allMachines?: { selected: boolean; machines: MachineEntry[]; onSelect: () => void };
}

const ALL_MACHINES_ID = 'all-machines';

/** Offline, Owner only and Pane not open cannot be picked; the active machine stays pickable to retry. */
function unpickable(machine: MachineEntry): boolean {
  return machine.action === 'none' && !machine.active;
}

/** Picks which machine runs agents: this computer, a saved host, or any machine on Tailscale. */
export function RemoteHostSwitcher({
  trigger,
  position,
  machines,
  cloudSandboxes,
  switching,
  hostingSummary,
  onSelect,
  onNeedsPassword,
  onOpenChange,
  onAddMachine,
  onOpenRemoteAccess,
  allMachines,
}: RemoteHostSwitcherProps) {
  const pick = async (machine: MachineEntry) => {
    const outcome = await onSelect(machine);
    if (outcome.ok) return;
    if (outcome.needsPassword) onNeedsPassword(machine);
    else showActionError(`Could not switch to ${machine.name}`, outcome.error);
  };

  // A stopped sandbox has no daemon to connect to: start it first, then switch to it.
  const [starting, setStarting] = useState(false);
  const startAndPick = async (sandbox: CloudSandboxView, machine: MachineEntry) => {
    if (starting) return;
    setStarting(true);
    try {
      const response = await API.remoteDaemon.startCloudSandbox(sandbox.id);
      const started = response.data?.sandboxes.find((candidate) => candidate.id === sandbox.id);
      if (!response.success || started?.state !== 'running' || started.error) {
        showActionError(`Could not start ${machine.name}`, response.error ?? started?.error ?? 'The sandbox did not reach running.');
        return;
      }
    } finally {
      setStarting(false);
    }
    await pick(machine);
  };

  const openTerminal = async (hostName: string) => {
    try {
      await openHostTerminal();
    } catch (error) {
      showActionError(`Could not open the terminal on ${hostName}`, error);
    }
  };

  const items: DropdownItem[] = machines.map((machine) => {
    // Only the active host's terminal can open: the window talks to one host at a time.
    const sandbox = machine.profile ? cloudSandboxes.find((candidate) => candidate.profileId === machine.profile?.id) : undefined;
    const cloudEntry = getCloudHostSwitcherEntry(sandbox);
    // A sandbox that is not running has no shell to open.
    const terminal = machine.active && machine.kind !== 'local' && !cloudEntry
      ? getHostTerminalPresentation(machine.profile ?? { label: machine.name })
      : null;
    return {
      id: machine.id,
      label: <span className="font-medium">{machine.name}</span>,
      description: cloudEntry?.description ?? machine.subtitle,
      // A disabled row is dimmed as a whole, so its mark stays solid inside it.
      leading: <MachineMark os={machine.os} slot={machine.slot} presence={unpickable(machine) ? 'solid' : machine.presence} size="md" />,
      disabled: switching || starting || (cloudEntry ? cloudEntry.action === 'wait' : unpickable(machine)),
      onClick: () => void (sandbox && cloudEntry?.action === 'start' ? startAndPick(sandbox, machine) : pick(machine)),
      action: terminal ? { label: terminal.openLabel, icon: SquareTerminal, onClick: () => void openTerminal(terminal.hostName) } : undefined,
    };
  });
  if (allMachines) {
    items.unshift({
      id: ALL_MACHINES_ID,
      label: <span className="font-medium">All machines</span>,
      description: `Every saved machine's Panes · ${allMachines.machines.length} machines`,
      leading: <span className="flex h-7 items-center"><MachineMarkStack machines={allMachines.machines} /></span>,
      disabled: switching,
      onClick: allMachines.onSelect,
    });
  }
  const active = machines.find((machine) => machine.active);

  return (
    <Dropdown
      trigger={trigger}
      items={items}
      selectedId={allMachines?.selected ? ALL_MACHINES_ID : active?.id}
      selectedMark="check"
      header="Agents run on"
      position={position}
      width="auto"
      menuClassName="w-[300px]"
      menuLabel="Agents run on"
      onOpenChange={onOpenChange}
      itemClassName="py-1.5"
      footer={({ close }) => (
        <>
          {hostingSummary && (
            <DropdownMenuItem icon={Radio} label={hostingSummary} onClick={() => { close(); onOpenRemoteAccess(); }} />
          )}
          <DropdownMenuItem icon={Plus} label="Add a machine…" onClick={() => { close(); onAddMachine(); }} />
          <DropdownMenuItem icon={Settings} label="Remote Access settings…" onClick={() => { close(); onOpenRemoteAccess(); }} />
        </>
      )}
    />
  );
}
