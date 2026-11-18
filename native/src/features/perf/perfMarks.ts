/**
 * Timing marks for the journeys the phone is measured on, in a perf build only: a bundle built
 * with `EXPO_PUBLIC_PANE_PERF=1`. Each mark is one log line, `[perf] <journey> <mark> <ms>`,
 * where ms counts from the journey's start; the simulator's `log stream` and a phone's Console
 * log carry them. Every other build, OTA updates included, logs nothing and does no work here.
 * `native/scripts/perf-table.mts` turns a log into the target table.
 *
 * A journey starts again each time it begins (each return, each screen open). A mark logs
 * once per journey run, except reads (logged each time) and values such as counts (logged when they change).
 */

export type Journey = 'launch' | 'return' | 'switch' | 'session' | 'terminal' | 'chat' | 'approval';

/** A perf build: Expo inlines the variable when it bundles, so other builds drop the marks. */
export const PERF_BUILD = process.env.EXPO_PUBLIC_PANE_PERF === '1';

/** `[perf] app stall <ms>`: the JavaScript thread was busy this long (perf builds only). */
export function logStall(gapMs: number): void {
  console.info(`[perf] app stall ${Math.round(gapMs)}`);
}

/** The journeys that cover a reconnect: network reads are marked against whichever is running. */
const CONNECTION_JOURNEYS: readonly Journey[] = ['return', 'switch', 'launch'];

/** Marks after this long belong to no journey: the moment has passed. */
const JOURNEY_WINDOW_MS = 30_000;

interface Run {
  startedAt: number;
  /** Wall clock at the start, to compare with React Query's `dataUpdatedAt`. */
  startedWall: number;
  marked: Set<string>;
  /** The last value logged for each `name=value` mark, so a value only logs when it changes. */
  values: Map<string, string>;
}

const runs = new Map<Journey, Run>();
const startListeners = new Set<(journey: Journey) => void>();
const now = () => performance.now();

export function startJourney(journey: Journey): void {
  if (!PERF_BUILD) return;
  runs.set(journey, { startedAt: now(), startedWall: Date.now(), marked: new Set(), values: new Map() });
  log(journey, 'start', 0);
  for (const listener of startListeners) listener(journey);
}

/** Calls `listener` whenever a journey starts, so a screen can mark a state it is already in. */
export function onJourneyStart(listener: (journey: Journey) => void): () => void {
  startListeners.add(listener);
  return () => startListeners.delete(listener);
}

/**
 * Logs `mark` against `journey` when it is running. `repeat` logs every time (each read sent);
 * `changes` logs a `name=value` mark only when its value differs from the last one logged
 * (counts, connection status); otherwise only the first mark of that name in the run.
 */
export function perfMark(journey: Journey, mark: string, options: MarkOptions = {}): void {
  const run = runs.get(journey);
  if (!run) return;
  const elapsed = now() - run.startedAt;
  if (elapsed > JOURNEY_WINDOW_MS) return;
  if (options.changes) {
    const [name, value = ''] = mark.split('=');
    if (run.values.get(name) === value) return;
    run.values.set(name, value);
  } else if (!options.repeat) {
    if (run.marked.has(mark)) return;
    run.marked.add(mark);
  }
  log(journey, mark, elapsed);
}

export interface MarkOptions {
  repeat?: boolean;
  changes?: boolean;
}

/** Marks every connection journey still inside its window (a return, a switch, a launch). */
export function connectionMark(mark: string, options: MarkOptions = {}): void {
  for (const journey of CONNECTION_JOURNEYS) perfMark(journey, mark, options);
}

/** Marks each connection journey whose start came before `updatedAt`: data read since it began. */
export function connectionMarkIfFresh(mark: string, updatedAt: number): void {
  for (const journey of CONNECTION_JOURNEYS) {
    const run = runs.get(journey);
    if (run && updatedAt >= run.startedWall) perfMark(journey, mark);
  }
}

/** Marks the first frame painted after now, for every journey given. */
export function markNextFrame(journeys: readonly Journey[], mark = 'first-frame'): void {
  if (!PERF_BUILD) return;
  requestAnimationFrame(() => {
    for (const journey of journeys) perfMark(journey, mark);
  });
}

function log(journey: Journey, mark: string, ms: number): void {
  console.info(`[perf] ${journey} ${mark.replace(/\s+/g, '_')} ${Math.round(ms)}`);
}
