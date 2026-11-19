import { useEffect, useRef } from 'react';

import { connectionMark, connectionMarkIfFresh, markNextFrame, onJourneyStart, perfMark, startJourney, type Journey } from './perfMarks';

/**
 * Marks `<screen>-live` when the screen is at full strength with input enabled, and
 * `<screen>-fresh` once it is live and its data was read after the journey began.
 * `updatedAt` is the oldest `dataUpdatedAt` among the reads the screen shows. A journey that
 * starts while the screen is already live marks it at once, without rendering the screen again.
 */
export function useLiveMarks(screen: string, live: boolean, updatedAt?: number): void {
  const state = useRef({ live, updatedAt });
  useEffect(() => {
    const mark = () => {
      if (!state.current.live) return;
      connectionMark(`${screen}-live`);
      if (state.current.updatedAt) connectionMarkIfFresh(`${screen}-fresh`, state.current.updatedAt);
    };
    state.current = { live, updatedAt };
    mark();
    return onJourneyStart(mark);
  }, [screen, live, updatedAt]);
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

/**
 * Marks `mark` on `journey` once `when` holds, and again each time that journey starts while
 * it holds; with `changes`, each time a `name=value` mark's value changes.
 */
export function useJourneyMark(journey: Journey, mark: string, when = true, changes = false): void {
  useEffect(() => {
    if (!when) return;
    perfMark(journey, mark, { changes });
    return onJourneyStart(started => { if (started === journey) perfMark(journey, mark, { changes }); });
  }, [journey, mark, when, changes]);
}
