import { useEffect, useRef } from 'react';
import { parseChord, type ChordParseFailureReason } from '../../../shared/utils/keyboardChords';
import { chordForEvent } from '../stores/hotkeyStore';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { isRecordableChord } from '../utils/shortcutMap';

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
  'too-many-steps': 'A key can have at most two steps',
  'bare-first-step': 'The first step of a two-step key needs Ctrl/⌘',
  'reserved-by-terminal': 'Reserved by the terminal (copy, paste, clear)',
  'bare-navigation-key': 'Add a modifier — that key alone is used for navigation and typing',
} as const satisfies Record<ChordParseFailureReason | 'modifierOnly' | 'altgr' | 'cancelled' | 'unassigned' | 'reserved-by-terminal' | 'bare-navigation-key', string>;

/** After a first chord with Ctrl/⌘, how long the recorder waits for a second step (D-250). */
const SECOND_STEP_WAIT_MS = 1200;

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock']);

interface KeyRecordingOptions {
  /** Record while true; the keys go nowhere else. */
  recording: boolean;
  /** The command's default: recording it resets instead of storing a copy. */
  defaultChord: string | null;
  /** Ends recording with a message for the status line. */
  finish: (message: string) => void;
  setStatus: (message: string) => void;
  onRecord: (chord: string) => void;
  onUnassign: () => void;
  onReset: () => void;
}

/**
 * Records one binding from the keyboard: a chord, or a two-step key when a
 * second chord follows a Ctrl/⌘ chord within a moment (D-250). Esc cancels,
 * Backspace or Delete clears. Shared by Settings › Keyboard Shortcuts and the
 * palette's Change key… (P7).
 */
export function useKeyRecording(options: KeyRecordingOptions): void {
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const { recording } = options;
  useEffect(() => {
    if (!recording) return;
    const finish = (message: string) => latest.current.finish(message);
    const setStatus = (message: string) => latest.current.setStatus(message);
    // Capture on window so the chord never reaches the Settings modal's
    // document-level Escape handler or the global hotkey listener.
    // A chord with Ctrl/⌘ may be the first step of a two-step key: hold it
    // briefly, and a second chord within the wait completes the pair.
    let firstStep: string | null = null;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    const commit = (binding: string) => {
      const { defaultChord: ownDefault, onRecord: record, onReset: reset } = latest.current;
      const recordable = isRecordableChord(binding, { ownDefault });
      if (!recordable.ok) {
        firstStep = null;
        setStatus(RECORDER_COPY[recordable.reason]);
        return;
      }
      finish(`Set to ${formatKeyDisplay(binding)}`);
      if (binding === ownDefault) reset();
      else record(binding);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const { onUnassign: unassign } = latest.current;
      if (event.key === 'Escape') {
        if (waitTimer) clearTimeout(waitTimer);
        finish(RECORDER_COPY.cancelled);
        return;
      }
      if (event.repeat) return;
      if (MODIFIER_KEYS.has(event.key)) {
        if (!firstStep) setStatus(RECORDER_COPY.modifierOnly);
        return;
      }
      const noModifiers = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if ((event.key === 'Backspace' || event.key === 'Delete') && noModifiers && !firstStep) {
        finish(RECORDER_COPY.unassigned);
        unassign();
        return;
      }
      const pressed = chordForEvent(event);
      if (pressed === '') {
        setStatus(RECORDER_COPY.altgr);
        return;
      }
      if (firstStep) {
        if (waitTimer) clearTimeout(waitTimer);
        const pair = parseChord(`${firstStep} ${pressed}`);
        if (!pair.ok) {
          firstStep = null;
          setStatus(RECORDER_COPY[pair.reason]);
          return;
        }
        commit(pair.chord);
        return;
      }
      const parsed = parseChord(pressed);
      if (!parsed.ok) {
        setStatus(RECORDER_COPY[parsed.reason]);
        return;
      }
      if (/^(mod|ctrl)\+/.test(parsed.chord)) {
        firstStep = parsed.chord;
        setStatus(`${formatKeyDisplay(parsed.chord)}: press a second key for a two-step key, or wait`);
        waitTimer = setTimeout(() => {
          waitTimer = null;
          const single = firstStep;
          firstStep = null;
          if (single) commit(single);
        }, SECOND_STEP_WAIT_MS);
        return;
      }
      commit(parsed.chord);
    };
    // Swallow the matching keyup/keypress too so nothing downstream reacts to a half chord.
    const swallow = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const cancel = () => latest.current.finish('');
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', swallow, true);
    window.addEventListener('keypress', swallow, true);
    window.addEventListener('blur', cancel);
    return () => {
      if (waitTimer) clearTimeout(waitTimer);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', swallow, true);
      window.removeEventListener('keypress', swallow, true);
      window.removeEventListener('blur', cancel);
    };
  }, [recording]);
}
