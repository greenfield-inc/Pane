/** A flag parser for `runpane cloud agent` and the gh shim: `--name value`, `--name=value`, short aliases, repeats. */

export interface FlagSpec {
  /** Flags that take a value, with their aliases (e.g. `['--body', '-b']`). */
  values: readonly (readonly string[])[];
  booleans: readonly (readonly string[])[];
}

export interface ParsedFlags {
  positionals: string[];
  /** Keyed by the canonical (first) name; repeated flags keep every value in order. */
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export class UnsupportedFlagError extends Error {
  override name = 'UnsupportedFlagError';

  constructor(readonly flag: string) {
    super(`unsupported flag ${flag}`);
  }
}

export function parseAgentFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags {
  const canonical = new Map<string, { name: string; takesValue: boolean }>();
  for (const names of spec.values) for (const name of names) canonical.set(name, { name: names[0], takesValue: true });
  for (const names of spec.booleans) for (const name of names) canonical.set(name, { name: names[0], takesValue: false });
  const parsed: ParsedFlags = { positionals: [], values: new Map(), booleans: new Set() };
  let onlyPositionals = false;
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index];
    if (onlyPositionals || raw === '-' || !raw.startsWith('-')) {
      parsed.positionals.push(raw);
      continue;
    }
    if (raw === '--') {
      onlyPositionals = true;
      continue;
    }
    const separator = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = separator === -1 ? raw : raw.slice(0, separator);
    const known = canonical.get(flag);
    if (!known) throw new UnsupportedFlagError(flag);
    if (!known.takesValue) {
      if (separator !== -1) throw new Error(`${flag} takes no value.`);
      parsed.booleans.add(known.name);
      continue;
    }
    const value = separator === -1 ? argv[++index] : raw.slice(separator + 1);
    if (value === undefined) throw new Error(`${flag} requires a value.`);
    parsed.values.set(known.name, [...(parsed.values.get(known.name) ?? []), value]);
  }
  return parsed;
}

export function lastValue(flags: ParsedFlags, name: string): string | undefined {
  const values = flags.values.get(name);
  return values?.[values.length - 1];
}

/** A PR or issue number: `12`, `#12` or a GitHub URL ending in `/12`. */
export function parseItemNumber(value: string | undefined, what: string): number {
  const match = value ? /^(?:#|.*\/(?:pull|issues)\/)?(\d+)\/?$/u.exec(value.trim()) : null;
  if (!match) throw new Error(`${what} needs a number (e.g. 12)${value ? `, not "${value}"` : ''}.`);
  return Number(match[1]);
}
