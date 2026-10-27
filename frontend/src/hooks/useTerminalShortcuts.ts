import { useEffect, useRef } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useHotkeyStore } from '../stores/hotkeyStore';

function focusedTerminalId(): string | undefined {
  const input = document.activeElement;
  if (!input?.matches('.xterm-helper-textarea')) return undefined;
  return input.closest<HTMLElement>('[data-terminal-panel-id]')?.dataset.terminalPanelId;
}

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
      const hotkeyId = `terminal-shortcut-${shortcut.id}`;
      register({
        id: hotkeyId,
        label: shortcut.label || `Shortcut (${shortcut.key})`,
        keys: `mod+alt+${shortcut.key}`,
        category: 'shortcuts',
        enabled: () => !!focusedTerminalId(),
        action: () => {
          const panelId = focusedTerminalId();
          if (panelId) {
            void window.electronAPI.invoke('terminal:input', panelId, shortcut.text)
              .catch(error => console.error('Failed to insert terminal shortcut:', error));
          }
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
