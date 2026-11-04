import { MachineMark, machineColorVar } from './MachineMark';
import { cn } from '../../utils/cn';
import type { MachineRef } from '../../utils/allMachinesTree';

/** A row's machine: its OS logo on the machine's colour and the first five letters of its name. */
export function MachineBadge({ machine, className }: { machine: MachineRef; className?: string }) {
  const color = machineColorVar(machine.slot);
  return (
    <span
      title={machine.name}
      aria-label={`on ${machine.name}`}
      // Every badge keeps one width, so names of any length line up down the list.
      className={cn('pane-machine-badge inline-flex h-[18px] w-[60px] flex-none items-center gap-1 overflow-hidden rounded px-1 font-mono text-[11px] font-semibold leading-none', className)}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      <MachineMark os={machine.os} slot={machine.slot} size="logo" />
      <span aria-hidden="true">{machine.name.slice(0, 5)}</span>
    </span>
  );
}
