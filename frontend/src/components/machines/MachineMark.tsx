import type { CSSProperties } from 'react';
import { cn } from '../../utils/cn';
import type { MachineOs, MachinePresence } from '../../utils/machineList';

// Tile size in px and letter sizes (one letter, two letters); every state of one size keeps the same box.
const SIZES = {
  logo: { tile: 14, one: 'text-[11px]', two: 'text-[9px]' },
  row: { tile: 18, one: 'text-[11px]', two: 'text-[9px]' },
  sm: { tile: 20, one: 'text-[11px]', two: 'text-[9.5px]' },
  md: { tile: 28, one: 'text-[14px]', two: 'text-[12px]' },
  rail: { tile: 32, one: 'text-[15px]', two: 'text-[13px]' },
  lg: { tile: 44, one: 'text-[20px]', two: 'text-[17px]' },
} as const;

type MachineMarkSize = keyof typeof SIZES;

interface MachineMarkProps {
  /** One or two letters, from `MachineEntry.letters`. */
  letters: string;
  slot: number;
  presence?: MachinePresence;
  size: MachineMarkSize;
  className?: string;
}

/** The colour token for a machine's slot, from `--color-machine-1` to `--color-machine-6`. */
export function machineColorVar(slot: number): string {
  return `var(--color-machine-${slot + 1})`;
}

/** "travel-laptop · macOS": what a mark's tooltip says. */
export function machineMarkTitle(machine: { name: string; os: MachineOs | null }): string {
  return machine.os ? `${machine.name} · ${machine.os}` : machine.name;
}

/**
 * A machine's letters in its colour: on a soft tile, or bare at `logo` size.
 * Pulsing while reconnecting, dimmed when it cannot be reached.
 */
export function MachineMark({ letters, slot, presence = 'solid', size, className }: MachineMarkProps) {
  const { tile, one, two } = SIZES[size];
  const color = machineColorVar(slot);
  const style: CSSProperties = { width: tile, height: tile, color };
  if (size !== 'logo') style.backgroundColor = `color-mix(in srgb, ${color} 16%, transparent)`;
  if (size === 'rail') style.boxShadow = `inset 0 0 0 1.5px color-mix(in srgb, ${color} 70%, transparent)`;
  return (
    <span
      aria-hidden="true"
      data-presence={presence}
      data-testid="machine-mark"
      className={cn(
        'pane-machine-mark inline-flex flex-none items-center justify-center overflow-hidden',
        size === 'lg' ? 'rounded-lg' : size === 'logo' || size === 'row' ? 'rounded' : 'rounded-md',
        className,
      )}
      style={style}
    >
      <span className={cn('pane-machine-letters font-semibold leading-none tracking-tight', letters.length > 1 ? two : one)}>{letters}</span>
    </span>
  );
}

/**
 * A row's machine: its 18px mark, read as "on travel-laptop". The row puts it in a fixed
 * 18px box, so names of any length line up down the list.
 */
export function MachineRowMark({ machine, className }: { machine: { name: string; letters: string; slot: number }; className?: string }) {
  return (
    <span role="img" aria-label={`on ${machine.name}`} data-testid="machine-row-mark" className={cn('inline-flex flex-none', className)}>
      <MachineMark letters={machine.letters} slot={machine.slot} size="row" />
    </span>
  );
}

/** The first three machines' marks, overlapping: All machines in the machine pill and menu. */
export function MachineMarkStack({ machines }: { machines: ReadonlyArray<{ id: string; letters: string; slot: number }> }) {
  return (
    <span className="flex flex-none items-center" aria-hidden="true">
      {machines.slice(0, 3).map((machine, index) => (
        <MachineMark
          key={machine.id}
          letters={machine.letters}
          slot={machine.slot}
          size="sm"
          className={cn('rounded-full ring-2 ring-surface-secondary', index > 0 && '-ml-1.5')}
        />
      ))}
    </span>
  );
}
