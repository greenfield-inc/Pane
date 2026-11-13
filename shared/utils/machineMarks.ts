/**
 * Machine letter marks: the one or two letters a machine shows on its colour.
 * Like the colour, the automatic letters come from the names alone; a person can
 * override either on one computer (`AppConfig.machineMarks`, D-252).
 */
import { MACHINE_COLOR_NAMES } from './machineColor';

export type MachineColorName = (typeof MACHINE_COLOR_NAMES)[number];

/** A mark chosen on this computer. Each part is optional; a missing part stays automatic. */
export interface MachineMarkOverride {
  /** One or two letters or digits. */
  letters?: string;
  /** A machine palette colour, by name. */
  color?: MachineColorName;
}

/** Saved marks keyed by `machineMarkKey`. */
export type MachineMarkOverrides = Record<string, MachineMarkOverride>;

export interface ResolvedMachineMark {
  letters: string;
  slot: number;
  /** A saved override changed the letters or the colour. */
  custom: boolean;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MAX_LETTERS = 2;

/** The letters and digits of a name, upper-cased, with the index of each word's first one. */
interface NameCharacters {
  chars: string[];
  wordStarts: number[];
}

function characters(name: string): NameCharacters {
  const chars: string[] = [];
  const wordStarts: number[] = [];
  let inWord = false;
  for (const char of name.trim()) {
    if (LETTER_OR_DIGIT.test(char)) {
      if (!inWord) wordStarts.push(chars.length);
      inWord = true;
      chars.push(char.toUpperCase());
    } else {
      inWord = false;
    }
  }
  return { chars, wordStarts };
}

/** Second-letter candidates: the next words' first letters, then the rest of the name in order. */
function secondLetterCandidates(name: string): string[] {
  const { chars, wordStarts } = characters(name);
  const order = [...wordStarts.slice(1), ...chars.keys()].filter((index) => index > 0);
  return [...new Set(order.map((index) => chars[index]))];
}

function compareNames(a: string, b: string): number {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Gives each machine name its letters. A first letter no other name shares stands alone;
 * names that share one each get a second letter, so they stay distinct. Shared groups are
 * settled in sorted order, so the result never depends on the order names arrive in.
 */
export function assignMachineLetters(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set(names)].sort(compareNames);
  const groups = new Map<string, string[]>();
  for (const name of unique) {
    const first = characters(name).chars[0] ?? '?';
    groups.set(first, [...(groups.get(first) ?? []), name]);
  }
  const letters = new Map<string, string>();
  for (const [first, group] of groups) {
    if (group.length === 1 || first === '?') {
      for (const name of group) letters.set(name, first);
      continue;
    }
    const taken = new Set<string>();
    for (const name of group) {
      let mark = secondLetterCandidates(name).map((second) => first + second).find((candidate) => !taken.has(candidate));
      // A name that runs out of letters takes a number instead.
      for (let n = 2; !mark; n++) if (!taken.has(`${first}${n}`)) mark = `${first}${n}`;
      taken.add(mark);
      letters.set(name, mark);
    }
  }
  return letters;
}

/** A machine's letter on its own, for one that is not in the machine list. */
export function machineLetter(name: string): string {
  return assignMachineLetters([name]).get(name) ?? '?';
}

/** The letter field's value as a mark: its first one or two letters or digits, upper-cased. */
export function normalizeMarkLetters(input: string): string {
  return [...input].filter((char) => LETTER_OR_DIGIT.test(char)).slice(0, MAX_LETTERS).join('').toUpperCase();
}

/**
 * Where a machine's override is saved: `local` for this computer (its name changes once
 * Tailscale answers), otherwise its name, which stays the same once a Tailscale machine
 * is saved as a profile.
 */
export function machineMarkKey(machine: { id: string; name: string }): string {
  return machine.id === 'local' ? 'local' : machine.name;
}

/** A machine's mark: the automatic letters and colour, with any usable saved part on top. */
export function resolveMachineMark(auto: { letters: string; slot: number }, override: MachineMarkOverride | undefined): ResolvedMachineMark {
  const letters = override?.letters ? normalizeMarkLetters(override.letters) : '';
  const slot = override?.color ? MACHINE_COLOR_NAMES.indexOf(override.color) : -1;
  return {
    letters: letters || auto.letters,
    slot: slot >= 0 ? slot : auto.slot,
    custom: letters !== '' || slot >= 0,
  };
}
