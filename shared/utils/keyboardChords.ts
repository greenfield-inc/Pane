/**
 * Key grammar shared by the renderer's hotkey store, the terminal, and main's
 * browser-tab forwarding.
 *
 * A chord is `[mod+][ctrl+][alt+][shift+]key`, canonical in that order.
 * `mod` is Command on macOS and Control elsewhere. `ctrl` is the macOS
 * Control key; on Windows and Linux it is the same key as `mod`, so
 * {@link chordForPlatform} folds it into `mod`. Keeping the two apart on macOS
 * is what lets the shell keep Ctrl+A/B/D/E/K/W while Pane owns Command.
 *
 * A key binding is one chord, or two chords separated by a space for a
 * two-step key ("mod+k mod+s", D-250). The first step of a two-step key must
 * hold `mod` or `ctrl` so ordinary typing can never start one.
 */
export type KeyPlatform = 'mac' | 'other';

export type ChordParseFailureReason =
  | 'empty'
  | 'unknown-modifier'
  | 'modifier-only'
  | 'bare-printable'
  | 'unsupported-key'
  | 'malformed'
  | 'too-many-steps'
  | 'bare-first-step';

export type ChordParseResult =
  | { ok: true; chord: string }
  | { ok: false; reason: ChordParseFailureReason };

export interface KeyboardEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState: (key: string) => boolean;
}

export interface ElectronKeyboardInputLike {
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const MODIFIER_ORDER = ['mod', 'ctrl', 'alt', 'shift'] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const NAMED_KEYS = new Map<string, string>([
  ['arrowleft', 'ArrowLeft'],
  ['arrowright', 'ArrowRight'],
  ['arrowup', 'ArrowUp'],
  ['arrowdown', 'ArrowDown'],
  ['tab', 'Tab'],
  ['enter', 'Enter'],
  ['escape', 'Escape'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['space', 'Space'],
  ...Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `F${index + 1}`] as const),
]);

