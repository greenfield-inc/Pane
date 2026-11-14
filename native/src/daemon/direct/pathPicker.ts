/**
 * Probe-and-pick between the relay and a direct path to one computer. The current path changes
 * only when the other is clearly faster for several probes in a row, or when the current one
 * stops answering while the other answers.
 */
export type PathName = 'relay' | 'direct';

/** One probe of each path: the round trip in ms, or null when it failed or wasn't tried. */
export interface PathSample {
  relayMs: number | null;
  directMs: number | null;
}

export interface PathPick {
  path: PathName;
  /** Probes in a row in which the other path was clearly faster. */
  streak: number;
}

export const FIRST_PICK: PathPick = { path: 'relay', streak: 0 };

/** Probes in a row the other path must win before the pick changes. */
const PROBES_TO_SWITCH = 3;
/** "Clearly faster": at most this share of the current path's time, and this many ms quicker. */
const FASTER_RATIO = 0.75;
const FASTER_MS = 10;

function other(path: PathName): PathName {
  return path === 'relay' ? 'direct' : 'relay';
}

function timeOf(sample: PathSample, path: PathName): number | null {
  return path === 'relay' ? sample.relayMs : sample.directMs;
}

export function pickPath(pick: PathPick, sample: PathSample): PathPick {
  const current = timeOf(sample, pick.path);
  const alternative = timeOf(sample, other(pick.path));
  if (alternative === null) return { ...pick, streak: 0 };
  if (current === null) return { path: other(pick.path), streak: 0 };
  const clearlyFaster = alternative <= current * FASTER_RATIO && current - alternative >= FASTER_MS;
  if (!clearlyFaster) return { ...pick, streak: 0 };
  const streak = pick.streak + 1;
  return streak >= PROBES_TO_SWITCH ? { path: other(pick.path), streak: 0 } : { ...pick, streak };
}

/** A path went down between probes (the direct connection dropped, or a request on it failed). */
export function pathFailed(pick: PathPick, path: PathName): PathPick {
  return pick.path === path ? { path: other(path), streak: 0 } : { ...pick, streak: 0 };
}
