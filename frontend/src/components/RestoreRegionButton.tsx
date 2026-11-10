import { Minimize2 } from 'lucide-react';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { cn } from '../utils/cn';

/**
 * The pressed "restore" button a maximized region shows in its header (P4,
 * VS Code's Restore Editor Group). The same key restores it too.
 */
export function RestoreRegionButton({ onRestore, className }: { onRestore: () => void; className?: string }) {
  const keys = useHotkeyStore((state) => state.hotkeys.get('zoom-toggle')?.keys ?? '');
  const label = keys ? `Restore (${formatKeyDisplay(keys)})` : 'Restore';
  return (
    <button
      type="button"
      aria-pressed="true"
      aria-label={label}
      title={label}
      data-testid="restore-region"
      onClick={onRestore}
      className={cn(
        'inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded bg-surface-hover text-text-primary hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
        className,
      )}
    >
      <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
