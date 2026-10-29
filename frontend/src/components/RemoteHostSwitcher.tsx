import type { ReactElement } from 'react';
import { Plus, Radio, Settings } from 'lucide-react';
import { Dropdown, DropdownMenuItem, type DropdownItem, type DropdownProps } from './ui/Dropdown';
import { MachineMark } from './machines/MachineMark';
import { showActionError } from '../stores/errorStore';
import type { MachineEntry } from '../utils/machineList';
import type { MachineSelectOutcome } from '../hooks/useMachines';

interface RemoteHostSwitcherProps {
  trigger: ReactElement;
  position: DropdownProps['position'];
  machines: MachineEntry[];
  switching: boolean;
  hostingSummary: string | null;
  onSelect: (machine: MachineEntry) => Promise<MachineSelectOutcome>;
  /** A machine that needs its password opens Remote Access with its password field. */
  onNeedsPassword: (machine: MachineEntry) => void;
  onOpenChange?: (open: boolean) => void;
  onAddMachine: () => void;
  onOpenRemoteAccess: () => void;
}

/** Offline, Owner only and Pane not open cannot be picked; the active machine stays pickable to retry. */
function unpickable(machine: MachineEntry): boolean {
  return machine.action === 'none' && !machine.active;
}

/** Picks which machine runs agents: this computer, a saved host, or any machine on Tailscale. */
export function RemoteHostSwitcher({
  trigger,
  position,
  machines,
  switching,
  hostingSummary,
  onSelect,
  onNeedsPassword,
  onOpenChange,
  onAddMachine,
  onOpenRemoteAccess,
}: RemoteHostSwitcherProps) {
  const pick = async (machine: MachineEntry) => {
    const outcome = await onSelect(machine);
    if (outcome.ok) return;
    if (outcome.needsPassword) onNeedsPassword(machine);
    else showActionError(`Could not switch to ${machine.name}`, outcome.error);
  };

  const items: DropdownItem[] = machines.map((machine) => ({
    id: machine.id,
    label: <span className="font-medium">{machine.name}</span>,
    description: machine.subtitle,
    // A disabled row is dimmed as a whole, so its mark stays solid inside it.
    leading: <MachineMark os={machine.os} slot={machine.slot} presence={unpickable(machine) ? 'solid' : machine.presence} size="md" />,
    disabled: switching || unpickable(machine),
    onClick: () => void pick(machine),
  }));
  const active = machines.find((machine) => machine.active);

  return (
    <Dropdown
      trigger={trigger}
      items={items}
      selectedId={active?.id}
      selectedMark="check"
      header="Agents run on"
      position={position}
      width="lg"
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
