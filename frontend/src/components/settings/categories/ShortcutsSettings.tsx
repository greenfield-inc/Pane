import { useEffect, useMemo, useState } from 'react';
import { Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Input, Textarea } from '../../ui/Input';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { TerminalShortcut } from '../../../types/config';
import type { KeyboardShortcutOverrides } from '../../../../../shared/utils/keyboardBindings';
import { formatKeyDisplay } from '../../../utils/hotkeyUtils';
import { buildShortcutMap, resolveShortcutEnvironment } from '../../../utils/shortcutMap';
import { useActiveProjectEnvironment } from '../../../hooks/useActiveProjectEnvironment';
import { KeyboardShortcutMap } from '../KeyboardShortcutMap';

interface ShortcutsSettingsProps {
  persistence: SettingsPersistence;
  /** Host platform from the main process; the active project's environment takes precedence for availability. */
  platform: string;
  onDirtyChange: (dirty: boolean) => void;
  onShowKeyboardShortcuts: () => void;
}

export function ShortcutsSettings({ persistence, platform, onDirtyChange, onShowKeyboardShortcuts }: ShortcutsSettingsProps) {
  const config = persistence.config!;
  const persistedShortcuts = config.terminalShortcuts ?? [];
  const persistedKey = JSON.stringify(persistedShortcuts);
  const [shortcuts, setShortcuts] = useState<TerminalShortcut[]>(persistedShortcuts);
  const snippetsDirty = JSON.stringify(shortcuts) !== persistedKey;
  const persistedOverrides = config.keyboardShortcutOverrides ?? {};
  const persistedOverridesKey = JSON.stringify(persistedOverrides);
  const [overridesDraft, setOverridesDraft] = useState<KeyboardShortcutOverrides>(persistedOverrides);
  const overridesDirty = JSON.stringify(overridesDraft) !== persistedOverridesKey;
  const dirty = snippetsDirty || overridesDirty;

  // SAFETY: App-owned storage writes this value through the matching typed serializer.
  useEffect(() => setShortcuts(JSON.parse(persistedKey) as TerminalShortcut[]), [persistedKey]);
  // SAFETY: Same app-owned storage; the main process normalizes the override map before saving.
  useEffect(() => setOverridesDraft(JSON.parse(persistedOverridesKey) as KeyboardShortcutOverrides), [persistedOverridesKey]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const shortcut of shortcuts.filter((item) => item.enabled && item.key)) {
      counts.set(shortcut.key, (counts.get(shortcut.key) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
  }, [shortcuts]);
  const projectEnvironment = useActiveProjectEnvironment();
  const customCommands = useMemo(() => config.customCommands ?? [], [config.customCommands]);
  const shortcutMap = useMemo(() => buildShortcutMap({
    overridesRaw: overridesDraft,
    terminalShortcuts: shortcuts,
    customCommands,
    environment: resolveShortcutEnvironment(projectEnvironment, platform),
  }), [overridesDraft, shortcuts, customCommands, projectEnvironment, platform]);
  const conflicted = shortcutMap.conflicts.length > 0;
  const snippetConflicts = new Set(
    shortcutMap.rows.filter((row) => row.origin === 'snippet' && row.conflicts.length > 0).map((row) => row.id),
  );
  const invalid = shortcuts.some((shortcut) => !shortcut.label.trim() || !shortcut.key || !shortcut.text.trim())
    || duplicateKeys.size > 0
    || snippetConflicts.size > 0;

  const update = (index: number, patch: Partial<TerminalShortcut>) => {
    setShortcuts((current) => current.map((shortcut, shortcutIndex) => (
      shortcutIndex === index ? { ...shortcut, ...patch } : shortcut
    )));
  };

  const apply = async () => {
    if (invalid) return;
    await persistence.saveConfig('terminal-shortcuts', { terminalShortcuts: shortcuts });
  };

  const applyOverrides = async () => {
    if (conflicted) return;
    await persistence.saveConfig('keyboard-shortcut-map', { keyboardShortcutOverrides: overridesDraft });
  };

  return (
    <SettingsPage title="Shortcuts" description="Control Pane keyboard shortcuts and terminal snippet hotkeys.">
      <SettingsSection title="Application shortcuts">
        <SettingRow
          settingId="keyboard-shortcuts"
          label="Enable Pane keyboard shortcuts"
          description="When disabled, Pane shortcuts won't work, but native terminal and embedded app shortcuts will. The Command Palette shortcut can remain enabled below."
          saveState={persistence.saveStates['keyboard-shortcuts']}
        >
          <ImmediateToggle
            label="Enable Pane keyboard shortcuts"
            value={config.keyboardShortcutsEnabled !== false}
            onSave={(value) => persistence.saveConfig('keyboard-shortcuts', { keyboardShortcutsEnabled: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="command-palette-shortcut"
          label="Keep Command Palette shortcut enabled"
          description="Keep Ctrl/Cmd+Shift+P available when other Pane keyboard shortcuts are disabled."
          saveState={persistence.saveStates['command-palette-shortcut']}
        >
          <ImmediateToggle
            label="Keep Command Palette shortcut enabled"
            value={config.commandPaletteShortcutEnabled !== false}
            onSave={(value) => persistence.saveConfig('command-palette-shortcut', { commandPaletteShortcutEnabled: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="keyboard-shortcut-map"
          label="Key bindings"
          description="Record a new key for any Pane command, clear it, or reset it to the default. Bindings are global across repositories. Two commands that can be active together cannot share a key."
          saveState={persistence.saveStates['keyboard-shortcut-map']}
          align="start"
          className="sm:grid-cols-1"
        >
          <KeyboardShortcutMap
            map={shortcutMap}
            draft={overridesDraft}
            dirty={overridesDirty}
            terminalShortcuts={shortcuts}
            customCommands={customCommands}
            onDraftChange={setOverridesDraft}
            onApply={applyOverrides}
          />
        </SettingRow>
        <button
          type="button"
          className="text-sm font-medium text-interactive underline underline-offset-4 hover:text-interactive-hover"
          onClick={onShowKeyboardShortcuts}
        >
          View all Pane keyboard shortcuts
        </button>
      </SettingsSection>
      <SettingsSection
        title="Terminal key reporting"
        description="How Pane encodes keystrokes for the program running inside a terminal."
      >
        <SettingRow
          settingId="kitty-keyboard"
          label="Kitty keyboard protocol"
          description="Lets a program ask for precise key reporting: key releases and repeats as distinct events, and modifier keys such as Ctrl or Shift reported on their own. Games and full-screen apps need it to tell a held key from a tapped one. Most terminal programs never ask, and are unaffected either way, so this changes nothing for an ordinary shell or for CLI agents that do not request it. Turn it off if a program misreads your keystrokes after asking for the protocol."
          saveState={persistence.saveStates['kitty-keyboard']}
        >
          <ImmediateToggle
            label="Kitty keyboard protocol"
            value={config.kittyKeyboardEnabled !== false}
            onSave={(value) => persistence.saveConfig('kitty-keyboard', { kittyKeyboardEnabled: value })}
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Terminal snippets">
        <SettingRow
          settingId="terminal-shortcuts"
          label="Snippet shortcuts"
          description="Each enabled shortcut needs a unique letter, label, and snippet."
          saveState={persistence.saveStates['terminal-shortcuts']}
          align="start"
        >
          <div className="w-full space-y-3 sm:w-[500px]">
            {shortcuts.map((shortcut, index) => (
              <div key={shortcut.id} className="space-y-2 rounded-md border border-border-secondary p-3">
                <div className="grid grid-cols-[minmax(0,1fr)_80px_auto] items-start gap-2">
                  <Input
                    label="Label"
                    value={shortcut.label}
                    onChange={(event) => update(index, { label: event.target.value })}
                    error={!shortcut.label.trim() ? 'Label is required' : undefined}
                    fullWidth
                  />
                  <Input
                    label="Key"
                    value={shortcut.key}
                    onChange={(event) => update(index, { key: event.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 1) })}
                    error={!shortcut.key ? 'Required' : duplicateKeys.has(shortcut.key) || snippetConflicts.has(`terminal-shortcut-${shortcut.id}`) ? 'In use' : undefined}
                    fullWidth
                  />
                  <div className="flex gap-1 pt-6">
                    <IconButton
                      type="button"
                      aria-label={shortcut.enabled ? 'Disable shortcut' : 'Enable shortcut'}
                      title={shortcut.enabled ? 'Disable' : 'Enable'}
                      icon={shortcut.enabled ? <Power className="h-4 w-4 text-status-success" /> : <PowerOff className="h-4 w-4" />}
                      onClick={() => update(index, { enabled: !shortcut.enabled })}
                    />
                    <IconButton
                      type="button"
                      aria-label="Delete shortcut"
                      title="Delete"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setShortcuts((current) => current.filter((_, shortcutIndex) => shortcutIndex !== index))}
                    />
                  </div>
                </div>
                <Textarea
                  label="Snippet text"
                  value={shortcut.text}
                  onChange={(event) => update(index, { text: event.target.value })}
                  error={!shortcut.text.trim() ? 'Snippet text is required' : undefined}
                  rows={2}
                  fullWidth
                />
                <p className="text-xs text-text-tertiary">
                  {shortcut.key ? formatKeyDisplay(`mod+alt+${shortcut.key}`) : 'Choose a letter from a-z'}
                </p>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setShortcuts((current) => [...current, {
                  id: crypto.randomUUID(), label: '', key: '', text: '', enabled: true,
                }])}
              >
                Add Shortcut
              </Button>
              <Button type="button" size="sm" disabled={!snippetsDirty || invalid} onClick={apply}>Apply</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
