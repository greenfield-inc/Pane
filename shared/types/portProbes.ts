import { PaneError } from '../paneError';

/**
 * The Ports list sends `HEAD /` to each listening port to tell web servers from other TCP
 * listeners. A listener that accepts exactly one connection (an OAuth callback, a strict socket
 * test) ends on that probe, so probes can be turned off, or kept off a list of ports.
 */
export const DEFAULT_PORT_PROBES_ENABLED = true;

/** A port, or an inclusive range of them, that is never probed. */
export interface PortRange {
  from: number;
  to: number;
}

const MAX_PORT = 65_535;

/** Thrown for a list Settings cannot read; `message` names the entry that failed. */
export const ERR_PORT_PROBE_EXCLUSIONS_INVALID = 'ERR_PORT_PROBE_EXCLUSIONS_INVALID';

function invalid(entry: string, why: string): PaneError {
  return new PaneError(
    ERR_PORT_PROBE_EXCLUSIONS_INVALID,
    `"${entry}" is not a port or port range: ${why}. The excluded ports were not changed.`,
    'Enter ports from 1 to 65535 and ranges like 9000-9100, separated by commas, for example "5173, 9000-9100".',
  );
}

function parsePort(text: string, entry: string): number {
  if (!/^\d+$/u.test(text)) throw invalid(entry, `${text === '' ? 'a number is missing' : `"${text}" is not a whole number`}`);
  const port = Number(text);
  if (port < 1 || port > MAX_PORT) throw invalid(entry, `${port} is outside 1 to 65535`);
  return port;
}

/**
 * Reads a list like `5173, 9000-9100` into sorted ranges, merging any that overlap or touch.
 * Commas, semicolons and whitespace separate entries; an empty list excludes nothing.
 * Throws a PaneError naming the first entry that is not a port or an ascending range.
 */
export function parsePortRanges(text: string): PortRange[] {
  const ranges: PortRange[] = [];
  for (const raw of text.split(/[,;\s]+/u)) {
    const entry = raw.trim();
    if (entry === '') continue;
    const dash = entry.indexOf('-');
    if (dash === -1) {
      const port = parsePort(entry, entry);
      ranges.push({ from: port, to: port });
      continue;
    }
    const from = parsePort(entry.slice(0, dash), entry);
    const to = parsePort(entry.slice(dash + 1), entry);
    if (to < from) throw invalid(entry, `the range ends before it starts; write ${to}-${from}`);
    ranges.push({ from, to });
  }
  ranges.sort((a, b) => a.from - b.from);
  const merged: PortRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/** The error message for a list Settings refuses, or null when it parses. */
export function portRangesError(text: string): string | null {
  try {
    parsePortRanges(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function isPortInRanges(port: number, ranges: readonly PortRange[]): boolean {
  return ranges.some(range => port >= range.from && port <= range.to);
}

/** What the Ports list may probe, read at each read of the socket table. */
export interface PortProbeSettings {
  /** False: list listeners and their ports only, connecting to none. */
  enabled: boolean;
  excluded: readonly PortRange[];
}

/**
 * The probe settings config.json holds. A list that does not parse (a hand edit) turns every
 * probe off, since whoever wrote it meant some port to stay untouched; `error` says why.
 */
export function portProbeSettingsOf(config: { portProbesEnabled?: boolean; portProbeExcludedPorts?: string }): PortProbeSettings & { error?: string } {
  const enabled = config.portProbesEnabled ?? DEFAULT_PORT_PROBES_ENABLED;
  try {
    return { enabled, excluded: parsePortRanges(config.portProbeExcludedPorts ?? '') };
  } catch (error) {
    return { enabled: false, excluded: [], error: error instanceof Error ? error.message : String(error) };
  }
}
