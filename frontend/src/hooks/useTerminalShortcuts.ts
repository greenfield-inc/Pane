import { useEffect, useRef } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useHotkeyStore } from '../stores/hotkeyStore';
import type { HotkeyId } from '../../../shared/constants/keyboardShortcuts';

export function useTerminalShortcuts(): void {
  const config = useConfigStore((s) => s.config);
  const register = useHotkeyStore((s) => s.register);
  const unregister = useHotkeyStore((s) => s.unregister);
  const registeredIdsRef = useRef<string[]>([]);

  useEffect(() => {
    // Unregister previous shortcuts
    for (const id of registeredIdsRef.current) {
      unregister(id);
    }
    registeredIdsRef.current = [];

    const shortcuts = config?.terminalShortcuts ?? [];
    for (const shortcut of shortcuts) {
      if (!shortcut.enabled) continue;
      // SAFETY: Dynamic terminal shortcut ids are defined by this exact prefix family.
      const hotkeyId = `terminal-shortcut-${shortcut.id}` as HotkeyId;
      register({
        id: hotkeyId,
        label: shortcut.label || `Shortcut (${shortcut.key})`,
        keys: `mod+alt+${shortcut.key}`,
        category: 'shortcuts',
        action: () => {
          window.electron?.invoke('clipboard:paste', shortcut.text);
        },
      });
      registeredIdsRef.current.push(hotkeyId);
    }

    return () => {
      for (const id of registeredIdsRef.current) {
        unregister(id);
      }
      registeredIdsRef.current = [];
    };
  }, [config?.terminalShortcuts, register, unregister]);
}
