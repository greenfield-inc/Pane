import { DEVICE_ACCESS_LABELS } from '../../../../shared/types/accessLevel';
import { cn } from '../../utils/cn';

/** "Read only": a device that only watches this computer, or a computer this one only watches. */
export function ReadOnlyPill({ className }: { className?: string }) {
  return (
    <span className={cn('flex-none rounded bg-surface-secondary px-1.5 py-px text-[11px] font-medium text-text-secondary', className)}>
      {DEVICE_ACCESS_LABELS.read}
    </span>
  );
}