const PUNCTUATION_BY_CODE = new Map<string, string>([
  ['Slash', '/'],
  ['Comma', ','],
  ['Period', '.'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backquote', '`'],
  ['Minus', '-'],
  ['Equal', '='],
  ['Backslash', '\\'],
  ['IntlBackslash', '\\'],
]);

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'OS', 'Hyper', 'Super']);

function canonicalKey(key: string): string | null {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toLowerCase();
  return NAMED_KEYS.get(key.toLowerCase()) ?? null;
}

export function canonicalChord(parts: readonly string[]): string {
  const modifiers = MODIFIER_ORDER.filter(modifier =>
    parts.some(part => part.toLowerCase() === modifier)
  );
  const key = parts.find(part => !MODIFIERS.has(part.toLowerCase()));
  return key ? [...modifiers, canonicalKey(key) ?? key].join('+') : modifiers.join('+');
}

function parseSingleChord(input: string): ChordParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // A trailing "+" names the plus key only in "mod++"; Pane binds none, so a
  // split part that is empty is always malformed.
  const parts = trimmed.split('+').map(part => part.trim());
  if (parts.some(part => !part)) return { ok: false, reason: 'malformed' };

  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIERS.has(lower)) {
      if (modifiers.includes(lower)) return { ok: false, reason: 'malformed' };
      modifiers.push(lower);
    } else {
      keys.push(part);
    }
  }

  if (keys.length === 0) return { ok: false, reason: 'modifier-only' };
  if (keys.length > 1) {
    const modifierLike = keys.some(key => /^[a-z]+$/i.test(key) && key.length > 1);
    return { ok: false, reason: modifierLike ? 'unknown-modifier' : 'malformed' };
  }

  const key = canonicalKey(keys[0]);
  if (!key) return { ok: false, reason: 'unsupported-key' };
  if (key.length === 1 && !modifiers.includes('mod') && !modifiers.includes('ctrl')) {
    return { ok: false, reason: 'bare-printable' };
  }

  return { ok: true, chord: canonicalChord([...modifiers, key]) };
}

/** Parses one chord or a two-step key into its canonical form. */
export function parseChord(input: string): ChordParseResult {
  const steps = input.trim().split(/\s+/).filter(Boolean);
  if (steps.length === 0) return { ok: false, reason: 'empty' };
  if (steps.length > 2) return { ok: false, reason: 'too-many-steps' };
  const parsed: string[] = [];
  for (const step of steps) {
    const result = parseSingleChord(step);
    if (!result.ok) return result;
    parsed.push(result.chord);
  }
  if (parsed.length === 2 && !/^(mod|ctrl)\+/.test(parsed[0])) {
    return { ok: false, reason: 'bare-first-step' };
  }
  return { ok: true, chord: parsed.join(' ') };
}

/** The steps of a binding: one for a plain chord, two for a two-step key. */
export function bindingSteps(binding: string): string[] {
  return binding.split(' ').filter(Boolean);
}

/**
 * The binding as it is matched on `platform`: off macOS, `ctrl` is the same
 * physical key as `mod`, so `mod+ctrl+x` and `ctrl+x` become `mod+x`.
 */
export function chordForPlatform(binding: string, platform: KeyPlatform): string {
  if (platform === 'mac') return binding;
  return bindingSteps(binding).map(step => {
    const parts = step.split('+');
    if (!parts.includes('ctrl')) return step;
    return canonicalChord([...parts.filter(part => part !== 'ctrl'), 'mod']);
  }).join(' ');
}

export function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return PUNCTUATION_BY_CODE.get(code) ?? null;
}

interface PressedModifiers {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

function chordFromParts(key: string, code: string, modifiers: PressedModifiers): string {
  if (MODIFIER_KEYS.has(key)) return '';
  const parts: string[] = [];
  if (modifiers.mod) parts.push('mod');
  if (modifiers.ctrl) parts.push('ctrl');
  if (modifiers.alt) parts.push('alt');
  if (modifiers.shift) parts.push('shift');

  // Option changes e.key for every key ("å" for Option+A), so under Alt the
  // physical key names it. Shift and macOS Control change only digits and
  // punctuation ("@" for Shift+2, "{" for Shift+[); letters keep e.key so
  // other layouts (Dvorak, AZERTY) match the letter printed on the key.
  const physical = keyFromCode(code);
  const physicalIsLetter = /^Key[A-Z]$/.test(code);
  const codeKey = modifiers.alt || ((modifiers.shift || modifiers.ctrl) && !physicalIsLetter)
    ? physical
    : null;
  let normalizedKey = codeKey ?? (key.length === 1 ? key.toLowerCase() : key);
  if (code === 'Backslash' || code === 'IntlBackslash') normalizedKey = '\\';
  if (code === 'Space') normalizedKey = 'Space';
  const namedKey = canonicalKey(normalizedKey);
  parts.push(namedKey ?? normalizedKey);
  return parts.join('+');
}

function modifiersFor(
  platform: KeyPlatform,
  pressed: { control: boolean; meta: boolean; alt: boolean; shift: boolean },
): PressedModifiers | null {
  if (platform === 'mac') {
    return { mod: pressed.meta, ctrl: pressed.control, alt: pressed.alt, shift: pressed.shift };
  }
  // The Windows/Super key is not part of Pane's grammar off macOS.
  if (pressed.meta) return null;
  return { mod: pressed.control, ctrl: false, alt: pressed.alt, shift: pressed.shift };
}

export function chordFromKeyboardEvent(event: KeyboardEventLike, platform: KeyPlatform): string {
  if (event.getModifierState('AltGraph')) return '';
  const modifiers = modifiersFor(platform, {
    control: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey,
  });
  return modifiers ? chordFromParts(event.key, event.code, modifiers) : '';
}

export function chordFromElectronInput(input: ElectronKeyboardInputLike, platform: KeyPlatform): string {
  const modifiers = modifiersFor(platform, {
    control: input.control, meta: input.meta, alt: input.alt, shift: input.shift,
  });
  return modifiers ? chordFromParts(input.key, input.code, modifiers) : '';
}

/** Whether a keydown is only a modifier going down (it never ends a pending two-step key). */
export function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

export function keyPlatformFor(platform: string): KeyPlatform {
  return platform === 'darwin' || platform === 'macos' || platform === 'mac' ? 'mac' : 'other';
}
