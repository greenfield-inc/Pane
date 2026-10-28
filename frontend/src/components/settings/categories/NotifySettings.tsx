import { useEffect, useState } from 'react';
import {
  DEFAULT_NOTIFY_SETTINGS,
  NOTIFY_UPDATES_HIDE_AFTER_CHOICES,
  type NotifyInstructionsFile,
  type NotifyPosition,
  type NotifySettings as NotifySettingValues,
} from '../../../../../shared/types/notify';
import { cn } from '../../../utils/cn';
import { isMac } from '../../../utils/platformUtils';
import { useNotifyStore } from '../../../stores/notifyStore';
import { acceleratorFromKeys, shortcutLabel } from '../../notify/notifyFormat';
import { ShortcutCap } from '../../notify/NotifyCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/Select';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { SettingsSettingId } from '../../../types/settings';

/** The mockup's two rounded groups. */
const SETTINGS_GROUP = 'divide-y divide-border-secondary rounded-2xl bg-surface-primary px-4 shadow-card ring-1 ring-border-secondary';

const POSITIONS: Array<{ id: NotifyPosition; label: string }> = [
  { id: 'bottom-center', label: 'Bottom center' },
  { id: 'top-right', label: 'Top right' },
  { id: 'bottom-right', label: 'Bottom right' },
];

/** Where the little card sits in each position tile. */
const POSITION_MARK = {
  'bottom-center': 'bottom-1.5 left-1/2 w-[55%] -translate-x-1/2',
  'top-right': 'right-1.5 top-1.5 w-[45%]',
  'bottom-right': 'bottom-1.5 right-1.5 w-[45%]',
} satisfies Record<NotifyPosition, string>;

function PositionPicker({ value, disabled, onChange }: { value: NotifyPosition; disabled: boolean; onChange: (position: NotifyPosition) => void }) {
  return (
    <div role="radiogroup" aria-label="Position" className="flex gap-2.5">
      {POSITIONS.map((position) => {
        const selected = position.id === value;
        return (
          <button
            key={position.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(position.id)}
            className={cn(
              'w-[104px] rounded-[10px] bg-surface-primary p-1.5 text-center text-[11.5px] disabled:cursor-not-allowed',
              selected ? 'font-medium text-text-primary ring-2 ring-text-primary' : 'text-text-tertiary ring-1 ring-border-primary enabled:hover:ring-border-hover',
            )}
          >
            <span className="relative mb-[5px] block h-11 rounded-[5px] bg-surface-tertiary" aria-hidden="true">
              <i className={cn('absolute block h-[7px] rounded-sm bg-surface-primary shadow-sm', POSITION_MARK[position.id])} />
            </span>
            {position.label}
          </button>
        );
      })}
    </div>
  );
}

function ShortcutRecorder({ accelerator, disabled, onSave }: { accelerator: string; disabled: boolean; onSave: (accelerator: string) => void }) {
  const [recording, setRecording] = useState(false);
  const mac = isMac();

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(false);
        return;
      }
      const next = acceleratorFromKeys(event, mac);
      if (!next) return;
      setRecording(false);
      if (next !== accelerator) onSave(next);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [accelerator, mac, onSave, recording]);

  return (
    <div className="inline-flex items-center gap-1 rounded-lg p-1 ring-1 ring-border-primary">
      <ShortcutCap>{recording ? 'Press keys…' : shortcutLabel(accelerator, mac)}</ShortcutCap>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setRecording((value) => !value)}
        className="rounded-md px-2 py-0.5 text-[13px] font-medium text-text-primary enabled:hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-text-tertiary"
      >
        {recording ? 'Cancel' : 'Change'}
      </button>
    </div>
  );
}

