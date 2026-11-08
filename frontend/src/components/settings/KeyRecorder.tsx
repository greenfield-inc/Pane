import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { useKeyRecording } from '../../hooks/useKeyRecording';

interface KeyRecorderProps {
  label: string;
  chord: string | null;
  /** The row's catalog default; recording it removes the override instead of storing a duplicate. */
  defaultChord: string | null;
  /** Row has an explicit override or unassignment that Reset would remove. */
  customized: boolean;
  disabled?: boolean;
  /** Ids of elements describing the row (inline status/conflict text). */
  describedBy?: string;
  onRecord: (chord: string) => void;
  onUnassign: () => void;
  onReset: () => void;
}

export function KeyRecorder({
  label, chord, defaultChord, customized, disabled, describedBy, onRecord, onUnassign, onReset,
}: KeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);

  useKeyRecording({
    recording,
    defaultChord,
    finish: (message) => {
      setRecording(false);
      setStatus(message);
      buttonRef.current?.focus();
    },
    setStatus,
    onRecord,
    onUnassign,
    onReset,
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={recording ? `Recording shortcut for ${label}. Press keys, or Escape to cancel` : `Record shortcut for ${label}`}
        aria-pressed={recording}
        aria-describedby={describedBy}
        className="inline-flex min-w-[9rem] items-center justify-center rounded-md border border-border-primary bg-surface-secondary px-2 py-1 text-xs text-text-primary hover:border-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-interactive aria-pressed:ring-1 aria-pressed:ring-interactive"
        onClick={() => { setRecording((current) => !current); setStatus(''); }}
        onBlur={() => setRecording(false)}
      >
        {recording
          ? <span className="text-interactive">Press keys… (Esc cancels)</span>
          : chord
            ? <Kbd size="sm">{formatKeyDisplay(chord)}</Kbd>
            : <span className="italic text-text-muted">Unassigned</span>}
      </button>
      <Button type="button" variant="ghost" size="sm" disabled={disabled || chord === null} aria-label={`Clear shortcut for ${label}`} onClick={onUnassign}>
        Clear
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={disabled || !customized} aria-label={`Reset ${label} to default`} onClick={onReset}>
        Reset
      </Button>
      <span role="status" aria-live="polite" className={status ? 'basis-full text-[11px] text-text-tertiary' : 'sr-only'}>
        {status}
      </span>
    </div>
  );
}
