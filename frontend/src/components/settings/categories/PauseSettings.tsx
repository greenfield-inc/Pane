import { useEffect, useId, useState } from 'react';
import { SaveState, SettingRow } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { cn } from '../../../utils/cn';
import {
  DEFAULT_AUTO_PAUSE_HOURS,
  MAX_AUTO_PAUSE_HOURS,
  MIN_AUTO_PAUSE_HOURS,
  isValidAutoPauseHours,
} from '../../../../../shared/types/autoPause';

const RESUME_LABEL = 'Resume a paused Pane when you open it';
const AUTO_PAUSE_LABEL = 'Pause idle Panes';
const HOURS_ERROR = `Enter whole hours from ${MIN_AUTO_PAUSE_HOURS} to ${MAX_AUTO_PAUSE_HOURS}.`;

/** The hours typed into the auto-pause field, or null when Settings refuses them. */
export function parseAutoPauseHours(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const hours = Number(trimmed);
  return isValidAutoPauseHours(hours) ? hours : null;
}

/**
 * Resume-on-open (off by default) and auto-pause (on by default), with the idle threshold
 * under it. Turning auto-pause off disables the field but keeps its value.
 */
export function PauseSettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const autoPauseEnabled = config.autoPauseEnabled !== false;
  const savedHours = config.autoPauseAfterHours ?? DEFAULT_AUTO_PAUSE_HOURS;

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
        description="Stops the agents and scripts of a Pane nobody has used for this long. Panes waiting on you are skipped. Resume brings them back in the same conversations."
        saveState={persistence.saveStates['auto-pause']}
        align="start"
        details={<AutoPauseHoursField persistence={persistence} savedHours={savedHours} disabled={!autoPauseEnabled} />}
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

function AutoPauseHoursField({ persistence, savedHours, disabled }: { persistence: SettingsPersistence; savedHours: number; disabled: boolean }) {
  const [text, setText] = useState(String(savedHours));
  const inputId = useId();
  const errorId = `${inputId}-error`;
  useEffect(() => setText(String(savedHours)), [savedHours]);
  const hours = parseAutoPauseHours(text);
  const invalid = hours === null;

  const save = () => {
    if (hours === null || hours === savedHours) return;
    void persistence.saveConfig('auto-pause-hours', { autoPauseAfterHours: hours });
  };

  return (
    <div className={cn('ml-0 space-y-1', disabled && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="text-sm text-text-primary">Pause after</label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={MIN_AUTO_PAUSE_HOURS}
          max={MAX_AUTO_PAUSE_HOURS}
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
        <span className="text-sm text-text-secondary">hours without use</span>
        <SaveState state={persistence.saveStates['auto-pause-hours'] ?? { state: 'idle' }} />
      </div>
      {invalid && <p id={errorId} role="alert" className="text-xs text-status-error">{HOURS_ERROR} Nothing was saved; Pane keeps {savedHours} hours.</p>}
    </div>
  );
}