export function NotifySettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  // The snapshot carries main's live settings, so a change from the tray shows here at once.
  const live = useNotifyStore((state) => state.snapshot?.settings);
  const settings: NotifySettingValues = live ?? { ...DEFAULT_NOTIFY_SETTINGS, ...config.notify };
  const shortcutRegistered = useNotifyStore((state) => state.snapshot?.shortcutRegistered ?? true);
  const showOutsideSupported = useNotifyStore((state) => state.snapshot?.showOutsideSupported ?? true);
  const instructionFiles = useNotifyStore((state) => state.snapshot?.instructionFiles ?? NO_INSTRUCTION_FILES);
  const off = !settings.enabled;

  const save = <K extends keyof NotifySettingValues>(settingId: SettingsSettingId, key: K, value: NotifySettingValues[K]) =>
    // Only the edited key: main merges it, so a newer tray change isn't overwritten.
    persistence.saveConfig(settingId, { notify: { [key]: value } });

  const shortcutText = shortcutLabel(settings.shortcut, isMac());
  return (
    <SettingsPage title="Notify" description="Agents can ask you questions and tell you things. Answers go straight back to the agent.">
      <div className={SETTINGS_GROUP}>
        <SettingRow
          settingId="notify-enabled"
          label="Notify"
          description="Let agents in Pane ask you questions and send updates."
          saveState={persistence.saveStates['notify-enabled']}
        >
          <ImmediateToggle label="Notify" value={settings.enabled} onSave={(enabled) => save('notify-enabled', 'enabled', enabled)} />
        </SettingRow>
        <SettingRow
          settingId="notify-show-outside"
          label="Show outside Pane"
          description={showOutsideSupported
            ? 'Cards appear over any app, like your browser.'
            : 'Unavailable on native Wayland, where Pane can’t place a window over other apps. Cards show inside Pane.'}
          saveState={persistence.saveStates['notify-show-outside']}
          disabled={off || !showOutsideSupported}
          className="pl-4"
        >
          <ImmediateToggle
            label="Show outside Pane"
            value={settings.showOutsidePane && showOutsideSupported}
            disabled={off || !showOutsideSupported}
            onSave={(showOutsidePane) => save('notify-show-outside', 'showOutsidePane', showOutsidePane)}
          />
        </SettingRow>
      </div>

      <div className={SETTINGS_GROUP}>
        <SettingRow
          settingId="notify-position"
          label="Position"
          description="Where cards appear on your screen."
          saveState={persistence.saveStates['notify-position']}
          disabled={off}
        >
          <PositionPicker value={settings.position} disabled={off} onChange={(position) => void save('notify-position', 'position', position)} />
        </SettingRow>
        <SettingRow
          settingId="notify-shortcut"
          label="Answer-all shortcut"
          description="Works from any app."
          saveState={shortcutRegistered || off
            ? persistence.saveStates['notify-shortcut']
            : { state: 'error', message: `Another app is using ${shortcutText}, so it can't open Answer all. Choose a different shortcut.` }}
          disabled={off}
        >
          <ShortcutRecorder accelerator={settings.shortcut} disabled={off} onSave={(shortcut) => void save('notify-shortcut', 'shortcut', shortcut)} />
        </SettingRow>
        <SettingRow
          settingId="notify-updates-hide-after"
          label="Updates hide after"
          description="Questions stay until you answer them."
          saveState={persistence.saveStates['notify-updates-hide-after']}
          disabled={off}
        >
          <Select
            value={String(settings.updatesHideAfterSeconds)}
            disabled={off}
            onValueChange={(value) => void save('notify-updates-hide-after', 'updatesHideAfterSeconds', Number(value))}
          >
            <SelectTrigger aria-label="Updates hide after" className="h-[30px] w-[120px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {NOTIFY_UPDATES_HIDE_AFTER_CHOICES.map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>{seconds} seconds</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          settingId="notify-sound"
          label="Sound"
          description="For questions only, never for updates."
          saveState={persistence.saveStates['notify-sound']}
          disabled={off}
        >
          <ImmediateToggle label="Sound" value={settings.sound} disabled={off} onSave={(sound) => save('notify-sound', 'sound', sound)} />
        </SettingRow>
      </div>

      {instructionFiles.length > 0 && <AgentInstructions files={instructionFiles} />}
    </SettingsPage>
  );
}

/** One empty list for every render: a fresh [] from the store selector re-renders forever. */
const NO_INSTRUCTION_FILES: NotifyInstructionsFile[] = [];

const INSTRUCTIONS_STATE_LABELS = {
  written: 'Written',
  absent: 'Not written',
  'not-found': 'Not found',
  skipped: 'Not updated',
} satisfies Record<NotifyInstructionsFile['state'], string>;

/** Which user-level instruction files hold Pane's Notify block. */
function AgentInstructions({ files }: { files: NotifyInstructionsFile[] }) {
  return (
    <section className="rounded-2xl bg-surface-primary p-4 shadow-card ring-1 ring-border-secondary" aria-labelledby="notify-agent-instructions">
      <h3 id="notify-agent-instructions" className="text-sm font-medium text-text-primary">Agent instructions</h3>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-tertiary">
        While Notify is on, Pane keeps a few lines in these files that tell agents to ask you here. Turning Notify off removes them.
      </p>
      <ul className="mt-3 space-y-2">
        {files.map((file) => (
          <li key={file.file} data-testid="notify-instructions-file" className="text-xs">
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-text-secondary">{file.agent}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-text-tertiary" title={file.file}>{file.file}</span>
              <span className={cn('shrink-0', file.state === 'skipped' ? 'text-status-warning' : 'text-text-secondary')}>
                {INSTRUCTIONS_STATE_LABELS[file.state]}
              </span>
            </div>
            {file.reason && <p className="mt-1 pl-[6.75rem] text-text-tertiary">{file.reason}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
