import { useEffect, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { Plus, Radio, Settings } from 'lucide-react';
import { Dropdown, type DropdownItem, type DropdownProps } from './ui/Dropdown';
import { MachineMark, MachineMarkStack } from './machines/MachineMark';
import { MachineMarkEditor } from './machines/MachineMarkEditor';
import { RoutePillView } from './settings/computers/RoutePills';
import { useAddDeviceStore } from './addDevice/addDeviceStore';
import { showActionError } from '../stores/errorStore';
import { cn } from '../utils/cn';
import type { HostingSummary, MachineEntry, RoutePill } from '../utils/machineList';
import type { MachineSelectOutcome } from '../hooks/useMachines';

interface RemoteHostSwitcherProps {
  trigger: ReactElement;
  position: DropdownProps['position'];
  machines: MachineEntry[];
  switching: boolean;
  hostingSummary: HostingSummary | null;
  onSelect: (machine: MachineEntry) => Promise<MachineSelectOutcome>;
  /** A machine that needs its password opens Remote Access with its password field. */
  onNeedsPassword: (machine: MachineEntry) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenRemoteAccess: () => void;
  /** The first item: every saved machine's rows in one sidebar. */
  allMachines?: { selected: boolean; machines: MachineEntry[]; onSelect: () => void };
}

const ALL_MACHINES_ID = 'all-machines';

/** Offline, Owner only and Pane not open cannot be picked; the active machine stays pickable to retry. */
function unpickable(machine: MachineEntry): boolean {
  return machine.action === 'none' && !machine.active;
}

/** The route a saved machine is connected on now: the one pill its row shows. Reconnecting or offline, it has none. */
function routeInUse(machine: MachineEntry): RoutePill | undefined {
  if (machine.kind !== 'computer' || machine.presence !== 'solid') return undefined;
  return machine.routes?.find((route) => route.inUse && !route.down);
}

/** Each machine's round trip in ms, measured once when the menu opens; undefined until it answers, null when it did not. */
type Latencies = Record<string, number | null | undefined>;

/**
 * Line two of a machine row. Connected: the route pill, its latency and the OS. Otherwise the
 * subtitle says what it is ("Windows · Last seen 2 h ago"). The latency keeps one fixed box while
 * "…" turns into a number, so the OS after it never moves.
 */
function MachineLine({ machine, latency }: { machine: MachineEntry; latency: number | null | undefined }) {
  const route = routeInUse(machine);
  if (!route) return <>{machine.subtitle}</>;
  const text = latency === undefined ? '…' : latency === null ? '—' : `${latency} ms`;
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
      <RoutePillView route={route} />
      <span
        className="w-11 flex-none tabular-nums text-text-secondary"
        aria-label={latency === undefined ? 'Measuring latency' : latency === null ? 'No answer' : `${latency} milliseconds`}
      >{text}</span>
      {machine.os && <span className="truncate">{machine.os}</span>}
    </span>
  );
}

/** A footer row: its icon centred in the same 28 px column as the machine marks, so every label lines up. */
function MenuAction({ icon: Icon, label, detail, dot, onClick }: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  detail?: ReactNode;
  dot?: 'live' | 'error';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex min-h-[2rem] w-full items-center gap-2 rounded px-2.5 py-1 text-left text-[13px]',
        'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus-ring-subtle',
      )}
    >
      <span className="relative flex h-5 w-7 flex-none items-center justify-center">
        <Icon className="h-3.5 w-3.5 stroke-[1.5] text-text-tertiary group-hover:text-text-secondary" />
        {dot && (
          <span
            aria-hidden="true"
            className={cn('absolute right-1 top-0 h-1.5 w-1.5 rounded-full ring-2 ring-surface-primary', dot === 'live' ? 'bg-status-success' : 'bg-status-error')}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {label}
        {detail && <span className="text-text-tertiary group-hover:text-text-secondary"> · {detail}</span>}
      </span>
    </button>
  );
}

/** A digit typed into a field, or anywhere in a dialog such as a machine's mark editor, is not a machine pick. */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
    || target.closest('[role="dialog"]') !== null;
}

