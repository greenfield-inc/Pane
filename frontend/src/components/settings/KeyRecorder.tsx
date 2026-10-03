import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { chordFromKeyboardEvent, parseChord } from '../../../../shared/utils/keyboardChords';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { isRecordableChord } from '../../utils/shortcutMap';

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

const RECORDER_COPY = {
  modifierOnly: 'Press a key with the modifier',
  altgr: 'Not a usable shortcut',
  cancelled: 'Recording cancelled',
  unassigned: 'Shortcut cleared',
  'empty': 'No key was pressed',
  'unknown-modifier': 'Unsupported modifier',
  'modifier-only': 'Press a key with the modifier',
  'bare-printable': 'Shortcuts with a letter, digit, or punctuation key must include Ctrl/⌘',
  'unsupported-key': "That key can't be used",
  'malformed': "That combination can't be used",
  'reserved-by-terminal': 'Reserved by the terminal (search/paste/copy/clear/flow control)',
  'bare-navigation-key': 'Add a modifier — that key alone is used for navigation and typing',
} as const;

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock']);

export function KeyRecorder({
  label, chord, defaultChord, customized, disabled, describedBy, onRecord, onUnassign, onReset,
}: KeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Latest callbacks for the native listener registered below.
  const callbacksRef = useRef({ defaultChord, onRecord, onUnassign, onReset });
  useEffect(() => {
    callbacksRef.current = { defaultChord, onRecord, onUnassign, onReset };
  }, [defaultChord, onRecord, onUnassign, onReset]);

  useEffect(() => {
    if (!recording) return;
    const finish = (message: string) => {
      setRecording(false);
      setStatus(message);
      buttonRef.current?.focus();
    };
    // Capture on window so the chord never reaches the Settings modal's
    // document-level Escape handler or the global hotkey listener.
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const { defaultChord: ownDefault, onRecord: record, onUnassign: unassign, onReset: reset } = callbacksRef.current;
      if (event.key === 'Escape') {
        finish(RECORDER_COPY.cancelled);
        return;
      }
      if (event.repeat) return;
      if (MODIFIER_KEYS.has(event.key)) {
        setStatus(RECORDER_COPY.modifierOnly);
        return;
      }
      const noModifiers = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if ((event.key === 'Backspace' || event.key === 'Delete') && noModifiers) {
        finish(RECORDER_COPY.unassigned);
        unassign();
        return;
      }
      const pressed = chordFromKeyboardEvent(event);
      if (pressed === '') {
        setStatus(RECORDER_COPY.altgr);
        return;
      }
      const parsed = parseChord(pressed);
      if (!parsed.ok) {
        setStatus(RECORDER_COPY[parsed.reason]);
        return;
      }
      const recordable = isRecordableChord(parsed.chord, { ownDefault });
      if (!recordable.ok) {
        setStatus(RECORDER_COPY[recordable.reason]);
        return;
      }
      finish(`Set to ${formatKeyDisplay(parsed.chord)}`);
      if (parsed.chord === ownDefault) reset();
      else record(parsed.chord);
    };
    // Swallow the matching keyup/keypress too so nothing downstream reacts to a half chord.
    const swallow = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const cancel = () => setRecording(false);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', swallow, true);
    window.addEventListener('keypress', swallow, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', swallow, true);
      window.removeEventListener('keypress', swallow, true);
      window.removeEventListener('blur', cancel);
    };
  }, [recording]);

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
