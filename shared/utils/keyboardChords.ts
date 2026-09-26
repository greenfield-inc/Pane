export type ChordParseFailureReason =
  | 'empty'
  | 'unknown-modifier'
  | 'modifier-only'
  | 'bare-printable'
  | 'unsupported-key'
  | 'malformed';

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

const MODIFIER_ORDER = ['mod', 'alt', 'shift'] as const;
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

export function parseChord(input: string): ChordParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

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
  if (key.length === 1 && !modifiers.includes('mod')) {
    return { ok: false, reason: 'bare-printable' };
  }

  return { ok: true, chord: canonicalChord([...modifiers, key]) };
}

export function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return PUNCTUATION_BY_CODE.get(code) ?? null;
}

function chordFromParts(
  key: string,
  code: string,
  modifiers: { ctrlOrMeta: boolean; alt: boolean; shift: boolean },
): string {
  const parts: string[] = [];
  if (modifiers.ctrlOrMeta) parts.push('mod');
  if (modifiers.alt) parts.push('alt');
  if (modifiers.shift) parts.push('shift');

  const codeKey = modifiers.alt ? keyFromCode(code) : null;
  let normalizedKey = codeKey ?? (key.length === 1 ? key.toLowerCase() : key);
  const shiftedDigit = modifiers.shift ? /^Digit([0-9])$/.exec(code) : null;
  if (shiftedDigit) normalizedKey = shiftedDigit[1];
  if (code === 'Backslash' || code === 'IntlBackslash') normalizedKey = '\\';
  const namedKey = canonicalKey(normalizedKey);
  parts.push(namedKey ?? normalizedKey);
  return parts.join('+');
}

export function chordFromKeyboardEvent(event: KeyboardEventLike): string {
  if (event.getModifierState('AltGraph')) return '';
  return chordFromParts(event.key, event.code, {
    ctrlOrMeta: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  });
}

export function chordFromElectronInput(input: ElectronKeyboardInputLike): string {
  return chordFromParts(input.key, input.code, {
    ctrlOrMeta: input.control || input.meta,
    alt: input.alt,
    shift: input.shift,
  });
}
