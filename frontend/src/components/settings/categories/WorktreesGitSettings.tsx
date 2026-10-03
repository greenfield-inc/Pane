import { useEffect, useMemo, useState } from 'react';
import { Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { WorktreeFileSyncEntry } from '../../../../../shared/types/worktreeFileSync';
import { DEFAULT_WORKTREE_FILE_SYNC_ENTRIES } from '../../../../../shared/types/worktreeFileSync';

interface WorktreesGitSettingsProps {
  persistence: SettingsPersistence;
  onDirtyChange: (dirty: boolean) => void;
}

export function WorktreesGitSettings({ persistence, onDirtyChange }: WorktreesGitSettingsProps) {
  const config = persistence.config!;
  const persistedEntries = config.worktreeFileSync ?? DEFAULT_WORKTREE_FILE_SYNC_ENTRIES;
  const [entries, setEntries] = useState<WorktreeFileSyncEntry[]>(persistedEntries);
  const persistedJson = JSON.stringify(persistedEntries);
  const dirty = JSON.stringify(entries) !== persistedJson;
  const hasInvalidEntry = entries.some((entry) => entry.path.trim().length === 0);

  // SAFETY: App-owned storage writes this value through the matching typed serializer.
  useEffect(() => setEntries(JSON.parse(persistedJson) as WorktreeFileSyncEntry[]), [persistedJson]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const duplicatePaths = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const path = entry.path.trim();
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([path]) => path));
  }, [entries]);

  const apply = async () => {
    if (hasInvalidEntry || duplicatePaths.size > 0) return;
    const normalized = entries.map((entry) => ({ ...entry, path: entry.path.trim() }));
    const saved = await persistence.saveConfig('worktree-file-sync', { worktreeFileSync: normalized });
    if (saved) onDirtyChange(false);
  };

  return (
    <SettingsPage title="Worktrees & Git" description="Application-wide defaults for commits, pull requests, and newly created worktrees.">
      <SettingsSection title="Git behavior">
        <SettingRow
          settingId="commit-footer"
          label="Include Pane footer in commits"
          description="Commits made through Pane include a footer crediting Pane."
          saveState={persistence.saveStates['commit-footer']}
        >
          <ImmediateToggle
            label="Include Pane footer in commits"
            value={config.enableCommitFooter !== false}
            onSave={(value) => persistence.saveConfig('commit-footer', { enableCommitFooter: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="git-attribution"
          label="Attribute commits to Pane"
          description="Set the git committer to Pane on commits made through Pane, so they show as committed by Pane on GitHub. Turn off to use your own git identity. Applies to newly opened terminals and commands."
          saveState={persistence.saveStates['git-attribution']}
        >
          <ImmediateToggle
            label="Attribute commits to Pane"
            value={config.gitAttributionEnabled !== false}
            onSave={(value) => persistence.saveConfig('git-attribution', { gitAttributionEnabled: value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="New worktrees" description="Copy gitignored configuration into newly created worktrees when it exists in the main repository.">
        <SettingRow
          settingId="worktree-file-sync"
          label="Files and directories"
          description="Package installation still runs separately in the background terminal."
          saveState={persistence.saveStates['worktree-file-sync']}
          align="start"
        >
          <div className="w-full space-y-3 sm:w-[430px]">
            <div className="space-y-2">
              {entries.map((entry, index) => {
                const path = entry.path.trim();
                const error = !path ? 'Path is required' : duplicatePaths.has(path) ? 'Path is duplicated' : undefined;
                return (
                  <div key={entry.id} className="flex items-start gap-2">
                    <Input
                      aria-label={`Worktree sync path ${index + 1}`}
                      value={entry.path}
                      onChange={(event) => setEntries((current) => current.map((item, itemIndex) => (
                        itemIndex === index ? { ...item, path: event.target.value } : item
                      )))}
                      placeholder="e.g. .env"
                      error={error}
                      className="font-mono text-sm"
                      fullWidth
                    />
                    <IconButton
                      type="button"
                      aria-label={entry.enabled ? 'Disable sync entry' : 'Enable sync entry'}
                      title={entry.enabled ? 'Disable' : 'Enable'}
                      icon={entry.enabled ? <Power className="h-4 w-4 text-status-success" /> : <PowerOff className="h-4 w-4" />}
                      onClick={() => setEntries((current) => current.map((item, itemIndex) => (
                        itemIndex === index ? { ...item, enabled: !item.enabled } : item
                      )))}
                    />
                    <IconButton
                      type="button"
                      aria-label="Remove sync entry"
                      title="Remove"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setEntries((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="h-4 w-4" />}
                  onClick={() => setEntries((current) => [...current, {
                    id: crypto.randomUUID(),
                    path: '',
                    enabled: true,
                    recursive: false,
                  }])}
                >
                  Add Entry
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEntries(DEFAULT_WORKTREE_FILE_SYNC_ENTRIES)}>
                  Reset Defaults
                </Button>
              </div>
              <Button type="button" size="sm" disabled={!dirty || hasInvalidEntry || duplicatePaths.size > 0} onClick={apply}>
                Apply
              </Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
