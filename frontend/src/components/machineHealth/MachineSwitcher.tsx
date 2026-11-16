import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { MachineState } from '../../../../shared/types/machineConnections';
import type { MachineHealthSnapshot } from '../../../../shared/types/machineHealth';
import { cn } from '../../utils/cn';
import { formatBytes } from '../../../../shared/utils/formatBytes';
import { healthReadProblem } from './healthReadError';
import { readHealthSnapshot } from './useMachineHealth';

const initials = (name: string) => name.split(/[\s._-]+/u).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || '?';
const osLabel = (platform: string) => (platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform === 'darwin' ? 'macOS' : platform);

type Summary = { kind: 'ok'; snapshot: MachineHealthSnapshot } | { kind: 'offline' } | { kind: 'outdated' } | { kind: 'error' } | { kind: 'loading' };
/** "this Mac" beside this computer's own name. */
const thisMachine = (platform: string | undefined) => (platform === 'darwin' ? 'this Mac' : platform === 'win32' ? 'this PC' : 'this computer');

function summaryLine(summary: Summary | undefined): string {
  if (!summary || summary.kind === 'loading') return 'Reading…';
  if (summary.kind === 'offline') return 'Offline';
  if (summary.kind === 'outdated') return 'Update Pane on this machine to see its health';
  if (summary.kind === 'error') return 'Could not read its health';
  const volume = summary.snapshot.disk.volumes.find(item => item.roles.includes('pane-data')) ?? summary.snapshot.disk.volumes[0];
  const pressure = summary.snapshot.memory.level === 'ok' ? 'normal' : summary.snapshot.memory.level === 'warning' ? 'high' : 'critical';
  return `${volume ? `${formatBytes(volume.freeBytes)} free · ` : ''}pressure ${pressure}`;
}

/** The Resources header chip: picks the machine whose health the page shows, from this computer and its linked machines. */
export function MachineSwitcher({ machineId, hostname, onSelect }: {
  machineId: string;
  /** The shown machine's own name, from its snapshot; this computer goes by it instead of "This computer". */
  hostname: string | undefined;
  onSelect: (machineId: string) => void;
}) {
  const [machines, setMachines] = useState<MachineState[]>([]);
  const [open, setOpen] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, Summary>>({});
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void window.electronAPI.machines.list().then(list => { if (live) setMachines(list); }).catch(() => undefined);
    const off = window.electronAPI.machines.onEvent(event => { if (event.type === 'machines') setMachines(event.machines); });
    return () => { live = false; off(); };
  }, []);

  useEffect(() => {
    if (!open) return;
    for (const machine of machines) {
      if (machine.status === 'offline') {
        setSummaries(previous => ({ ...previous, [machine.id]: { kind: 'offline' } }));
        continue;
      }
      void readHealthSnapshot(machine.id)
        .then(snapshot => setSummaries(previous => ({ ...previous, [machine.id]: { kind: 'ok', snapshot } })))
        .catch(error => {
          const problem = healthReadProblem(error);
          setSummaries(previous => ({ ...previous, [machine.id]: { kind: problem.kind } }));
        });
    }
    const close = (event: MouseEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, machines]);

  const selected = machines.find(machine => machine.id === machineId);
  const name = (selected?.kind === 'local' || (!selected && machineId === 'local') ? hostname : undefined) ?? selected?.label ?? 'This computer';
  return (
    <div className="relative" ref={root}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}
        className={cn('inline-flex items-center gap-2 rounded-full border px-2 py-1 text-sm text-text-primary hover:bg-surface-hover', open ? 'border-interactive' : 'border-border-primary')}>
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-secondary text-[11px] font-medium text-text-secondary" aria-hidden="true">{initials(name)}</span>
        {name}
        <ChevronDown className={cn('h-4 w-4 text-text-secondary transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <ul role="listbox" aria-label="Machine" className="absolute left-0 top-full z-30 mt-2 w-[420px] rounded-xl border border-border-primary bg-surface-primary p-1.5 shadow-xl">
          {machines.map(machine => {
            const summary = summaries[machine.id];
            const offline = machine.status === 'offline' || summary?.kind === 'offline';
            const local = machine.kind === 'local';
            const snapshot = summary?.kind === 'ok' ? summary.snapshot : undefined;
            const label = local ? (snapshot?.hostname ?? (machine.id === machineId ? hostname : undefined) ?? machine.label) : machine.label;
            const level = summary?.kind === 'ok' ? (summary.snapshot.disk.level === 'ok' ? summary.snapshot.memory.level : summary.snapshot.disk.level) : 'ok';
            return (
              <li key={machine.id} role="option" aria-selected={machine.id === machineId}>
                <button type="button" onClick={() => { onSelect(machine.id); setOpen(false); }}
                  className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-hover', machine.id === machineId && 'bg-surface-secondary', offline && 'opacity-60')}>
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">{machine.id === machineId && <Check className="h-4 w-4 text-interactive" aria-hidden="true" />}</span>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-xs font-medium text-text-secondary" aria-hidden="true">{initials(label)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm text-text-primary">
                      {label}
                      {local && <span className="text-text-tertiary">{thisMachine(snapshot?.platform)}</span>}
                      {snapshot && !local && <span className="rounded bg-surface-secondary px-1.5 text-xs text-text-secondary">{osLabel(snapshot.platform)}</span>}
                    </span>
                    <span className={cn('block text-sm', level === 'critical' ? 'text-status-error' : level === 'warning' ? 'text-status-warning' : 'text-text-secondary')}>{summaryLine(summary)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
