import { useId, useState } from 'react';
import { SaveState, SettingRow } from '../SettingRow';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { cn } from '../../../utils/cn';
import {
  ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  MIN_ARCHIVE_RETENTION_DAYS,
  parseArchiveRetentionDays,
} from '../../../../../shared/constants/archiveRetention';

const LABEL = 'Keep archived folders';
const DAYS_ERROR = `Enter whole days from ${MIN_ARCHIVE_RETENTION_DAYS} to ${MAX_ARCHIVE_RETENTION_DAYS}.`;

/** How long archived Session folders and Pane scratch stay on disk; agent logs in them are always kept. */
export function ArchiveRetentionSetting({ persistence }: { persistence: SettingsPersistence }) {
  const savedDays = persistence.config!.archiveRetentionDays ?? ARCHIVE_RETENTION_DAYS;
  return (
    <SettingRow
      settingId="archive-retention"
      label={LABEL}
      description="Archived Session folders, and the scratch files of archived Panes on your main checkout or an adopted worktree, are deleted this long after archiving. Restore before then to keep them. Pane never deletes your checkouts, and agent logs inside are kept for Usage & Limits."
      saveState={persistence.saveStates['archive-retention']}
      align="start"
    >
      <ArchiveRetentionDaysField key={savedDays} persistence={persistence} savedDays={savedDays} />
    </SettingRow>
  );
}

function ArchiveRetentionDaysField({ persistence, savedDays }: { persistence: SettingsPersistence; savedDays: number }) {
  const [text, setText] = useState(String(savedDays));
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const days = parseArchiveRetentionDays(text);
  const invalid = days === null;

  const save = () => {
    if (days === null || days === savedDays) return;
    void persistence.saveConfig('archive-retention', { archiveRetentionDays: days });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="sr-only">{LABEL}</label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={MIN_ARCHIVE_RETENTION_DAYS}
          max={MAX_ARCHIVE_RETENTION_DAYS}
          step={1}
          value={text}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
          className={cn(
            'w-20 rounded-input border bg-bg-primary px-2 py-1 text-sm tabular-nums text-text-primary focus:outline-none focus:ring-1',
            invalid ? 'border-status-error focus:ring-status-error' : 'border-border-primary focus:border-border-focus focus:ring-interactive',
          )}
        />
        <span className="text-sm text-text-secondary">days</span>
        <SaveState state={persistence.saveStates['archive-retention'] ?? { state: 'idle' }} />
      </div>
      {invalid && <p id={errorId} role="alert" className="text-xs text-status-error">{DAYS_ERROR} Nothing was saved; Pane keeps {savedDays} days.</p>}
    </div>
  );
}
