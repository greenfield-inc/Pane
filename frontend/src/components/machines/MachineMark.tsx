import type { CSSProperties } from 'react';
import { Server } from 'lucide-react';
import { AppleIcon, LinuxIcon, WindowsIcon } from '../ui/BrandIcons';
import { cn } from '../../utils/cn';
import type { MachineOs, MachinePresence } from '../../utils/machineList';

const OS_LOGOS = {
  macOS: AppleIcon,
  Windows: WindowsIcon,
  Linux: LinuxIcon,
} satisfies Record<MachineOs, typeof AppleIcon>;

// Tile size in px and logo size classes; every state of one size keeps the same box.
const SIZES = {
  logo: { tile: 14, logo: 'h-3.5 w-3.5' },
  sm: { tile: 20, logo: 'h-3 w-3' },
  md: { tile: 28, logo: 'h-4 w-4' },
  rail: { tile: 32, logo: 'h-[18px] w-[18px]' },
  lg: { tile: 44, logo: 'h-6 w-6' },
} as const;

export type MachineMarkSize = keyof typeof SIZES;

interface MachineMarkProps {
  os: MachineOs | null;
  slot: number;
  presence?: MachinePresence;
  size: MachineMarkSize;
  className?: string;
}

/** The colour token for a machine's slot, from `--color-machine-1` to `--color-machine-6`. */
export function machineColorVar(slot: number): string {
  return `var(--color-machine-${slot + 1})`;
}

/**
 * A machine's OS logo in its colour: on a soft tile, or bare at `logo` size.
 * Pulsing while reconnecting, dimmed when it cannot be reached.
 */
export function MachineMark({ os, slot, presence = 'solid', size, className }: MachineMarkProps) {
  const Logo = os ? OS_LOGOS[os] : Server;
  const { tile, logo } = SIZES[size];
  const color = machineColorVar(slot);
  const style: CSSProperties = {
    width: tile,
    height: tile,
    color,
    ...(size === 'logo' ? {} : { backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }),
    ...(size === 'rail' ? { boxShadow: `inset 0 0 0 1.5px color-mix(in srgb, ${color} 70%, transparent)` } : {}),
  };
  return (
    <span
      aria-hidden="true"
      data-presence={presence}
      className={cn(
        'pane-machine-mark inline-flex flex-none items-center justify-center',
        size === 'lg' ? 'rounded-lg' : 'rounded-md',
        className,
      )}
      style={style}
    >
      <Logo className={cn('pane-machine-logo', logo, !os && 'stroke-[1.75]')} />
    </span>
  );
}
