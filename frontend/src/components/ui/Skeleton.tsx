import React, { useLayoutEffect, useState } from 'react';
import { cn } from '../../utils/cn';

/** A load that finishes sooner shows no skeleton at all. */
export const SKELETON_DELAY_MS = 150;
/** A skeleton that appeared stays at least this long, so it never blinks. */
export const SKELETON_MIN_VISIBLE_MS = 300;
/** The bone breathe period (`pane-skeleton-breathe` in index.css). */
const SKELETON_PERIOD_MS = 2000;
/** A skeleton that replaces another within this gap continues its timing. */
const CHAIN_GAP_MS = 100;

/**
 * One clock for every skeleton on screen. A loading chain (a Session's record,
 * then its layout, then its terminal) swaps one skeleton for the next; they
 * share the clock, so the delay never restarts and the breathe never jumps.
 */
const clock = { start: 0, mounted: 0, lastEnd: Number.NEGATIVE_INFINITY };

function chainStart(now: number): number {
  return clock.mounted > 0 || now - clock.lastEnd <= CHAIN_GAP_MS ? clock.start : now;
}

/** When a skeleton starting now becomes visible (ms, performance clock). */
function visibleAt(now: number): number {
  return chainStart(now) + SKELETON_DELAY_MS;
}

/**
 * A loading placeholder in the exact shape of what replaces it. Its surface
 * (background, borders) paints at once; its bones (`Bone`, `TextBone`) appear
 * after SKELETON_DELAY_MS and breathe in one shared phase (index.css). Bones
 * only: no text, no spinner.
 */
export function Skeleton({ className, style, children, testId }: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  testId?: string;
}) {
  const [shownAt] = useState(() => visibleAt(performance.now()));
  const [visible, setVisible] = useState(() => performance.now() >= shownAt);

  useLayoutEffect(() => {
    const now = performance.now();
    if (clock.mounted === 0 && now - clock.lastEnd > CHAIN_GAP_MS) clock.start = shownAt - SKELETON_DELAY_MS;
    clock.mounted += 1;
    return () => {
      clock.mounted -= 1;
      clock.lastEnd = performance.now();
    };
  }, [shownAt]);

  useLayoutEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setVisible(true), Math.max(0, shownAt - performance.now()));
    return () => clearTimeout(timer);
  }, [visible, shownAt]);

  // Every skeleton breathes in one phase, whenever it mounted.
  const [phase] = useState(() => `-${Math.round(performance.now() % SKELETON_PERIOD_MS)}ms`);

  return (
    <div aria-hidden="true" data-skeleton={visible ? 'visible' : 'waiting'} data-testid={testId}
      className={cn('pointer-events-none select-none overflow-hidden', className)}
      style={{ ...style, ['--skeleton-phase' as string]: phase }}>
      {children}
    </div>
  );
}

/** One block of a skeleton. Size it like the element it stands in for. */
export function Bone({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('skeleton-bone rounded bg-surface-tertiary', className)} style={style} />;
}

/**
 * A bone exactly as wide and tall as a known piece of text in the same type
 * style (a tab title, a label), with the text itself invisible.
 */
export function TextBone({ text, className }: { text: string; className?: string }) {
  return <span className={cn('skeleton-bone inline-block rounded bg-surface-tertiary text-transparent whitespace-pre', className)}>{text}</span>;
}

/**
 * Holds `loading` on so a skeleton that became visible stays at least
 * SKELETON_MIN_VISIBLE_MS. A load that ends before the skeleton appears is
 * released at once. `reveal` is true for the render that replaces a visible
 * skeleton, for a cross-fade.
 */
export function useSkeletonHold(loading: boolean): { holding: boolean; reveal: boolean } {
  const [state, setState] = useState<{ since: number | null; held: boolean; reveal: boolean }>(
    () => ({ since: loading ? visibleAt(performance.now()) : null, held: false, reveal: false }),
  );

  useLayoutEffect(() => {
    const now = performance.now();
    if (loading) {
      setState(current => (current.since !== null && !current.held ? current : { since: visibleAt(now), held: false, reveal: false }));
      return;
    }
    setState(current => {
      if (current.since === null) return current.reveal ? { ...current, reveal: false } : current;
      if (now < current.since) return { since: null, held: false, reveal: false };
      return { ...current, held: true };
    });
  }, [loading]);

  useLayoutEffect(() => {
    if (loading || !state.held || state.since === null) return;
    const remaining = state.since + SKELETON_MIN_VISIBLE_MS - performance.now();
    const release = () => setState({ since: null, held: false, reveal: true });
    if (remaining <= 0) { release(); return; }
    const timer = setTimeout(release, remaining);
    return () => clearTimeout(timer);
  }, [loading, state.held, state.since]);

  return { holding: loading || state.held, reveal: state.reveal };
}

/** What a skeleton stands for, said to screen readers only: skeletons show no text. */
export function LoadingStatus({ label }: { label: string }) {
  return <span role="status" aria-label={label} className="sr-only">{label}</span>;
}
