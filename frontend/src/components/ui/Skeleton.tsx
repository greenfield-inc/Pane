import React, { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../utils/cn';

/** A load that finishes sooner shows no skeleton at all. */
const SKELETON_DELAY_MS = 150;
/** A skeleton that appeared stays at least this long, so it never blinks. */
const SKELETON_MIN_VISIBLE_MS = 300;
/** The bone breathe period (`pane-skeleton-breathe` in index.css). */
const SKELETON_PERIOD_MS = 2000;
/** How long a reveal lasts: content carries `skeleton-reveal`, or a skeleton over painted content `skeleton-fade-out` (index.css fades either 120 ms). */
export const REVEAL_MS = 200;
/** A skeleton that replaces another within this gap continues its timing. */
const CHAIN_GAP_MS = 100;

/**
 * Skeleton timing. Each skeleton has its own clock unless its caller names a
 * chain (the Pane or Session being opened): skeletons of one chain share a
 * clock, so opening something that swaps one skeleton for the next (record,
 * layout, terminal) never restarts the delay, and a skeleton elsewhere on
 * screen never shortens it. A skeleton that replaces one that just ended
 * continues its clock unless both name different chains: leaving a Session
 * whose skeleton was still up is not a step of opening the next one.
 */
interface Clock { start: number; mounted: number; lastEnd: number }
const clocks = new Map<string, Clock>();
let lastEnded = { start: 0, end: Number.NEGATIVE_INFINITY, named: false };

function clockOf(chain: string): Clock {
  let clock = clocks.get(chain);
  if (!clock) {
    clock = { start: 0, mounted: 0, lastEnd: Number.NEGATIVE_INFINITY };
    clocks.set(chain, clock);
  }
  return clock;
}

function chainStart(chain: string, named: boolean, now: number): number {
  const clock = clocks.get(chain);
  if (clock && (clock.mounted > 0 || now - clock.lastEnd <= CHAIN_GAP_MS)) return clock.start;
  const handoff = now - lastEnded.end <= CHAIN_GAP_MS && !(named && lastEnded.named);
  return handoff ? lastEnded.start : now;
}

/** When a skeleton of this chain starting now becomes visible (ms, performance clock). */
function visibleAt(chain: string, named: boolean, now: number): number {
  return chainStart(chain, named, now) + SKELETON_DELAY_MS;
}

/** The chain a `SkeletonSwap` gives the skeletons inside it, and whether its caller named it. */
const SkeletonChain = createContext<{ chain: string; named: boolean } | null>(null);

/** Inside, skeletons draw their surfaces but never their bones. */
const SkeletonQuiet = createContext(false);

/**
 * For content this window has shown before (a revisited Session or Pane): it
 * is cached content, so its stand-in shows no bones while it mounts again.
 */
export function QuietSkeletons({ quiet, children }: { quiet: boolean; children: React.ReactNode }) {
  return <SkeletonQuiet.Provider value={quiet}>{children}</SkeletonQuiet.Provider>;
}

/**
 * A loading placeholder in the exact shape of what replaces it. Its surface
 * (background, borders) paints at once; its bones (`Bone`, `TextBone`) appear
 * after SKELETON_DELAY_MS and breathe in one shared phase (index.css). Bones
 * only: no text, no spinner. Swap it for content with `SkeletonSwap`, which
 * holds it its minimum and cross-fades.
 */
export function Skeleton({ className, style, children, testId, chain }: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  testId?: string;
  /** The Pane or Session this skeleton opens, so the steps of one opening share a clock. */
  chain?: string;
}) {
  const own = useId();
  const swapChain = useContext(SkeletonChain);
  const quiet = useContext(SkeletonQuiet);
  const key = chain ?? swapChain?.chain ?? own;
  const named = chain !== undefined || Boolean(swapChain?.named);
  const [shownAt, setShownAt] = useState(() => visibleAt(key, named, performance.now()));
  const [visible, setVisible] = useState(() => performance.now() >= shownAt);

  // Registered after this commit's unmounts, so a skeleton replacing one that
  // just ended sees it and continues its clock.
  useLayoutEffect(() => {
    const now = performance.now();
    const start = chainStart(key, named, now);
    const clock = clockOf(key);
    if (clock.mounted === 0) clock.start = start;
    clock.mounted += 1;
    setShownAt(start + SKELETON_DELAY_MS);
    setVisible(now >= start + SKELETON_DELAY_MS);
    return () => {
      clock.mounted -= 1;
      clock.lastEnd = performance.now();
      lastEnded = { start: clock.start, end: clock.lastEnd, named };
    };
  }, [key, named]);

  useLayoutEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setVisible(true), Math.max(0, shownAt - performance.now()));
    return () => clearTimeout(timer);
  }, [visible, shownAt]);

  // Every skeleton breathes in one phase: the breathe starts when the bones appear.
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (visible) surface.current?.style.setProperty('--skeleton-phase', `-${Math.round(performance.now() % SKELETON_PERIOD_MS)}ms`);
  }, [visible]);

  return (
    <div ref={surface} aria-hidden="true" data-skeleton={visible && !quiet ? 'visible' : 'waiting'} data-testid={testId}
      className={cn('pointer-events-none select-none overflow-hidden', className)} style={style}>
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
 * Whether to show a loader's skeleton. A load that ends before its skeleton
 * appears is released at once; one that showed its skeleton holds it
 * SKELETON_MIN_VISIBLE_MS from when it appeared.
 */
export interface SkeletonHold {
  /** Show the skeleton: still loading, or held to its minimum. */
  holding: boolean;
  /** For REVEAL_MS after a shown skeleton is replaced: cross-fade the content in. */
  reveal: boolean;
  /** This load showed its skeleton; stays true until the next load starts. */
  seen: boolean;
}

interface HoldState { since: number | null; reveal: boolean; seen: boolean }

export function useSkeletonHold(loading: boolean, chain?: string): SkeletonHold {
  const own = useId();
  const key = chain ?? own;
  const named = chain !== undefined;
  const [state, setState] = useState<HoldState>({ since: null, reveal: false, seen: false });

  // A load starts timing after its skeleton registered (children's layout effects run first).
  useLayoutEffect(() => {
    if (loading) setState(current => (current.since !== null ? current : { since: visibleAt(key, named, performance.now()), reveal: false, seen: false }));
  }, [loading, key, named]);

  // What the last render decided. Content it already committed is never held again: on a slow frame
  // this effect can run after `since` although the render before it was earlier, and holding then
  // would unmount the content and mount it again (losing its state).
  const committedContent = useRef(false);
  useLayoutEffect(() => {
    if (loading || state.since === null) return;
    const since = state.since;
    const now = performance.now();
    if (now < since || committedContent.current) { setState({ since: null, reveal: false, seen: false }); return; }
    const release = () => setState({ since: null, reveal: true, seen: true });
    const remaining = since + SKELETON_MIN_VISIBLE_MS - now;
    if (remaining <= 0) { release(); return; }
    const timer = setTimeout(release, remaining);
    return () => clearTimeout(timer);
  }, [loading, state.since]);

  // The fade runs once: a class left on would fade again when a background window refocuses.
  useLayoutEffect(() => {
    if (!state.reveal) return;
    const timer = setTimeout(() => setState(current => (current.reveal ? { ...current, reveal: false } : current)), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [state.reveal]);

  // Decided while rendering, so content that is about to be held never commits.
  const shown = state.since !== null && performance.now() >= state.since;
  const holding = loading || shown;
  committedContent.current = !holding;
  return { holding, reveal: state.reveal, seen: state.seen };
}

/**
 * The one way to swap a skeleton for what it stands in for: the skeleton's
 * bones wait SKELETON_DELAY_MS, a shown skeleton stays SKELETON_MIN_VISIBLE_MS,
 * and the content then fades in over the same place. The content's wrapper is
 * `display: contents`, so the layout is the caller's.
 */
export function SkeletonSwap({ loading, skeleton, children, chain }: {
  loading: boolean;
  skeleton: React.ReactNode;
  children: React.ReactNode;
  /** The Pane or Session being opened, when this load is one step of opening it. */
  chain?: string;
}) {
  const own = useId();
  const key = chain ?? own;
  const { holding, reveal } = useSkeletonHold(loading, key);
  const context = useMemo(() => ({ chain: key, named: chain !== undefined }), [key, chain]);
  return (
    <SkeletonChain.Provider value={context}>
      {holding ? skeleton : <div className="contents" data-skeleton-reveal={reveal ? '' : undefined}>{children}</div>}
    </SkeletonChain.Provider>
  );
}

/** What a skeleton stands for, said to screen readers only: skeletons show no text. */
export function LoadingStatus({ label }: { label: string }) {
  return <span role="status" aria-label={label} className="sr-only">{label}</span>;
}
