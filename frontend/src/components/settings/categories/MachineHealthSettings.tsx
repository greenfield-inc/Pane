import { useId, useState } from 'react';
import { MACHINE_HEALTH_CLEANUP_CHANNEL, type MachineHealthSettings as HealthSettings } from '../../../../../shared/types/machineHealth';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { SettingsSettingId } from '../../../types/settings';
import { showActionError } from '../../../stores/errorStore';
import { cn } from '../../../utils/cn';

interface NumberFieldProps {
  label: string;
  unit: string;
  saved: number;
  min: number;
  max: number;
  onSave: (value: number) => void;
}

/** A whole number saved on blur or Enter, refused outside min..max. */
function NumberField({ label, unit, saved, min, max, onSave }: NumberFieldProps) {
  const [text, setText] = useState(String(saved));
  const id = useId();
  const value = /^\d+$/u.test(text.trim()) ? Number(text.trim()) : null;
  const invalid = value === null || value < min || value > max;
  const save = () => { if (!invalid && value !== saved) onSave(value); };
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">{label}</label>
      <input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} value={text} aria-invalid={invalid || undefined}
        onChange={event => setText(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') save(); }}
        className={cn('w-20 rounded-md border bg-surface-primary px-2 py-1 text-sm text-text-primary', invalid ? 'border-status-error' : 'border-border-primary')} />
      <span className="text-sm text-text-secondary">{unit}</span>
    </div>
  );
}

const AUTOMATIC: Array<{ key: keyof HealthSettings; label: string; description: string }> = [
  { key: 'autoArchiveFinished', label: 'Archive finished Panes automatically', description: 'Panes whose PR merged or closed, whose folder is missing, or that sat idle for the days below. Branches stay and Restore works.' },
  { key: 'autoClearAgentTemp', label: 'Clear agent temp files automatically', description: 'Temp folders of Panes that are gone, and items nobody touched for 2 days with no process working in them.' },
  { key: 'autoClearPausedScratch', label: 'Clear scratch of paused Panes automatically', description: 'QA and scratch folders of Panes whose tabs are all paused.' },
  { key: 'autoClearArchivedFolders', label: 'Remove folders left by archived Panes automatically', description: 'Only folders git confirms were that Pane\'s worktree.' },
  { key: 'autoPauseUnderPressure', label: 'Pause idle Panes automatically when memory is tight', description: 'Once per pressure episode, with the same skips as auto-pause.' },
  { key: 'autoStopLeftovers', label: 'Stop leftover processes automatically', description: 'Processes that left a Pane that is not archived. Those of archived and paused Panes always stop by themselves.' },
];

/** Settings → Machine health: thresholds, the automatic switch for each kind Pane otherwise asks about, and Run now. */
export function MachineHealthSettings({ persistence }: { persistence: SettingsPersistence }) {
  const health = persistence.config!.machineHealth ?? {};
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<string | null>(null);
  const save = (settingId: SettingsSettingId, update: HealthSettings) =>
    persistence.saveConfig(settingId, { machineHealth: { ...health, ...update } });

  return (
    <SettingsPage title="Machine health" description="Pane watches free disk, memory pressure and every process it started. It removes its own leftovers by itself and asks before anything else; each kind below can be switched to automatic.">
      <SettingsSection title="Thresholds">
        <SettingRow settingId="machine-health-disk" label="Disk warning" description="Pane warns below the first figure and alerts below the second, on any volume holding its data, your worktrees or the temp folder." saveState={persistence.saveStates['machine-health-disk']}>
          <div className="flex items-center gap-4">
            <NumberField label="Warn below" unit="GB free" saved={health.diskWarningGB ?? 20} min={1} max={10_000} onSave={value => { void save('machine-health-disk', { diskWarningGB: value }); }} />
            <NumberField label="Alert below" unit="GB free" saved={health.diskCriticalGB ?? 5} min={1} max={10_000} onSave={value => { void save('machine-health-disk', { diskCriticalGB: value }); }} />
          </div>
        </SettingRow>
        <SettingRow settingId="machine-health-memory" label="Pause idle Panes under pressure after" description="When memory is tight, Pane offers to pause Panes idle this long." saveState={persistence.saveStates['machine-health-memory']}>
          <NumberField label="Idle hours" unit="hours" saved={health.pauseIdleHours ?? 2} min={1} max={720} onSave={value => { void save('machine-health-memory', { pauseIdleHours: value }); }} />
        </SettingRow>
        <SettingRow settingId="machine-health-finished" label="A Pane is finished after" description="Days with no activity before Pane offers to archive a Pane whose PR is still open or has none." saveState={persistence.saveStates['machine-health-finished']}>
          <NumberField label="Idle days" unit="days" saved={health.finishedIdleDays ?? 14} min={0} max={365} onSave={value => { void save('machine-health-finished', { finishedIdleDays: value }); }} />
        </SettingRow>
        <SettingRow settingId="machine-health-leak" label="Leak window" description="A Pane process counts as leaking when it has grown in every slice of this window, by at least 500 MB and 50%." saveState={persistence.saveStates['machine-health-leak']}>
          <div className="flex items-center gap-4">
            <NumberField label="Window" unit="minutes" saved={health.leakWindowMinutes ?? 30} min={2} max={240} onSave={value => { void save('machine-health-leak', { leakWindowMinutes: value }); }} />
            <NumberField label="Slice" unit="min slices" saved={health.leakSliceMinutes ?? 5} min={1} max={60} onSave={value => { void save('machine-health-leak', { leakSliceMinutes: value }); }} />
          </div>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Do it automatically">
        {AUTOMATIC.map(item => (
          <SettingRow key={item.key} settingId="machine-health-automatic" label={item.label} description={item.description} saveState={persistence.saveStates['machine-health-automatic']}>
            <ImmediateToggle label={item.label} value={health[item.key] === true} onSave={value => save('machine-health-automatic', { [item.key]: value })} />
          </SettingRow>
        ))}
      </SettingsSection>
      <SettingsSection title="Pane's own leftovers">
        <SettingRow settingId="machine-health-run-now" label="Remove Pane's leftovers now" description="Replaced update copies and old migration backups go by themselves every day and when disk runs low. Run that pass now." saveState={undefined}>
          <div className="flex items-center gap-3">
            {ran && <span className="text-sm text-text-secondary" role="status">{ran}</span>}
            <Button size="sm" variant="secondary" disabled={running} onClick={async () => {
              setRunning(true);
              try {
                // SAFETY: the cleanup channel answers a CleanupRun.
                const run = await window.electronAPI.invoke(MACHINE_HEALTH_CLEANUP_CHANNEL, { kinds: ['update-snapshot', 'migration-backup'], source: 'ui' }) as { removed: unknown[]; freedBytes: number };
                setRan(run.removed.length ? `Removed ${run.removed.length}, freed ${Math.round(run.freedBytes / 1024 ** 2)} MB.` : 'Nothing to remove.');
              } catch (error) {
                showActionError('Could not remove Pane\'s leftovers', error);
              } finally {
                setRunning(false);
              }
            }}>Run now</Button>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
