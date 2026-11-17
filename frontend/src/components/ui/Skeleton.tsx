import React, { useLayoutEffect, useState } from 'react';
import { cn } from '../../utils/cn';

/** A load that finishes sooner shows no skeleton at all. */
export const SKELETON_DELAY_MS = 150;
/** A skeleton that appeared stays at least this long, so it never blinks. */
export const SKELETON_MIN_VISIBLE_MS = 300;
/** The bone breathe period (`pane-skeleton-breathe` in index.css). */
const SKELETON_PERIOD_MS = 2000;
/** How long content that replaces a skeleton carries `skeleton-reveal` (index.css fades it 120 ms). */
export const REVEAL_MS = 200;
/** A skeleton that replaces another within this gap continues its timing. */
const CHAIN_GAP_MS = 100;

/** The chain a skeleton belongs to when its caller names none. */
const APP_CHAIN = 'app';

/**
 * One clock per loading chain. Opening a Session or Pane swaps one skeleton for
 * the next (its record, its layout, its terminal); skeletons of one chain, named
 * by the Pane or Session id, share a clock, so the delay never restarts. A
 * skeleton elsewhere on screen never shortens another chain's delay.
 */
const clocks = new Map<string, { start: number; mounted: number; lastEnd: number }>();

function clockOf(chain: string) {
  let clock = clocks.get(chain);
  if (!clock) {
    clock = { start: 0, mounted: 0, lastEnd: Number.NEGATIVE_INFINITY };
    clocks.set(chain, clock);
  }
  return clock;
}

function chainStart(chain: string, now: number): number {
  const clock = clockOf(chain);
  return clock.mounted > 0 || now - clock.lastEnd <= CHAIN_GAP_MS ? clock.start : now;
}

/** When a skeleton of this chain starting now becomes visible (ms, performance clock). */
function visibleAt(chain: string, now: number): number {
  return chainStart(chain, now) + SKELETON_DELAY_MS;
}

/**
 * A loading placeholder in the exact shape of what replaces it. Its surface
 * (background, borders) paints at once; its bones (`Bone`, `TextBone`) appear
 * after SKELETON_DELAY_MS and breathe in one shared phase (index.css). Bones
 * only: no text, no spinner.
 */
export function Skeleton({ className, style, children, testId, chain = APP_CHAIN }: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  testId?: string;
  /** The Pane or Session this skeleton opens, so the steps of one opening share a clock. */
  chain?: string;
}) {
  const [shownAt] = useState(() => visibleAt(chain, performance.now()));
  const [visible, setVisible] = useState(() => performance.now() >= shownAt);

  useLayoutEffect(() => {
    const clock = clockOf(chain);
    const now = performance.now();
    if (clock.mounted === 0 && now - clock.lastEnd > CHAIN_GAP_MS) clock.start = shownAt - SKELETON_DELAY_MS;
    clock.mounted += 1;
    return () => {
      clock.mounted -= 1;
      clock.lastEnd = performance.now();
    };
  }, [chain, shownAt]);

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
 * released at once. `reveal` is true for REVEAL_MS after a visible skeleton
 * is replaced: give the content `skeleton-reveal` then, for a cross-fade.
 */
export function useSkeletonHold(loading: boolean, chain = APP_CHAIN): { holding: boolean; reveal: boolean } {
  const [state, setState] = useState<{ since: number | null; held: boolean; reveal: boolean }>(
    () => ({ since: loading ? visibleAt(chain, performance.now()) : null, held: false, reveal: false }),
  );

  useLayoutEffect(() => {
    const now = performance.now();
    if (loading) {
      setState(current => (current.since !== null && !current.held ? current : { since: visibleAt(chain, now), held: false, reveal: false }));
      return;
    }
    setState(current => {
      if (current.since === null) return current.reveal ? { ...current, reveal: false } : current;
      if (now < current.since) return { since: null, held: false, reveal: false };
      return { ...current, held: true };
    });
  }, [loading, chain]);

  useLayoutEffect(() => {
    if (loading || !state.held || state.since === null) return;
    const remaining = state.since + SKELETON_MIN_VISIBLE_MS - performance.now();
    const release = () => setState({ since: null, held: false, reveal: true });
    if (remaining <= 0) { release(); return; }
    const timer = setTimeout(release, remaining);
    return () => clearTimeout(timer);
  }, [loading, state.held, state.since]);

  // The fade runs once: a class left on would fade again when a background window refocuses.
  useLayoutEffect(() => {
    if (!state.reveal) return;
    const timer = setTimeout(() => setState(current => (current.reveal ? { ...current, reveal: false } : current)), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [state.reveal]);

  return { holding: loading || state.held, reveal: state.reveal };
}

/** What a skeleton stands for, said to screen readers only: skeletons show no text. */
export function LoadingStatus({ label }: { label: string }) {
  return <span role="status" aria-label={label} className="sr-only">{label}</span>;
}
