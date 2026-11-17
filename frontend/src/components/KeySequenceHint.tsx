import { useKeySequenceStore } from '../stores/hotkeyStore';
import { useKeyHintStore } from '../stores/keyHintStore';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { Kbd } from './ui/Kbd';

/**
 * While a two-step key waits for its second step (⌘K, then ⌘S), a small hint
 * says so at the bottom of the window, as VS Code does in its status bar (D-250).
 * A key with nothing to do here says why in the same place (`showKeyHint`).
 */
export function KeySequenceHint() {
  const pending = useKeySequenceStore((state) => state.pending);
  const hint = useKeyHintStore((state) => state.text);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-3 left-1/2 z-fixed -translate-x-1/2">
      {pending && (
        <div
          data-testid="key-sequence-hint"
          className="flex items-center gap-2 rounded-md border border-border-primary bg-surface-primary px-3 py-1.5 text-xs text-text-secondary shadow-dropdown"
        >
          <Kbd size="xs">{formatKeyDisplay(pending.first)}</Kbd>
          <span>was pressed. Waiting for the second key…</span>
        </div>
      )}
      {!pending && hint && (
        <div
          data-testid="key-hint"
          className="rounded-md border border-border-primary bg-surface-primary px-3 py-1.5 text-xs text-text-secondary shadow-dropdown"
        >
          {hint}
        </div>
      )}
    </div>
  );
}
