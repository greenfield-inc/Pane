import { useEffect, useState } from 'react';

import { connectionMark, connectionMarkIfFresh, markNextFrame, onJourneyStart, perfMark, startJourney, type Journey } from './perfMarks';

/** Re-renders when a journey starts, so marks for a state the screen is already in still log. */
function useJourneyStarts(): number {
  const [starts, setStarts] = useState(0);
  useEffect(() => onJourneyStart(() => setStarts(count => count + 1)), []);
  return starts;
}

/**
 * Marks `<screen>-live` when the screen is at full strength with input enabled, and
 * `<screen>-fresh` once it is live and its data was read after the journey began.
 * `updatedAt` is the oldest `dataUpdatedAt` among the reads the screen shows.
 */
export function useLiveMarks(screen: string, live: boolean, updatedAt?: number): void {
  const starts = useJourneyStarts();
  useEffect(() => {
    if (!live) return;
    connectionMark(`${screen}-live`);
    if (updatedAt) connectionMarkIfFresh(`${screen}-fresh`, updatedAt);
  }, [screen, live, updatedAt, starts]);
}

/** Marks `<name>=<value>` each time the value changes, such as Home's counts. */
export function useValueMark(name: string, value: string): void {
  useEffect(() => connectionMark(`${name}=${value}`, { changes: true }), [name, value]);
}

/**
 * Starts `journey` when the screen mounts, and again when `key` changes (the next approval),
 * and marks its first frame. Call it before the screen's other marks.
 */
export function useScreenJourney(journey: Journey, key?: string): void {
  useEffect(() => {
    startJourney(journey);
    markNextFrame([journey]);
  }, [journey, key]);
}

/** Marks `mark` on `journey` once `when` holds; with `changes`, each time a `name=value` mark's value changes. */
export function useJourneyMark(journey: Journey, mark: string, when = true, changes = false): void {
  useEffect(() => {
    if (when) perfMark(journey, mark, { changes });
  }, [journey, mark, when, changes]);
}