/** Picks which computer runs agents: this computer, a saved computer with the route it is on and its latency, or any machine on Tailscale. */
export function RemoteHostSwitcher({
  trigger,
  position,
  machines,
  switching,
  hostingSummary,
  onSelect,
  onNeedsPassword,
  onOpenChange,
  onOpenRemoteAccess,
  allMachines,
}: RemoteHostSwitcherProps) {
  const pick = async (machine: MachineEntry) => {
    const outcome = await onSelect(machine);
    if (outcome.ok) return;
    if (outcome.needsPassword) onNeedsPassword(machine);
    else showActionError(`Could not switch to ${machine.name}`, outcome.error);
  };

  const [open, setOpen] = useState(false);
  // One measurement per connected machine each time the menu opens, kept until it closes; nothing runs while it is closed.
  const [latencies, setLatencies] = useState<Latencies>({});
  const openCount = useRef(0);
  const measureOnOpen = (next: boolean) => {
    openCount.current += 1;
    setLatencies({});
    if (!next) return;
    const opening = openCount.current;
    for (const machine of machines) {
      if (!routeInUse(machine)) continue;
      // An answer that lands after the menu closed belongs to an earlier opening and is dropped.
      const record = (latency: number | null) => { if (openCount.current === opening) setLatencies((before) => ({ ...before, [machine.id]: latency })); };
      window.electronAPI.machines.latency(machine.id).then(record, () => record(null));
    }
  };

  const items: DropdownItem[] = machines.map((machine) => ({
    id: machine.id,
    // The name has line one to itself; the route in use and its latency lead line two.
    label: <span className="block truncate font-medium">{machine.name}</span>,
    description: <MachineLine machine={machine} latency={latencies[machine.id]} />,
    // A disabled row dims its mark and name, so the mark stays solid inside it.
    leading: <MachineMark letters={machine.letters} slot={machine.slot} presence={unpickable(machine) ? 'solid' : machine.presence} size="md" />,
    // Its letters and colour can change on this computer, whether or not it can be picked now.
    trailing: <MachineMarkEditor machine={machine} />,
    disabled: switching || unpickable(machine),
    onClick: () => void pick(machine),
  }));
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

  // While the switcher is open, 0 picks All machines and 1 to 9 the machines
  // in its order (P6), by choosing that row as a click would.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (typingTarget(event.target)) return;
      const digit = /^(?:Digit|Numpad)([0-9])$/.exec(event.code)?.[1];
      if (digit === undefined) return;
      const index = digit === '0' ? (allMachines ? 0 : -1) : (allMachines ? 0 : -1) + Number(digit);
      const row = items[index];
      if (!row || row.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      const menu = document.querySelector('[role="menu"][aria-label="Agents run on"]');
      const element = menu?.querySelector<HTMLElement>(`[data-dropdown-item-index="${index}"]`);
      if (element) element.click();
      else row.onClick?.();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, items, allMachines]);

  return (
    <Dropdown
      trigger={trigger}
      items={items}
      selectedId={allMachines?.selected ? ALL_MACHINES_ID : active?.id}
      selectedMark="check"
      header="Agents run on"
      position={position}
      width="auto"
      menuClassName="w-[400px] max-w-[calc(100vw-2rem)]"
      menuLabel="Agents run on"
      onOpenChange={(next) => { setOpen(next); measureOnOpen(next); onOpenChange?.(next); }}
      itemClassName="py-1.5"
      footer={({ close }) => (
        <>
          {hostingSummary && (
            <MenuAction icon={Radio} label={hostingSummary.label} detail={hostingSummary.detail} dot={hostingSummary.state} onClick={() => { close(); onOpenRemoteAccess(); }} />
          )}
          <MenuAction icon={Plus} label="Add a device…" onClick={() => { close(); useAddDeviceStore.getState().open('computer'); }} />
          <MenuAction icon={Settings} label="Remote Access settings…" onClick={() => { close(); onOpenRemoteAccess(); }} />
        </>
      )}
    />
  );
}
