import { X } from 'lucide-react';
import { MOVED_DEFAULT_KEYS } from '../../../shared/constants/keyboardShortcuts';
import { useConfigStore } from '../stores/configStore';
import { rendererKeyPlatform, useHotkeyStore } from '../stores/hotkeyStore';
import { resolveEffectiveChord, normalizeKeyboardShortcutOverrides } from '../../../shared/utils/keyboardBindings';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { Button, IconButton } from './ui/Button';
import { Kbd } from './ui/Kbd';

interface KeymapNoticeProps {
  onOpenKeyboardShortcuts: () => void;
}

/**
 * The one-time notice for people who used Pane before the VS Code keymap
 * (D-236): which keys moved, and where to change them back. A fresh install
 * starts with `keymapNotice: 'seen'`, so it never sees this.
 */
export function KeymapNotice({ onOpenKeyboardShortcuts }: KeymapNoticeProps) {
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  // Re-render when the registry rebuilds, so a key changed from here shows at once.
  useHotkeyStore((state) => state.hotkeys);
  if (config?.keymapNotice !== 'pending') return null;

  const { overrides } = normalizeKeyboardShortcutOverrides(config.keyboardShortcutOverrides);
  const platform = rendererKeyPlatform();
  const dismiss = () => { void updateConfig({ keymapNotice: 'seen' }).catch(() => undefined); };

  return (
    <section
      aria-labelledby="keymap-notice-title"
      data-testid="keymap-notice"
      className="fixed bottom-4 left-1/2 z-fixed w-[380px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-border-primary bg-surface-primary p-3 text-text-primary shadow-dropdown"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="keymap-notice-title" className="text-sm font-semibold">Some keys moved to match VS Code</h2>
        <IconButton aria-label="Dismiss" size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={dismiss} />
      </div>
      <ul className="mt-2 space-y-1 text-xs text-text-secondary">
        {MOVED_DEFAULT_KEYS.map((moved) => {
          const now = moved.ids.map((id) => resolveEffectiveChord(id, overrides, platform)).filter((chord): chord is string => Boolean(chord));
          return (
            <li key={moved.label} className="flex items-center justify-between gap-2">
              <span>{moved.label}</span>
              <span className="flex items-center gap-1 whitespace-nowrap">
                <span className="text-text-tertiary line-through">{moved.before.map(formatKeyDisplay).join(' ')}</span>
                <span aria-hidden="true">→</span>
                <span className="sr-only">now</span>
                {now.map((chord) => <Kbd key={chord} size="xs">{formatKeyDisplay(chord)}</Kbd>)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={dismiss}>Got it</Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => { dismiss(); onOpenKeyboardShortcuts(); }}
        >
          Keyboard Shortcuts
        </Button>
      </div>
    </section>
  );
}
