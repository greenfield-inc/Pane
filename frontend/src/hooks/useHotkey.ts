import { useEffect } from 'react';
import { useHotkeyStore, type HotkeyDefinition } from '../stores/hotkeyStore';
import { useCommittedRef } from './useCommittedRef';

/**
 * Register a global hotkey. The shortcut is active while the component is mounted.
 *
 * IMPORTANT: Always call this hook unconditionally at the top level of your component.
 * Never wrap it in an if/else or conditional block — React hooks must be called in
 * the same order every render. Use the `enabled` callback to conditionally disable
 * the shortcut instead.
 *
 * Usage:
 *   useHotkey({
 *     id: 'open-command-palette',
 *     label: 'Open Prompt History',
 *     category: 'navigation',
 *     action: () => setIsPromptHistoryOpen(true),
 *   });
 */
export function useHotkey(def: HotkeyDefinition): void {
  const register = useHotkeyStore((s) => s.register);
  const unregister = useHotkeyStore((s) => s.unregister);

  // Keep action ref stable to avoid re-registering on every render
  const actionRef = useCommittedRef(def.action);

  // Same for enabled
  const enabledRef = useCommittedRef(def.enabled);

  const disabledReasonRef = useCommittedRef(def.disabledReason);

  useEffect(() => {
    register({
      ...def,
      action: () => actionRef.current(),
      enabled: def.enabled ? () => enabledRef.current!() : undefined,
      disabledReason: def.disabledReason ? () => disabledReasonRef.current?.() ?? null : undefined,
    });
    return () => unregister(def.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id, def.keys, def.category, def.label, def.devOnly, register, unregister]);
}
