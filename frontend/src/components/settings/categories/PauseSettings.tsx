import { useId, useState } from 'react';
import { SaveState, SettingRow } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { SettingsSettingId } from '../../../types/settings';
import { cn } from '../../../utils/cn';
import {
  DEFAULT_AUTO_PAUSE_HOURS,
  DEFAULT_CHAT_RELEASE_MINUTES,
  MAX_AUTO_PAUSE_HOURS,
  MAX_CHAT_RELEASE_MINUTES,
  MIN_AUTO_PAUSE_HOURS,
  MIN_CHAT_RELEASE_MINUTES,
  parseAutoPauseHours,
  parseChatReleaseMinutes,
} from '../../../../../shared/types/autoPause';

const RESUME_LABEL = 'Resume a paused Pane when you open it';
const AUTO_PAUSE_LABEL = 'Pause idle Panes';

/**
 * Resume-on-open (off by default) and auto-pause (on by default), with its two idle thresholds
 * under it: Panes in hours, chat tabs in minutes. Turning auto-pause off disables both fields but keeps their values.
 */
export function PauseSettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const autoPauseEnabled = config.autoPauseEnabled !== false;
  const savedHours = config.autoPauseAfterHours ?? DEFAULT_AUTO_PAUSE_HOURS;
  const savedMinutes = config.chatIdleReleaseMinutes ?? DEFAULT_CHAT_RELEASE_MINUTES;

  return (
    <>
      <SettingRow
        settingId="resume-paused-on-open"
        label={RESUME_LABEL}
        description="Selecting a paused Pane starts it again in the same conversations; a paused Session resumes only its chat. When off, a paused Pane shows its last screen and starts nothing until you choose Resume."
        saveState={persistence.saveStates['resume-paused-on-open']}
      >
        <ImmediateToggle
          label={RESUME_LABEL}
          value={config.resumePausedOnOpen === true}
          onSave={(value) => persistence.saveConfig('resume-paused-on-open', { resumePausedOnOpen: value })}
        />
      </SettingRow>
      <SettingRow
        settingId="auto-pause"
        label={AUTO_PAUSE_LABEL}
        description="Stops the agents and scripts of a Pane nobody has used for this long, and the agent of a chat tab idle for its shorter time. Panes and chats waiting on you are skipped, and so are the Pane you're working in and the chats of the Pane on screen. Resume brings a Pane back in the same conversations; a chat tab resumes when you open it or send it a message. Wakeups and scheduled jobs a chat agent keeps only in memory end with it."
        saveState={persistence.saveStates['auto-pause']}
        align="start"
        details={(
          <div className="space-y-2">
            <ThresholdField
              key={`hours-${savedHours}`}
              persistence={persistence}
              saved={savedHours}
              disabled={!autoPauseEnabled}
              label="Pause Panes after"
              unit="hours without use"
              min={MIN_AUTO_PAUSE_HOURS}
              max={MAX_AUTO_PAUSE_HOURS}
              parse={parseAutoPauseHours}
              error={`Enter whole hours from ${MIN_AUTO_PAUSE_HOURS} to ${MAX_AUTO_PAUSE_HOURS}.`}
              unitWord="hours"
              saveKey="auto-pause-hours"
              onSave={value => persistence.saveConfig('auto-pause-hours', { autoPauseAfterHours: value })}
            />
            <ThresholdField
              key={`minutes-${savedMinutes}`}
              persistence={persistence}
              saved={savedMinutes}
              disabled={!autoPauseEnabled}
              label="Pause chat tabs after"
              unit="idle minutes"
              min={MIN_CHAT_RELEASE_MINUTES}
              max={MAX_CHAT_RELEASE_MINUTES}
              parse={parseChatReleaseMinutes}
              error={`Enter whole minutes from ${MIN_CHAT_RELEASE_MINUTES} to ${MAX_CHAT_RELEASE_MINUTES}.`}
              unitWord="minutes"
              saveKey="chat-idle-release-minutes"
              onSave={value => persistence.saveConfig('chat-idle-release-minutes', { chatIdleReleaseMinutes: value })}
            />
          </div>
        )}
      >
        <ImmediateToggle
          label={AUTO_PAUSE_LABEL}
          value={autoPauseEnabled}
          onSave={(value) => persistence.saveConfig('auto-pause', { autoPauseEnabled: value })}
        />
      </SettingRow>
    </>
  );
}

interface ThresholdFieldProps {
  persistence: SettingsPersistence;
  saved: number;
  disabled: boolean;
  label: string;
  unit: string;
  min: number;
  max: number;
  parse: (text: string) => number | null;
  error: string;
  /** The unit after a kept value: "hours", "minutes". */
  unitWord: string;
  saveKey: SettingsSettingId;
  onSave: (value: number) => void;
}

function ThresholdField({ persistence, saved, disabled, label, unit, min, max, parse, error, unitWord, saveKey, onSave }: ThresholdFieldProps) {
  const [text, setText] = useState(String(saved));
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const value = parse(text);
  const invalid = value === null;

  const save = () => {
    if (value === null || value === saved) return;
    onSave(value);
  };

  return (
    <div className={cn('ml-0 space-y-1', disabled && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="text-sm text-text-primary">{label}</label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
          className={cn(
            'w-20 rounded-input border bg-bg-primary px-2 py-1 text-sm tabular-nums text-text-primary focus:outline-none focus:ring-1 disabled:cursor-not-allowed',
            invalid ? 'border-status-error focus:ring-status-error' : 'border-border-primary focus:border-border-focus focus:ring-interactive',
          )}
        />
        <span className="text-sm text-text-secondary">{unit}</span>
        <SaveState state={persistence.saveStates[saveKey] ?? { state: 'idle' }} />
      </div>
      {invalid && <p id={errorId} role="alert" className="text-xs text-status-error">{error} Nothing was saved; Pane keeps {saved} {unitWord}.</p>}
    </div>
  );
}
