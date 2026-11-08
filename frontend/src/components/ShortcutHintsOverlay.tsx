import type { TerminalShortcut } from '../types/config';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { Kbd } from './ui/Kbd';
import { useHotkeyStore } from '../stores/hotkeyStore';

interface ShortcutHintsOverlayProps {
  isVisible: boolean;
  shortcuts: TerminalShortcut[];
}

export function ShortcutHintsOverlay({ isVisible, shortcuts }: ShortcutHintsOverlayProps) {
  const shortcutsKey = useHotkeyStore((state) => state.hotkeys.get('open-shortcut-settings')?.keys ?? '');
  if (!isVisible) return null;

  const enabledShortcuts = shortcuts.filter((s) => s.enabled && s.key);
  const modPrefix = formatKeyDisplay('mod+alt');

  return (
    // pointer-events-none: overlay is informational only, does not intercept clicks or keys
    <div className="fixed inset-0 z-popover flex items-center justify-center pointer-events-none">
      <div className="bg-bg-primary/95 backdrop-blur-md border border-border-primary rounded-xl shadow-2xl p-6 max-w-md w-full animate-fade-in">
        <div className="text-center mb-4">
          <h3 className="text-sm font-medium text-text-secondary">Terminal Shortcuts</h3>
          <p className="text-xs text-text-tertiary mt-1">Release to dismiss</p>
        </div>
        {enabledShortcuts.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-sm text-text-tertiary">No shortcuts configured</p>
            <p className="text-xs text-text-tertiary mt-2">
              {shortcutsKey ? <>Press <Kbd>{formatKeyDisplay(shortcutsKey)}</Kbd> to add some</> : 'Add some in Settings › Shortcuts'}
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            {enabledShortcuts.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-secondary overflow-hidden">
                <Kbd size="md" className="text-text-primary min-w-fit">
                  {modPrefix} + {s.key.toUpperCase()}
                </Kbd>
                <span className="text-sm text-text-secondary truncate min-w-0">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
