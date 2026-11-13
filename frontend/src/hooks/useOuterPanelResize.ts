import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  clearOuterPanelPreference,
  readOuterPanelPreference,
  resolveOuterPanelRenderPolicy,
  resolveOuterPanelSize,
  writeOuterPanelPreference,
  type OuterPanelConfig,
} from '../utils/outerPanelSizing';

interface UseOuterPanelResizeOptions {
  config: OuterPanelConfig;
  containerPx: number;
  enabled: boolean;
}

interface PointerTransaction {
  pointerId: number;
  target: HTMLDivElement;
  startCoordinate: number;
  startEffective: number;
  oldPreferred: number | undefined;
  previousCursor: string;
  previousUserSelect: string;
  releaseFallback: (event: Event) => void;
}

const RELEASE_FALLBACK_EVENTS = ['pointerup', 'pointercancel', 'pointermove', 'blur'] as const;

export interface OuterResizeSeparatorHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}

// Only one outer-panel drag may own the document's cursor and selection state
// at a time, regardless of which separator (hook instance) started it.
let activeDragOwner: object | null = null;

export function useOuterPanelResize({ config, containerPx, enabled }: UseOuterPanelResizeOptions) {
  const [preferredPx, setPreferredPx] = useState<number | undefined>(() => (
    readOuterPanelPreference(config, window.localStorage)
  ));
  const [tentativePreferredPx, setTentativePreferredPx] = useState<number | undefined>();
  const transactionRef = useRef<PointerTransaction | null>(null);
  const ownerRef = useRef<object>({});
  const activeTentativePreferredPx = transactionRef.current ? tentativePreferredPx : undefined;
  const size = useMemo(
    () => resolveOuterPanelSize(config, containerPx, activeTentativePreferredPx ?? preferredPx),
    [activeTentativePreferredPx, config, containerPx, preferredPx],
  );
  const policy = useMemo(() => resolveOuterPanelRenderPolicy(config, size, enabled), [config, enabled, size]);
  // A start-edge (left) panel grows as the pointer moves toward the end, so its displacement flips.
  const growSign = config.edge === 'start' ? -1 : 1;

  const resetDocumentInteraction = useCallback((transaction: PointerTransaction) => {
    for (const type of RELEASE_FALLBACK_EVENTS) {
      window.removeEventListener(type, transaction.releaseFallback, true);
    }
    document.body.style.cursor = transaction.previousCursor;
    document.body.style.userSelect = transaction.previousUserSelect;
    try {
      if (transaction.target.hasPointerCapture(transaction.pointerId)) {
        transaction.target.releasePointerCapture(transaction.pointerId);
      }
    } catch {
      // The capture target may already be detached when interaction is disabled.
    }
  }, []);

  const resetTransaction = useCallback(() => {
    const transaction = transactionRef.current;
    if (!transaction) return false;
    transactionRef.current = null;
    if (activeDragOwner === ownerRef.current) activeDragOwner = null;
    resetDocumentInteraction(transaction);
    return true;
  }, [resetDocumentInteraction]);

  const rollback = useCallback(() => {
    if (resetTransaction()) setTentativePreferredPx(undefined);
  }, [resetTransaction]);

  const commitValue = useCallback((nextPreferred: number) => {
    const normalized = Math.max(1, Math.min(8192, Math.round(nextPreferred)));
    setPreferredPx(normalized);
    setTentativePreferredPx(undefined);
    writeOuterPanelPreference(config, window.localStorage, normalized);
  }, [config]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!policy.separatorVisible) return;
    // Only the primary button of the primary pointer expresses resize intent;
    // a right-click drift toward a context menu must not overwrite it.
    if (event.button !== 0 || !event.isPrimary) return;
    // One transaction owns all separators: a second pointer cannot restart
    // this one from its preview, nor start a concurrent drag elsewhere.
    if (transactionRef.current || activeDragOwner !== null) return;
    // A new transaction always starts from remembered intent: clear any
    // abandoned preview left behind when a separator disappeared mid-drag.
    setTentativePreferredPx(undefined);
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const coordinate = config.axis === 'width' ? event.clientX : event.clientY;
    // If the separator is removed from the DOM mid-drag while this hook stays
    // enabled, the browser delivers neither lostpointercapture nor
    // pointercancel to React and implicit capture is gone, so a release
    // outside the window may never produce an event at all. Once the target
    // is disconnected, the next event from this pointer — or window blur —
    // ends the transaction so the shared owner cannot outlive the gesture.
    const pointerId = event.pointerId;
    const releaseFallback = (fallbackEvent: Event) => {
      const transaction = transactionRef.current;
      if (!transaction || transaction.pointerId !== pointerId || transaction.target.isConnected) return;
      if (fallbackEvent instanceof PointerEvent && fallbackEvent.pointerId !== pointerId) return;
      rollback();
    };
    for (const type of RELEASE_FALLBACK_EVENTS) {
      window.addEventListener(type, releaseFallback, true);
    }
    activeDragOwner = ownerRef.current;
    transactionRef.current = {
      pointerId,
      target: event.currentTarget,
      releaseFallback,
      startCoordinate: coordinate,
      startEffective: size.effectivePx,
      oldPreferred: preferredPx,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = config.axis === 'width' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [config.axis, policy.separatorVisible, preferredPx, rollback, size.effectivePx]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const transaction = transactionRef.current;
    if (!transaction || transaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    const coordinate = config.axis === 'width' ? event.clientX : event.clientY;
    setTentativePreferredPx(transaction.startEffective + growSign * (transaction.startCoordinate - coordinate));
  }, [config.axis, growSign]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const transaction = transactionRef.current;
    if (!transaction || transaction.pointerId !== event.pointerId) return;
    const coordinate = config.axis === 'width' ? event.clientX : event.clientY;
    const displacement = growSign * (transaction.startCoordinate - coordinate);
    const candidate = resolveOuterPanelSize(
      config,
      containerPx,
      transaction.startEffective + displacement,
    ).effectivePx;
    const previous = resolveOuterPanelSize(config, containerPx, transaction.oldPreferred).effectivePx;
    transactionRef.current = null;
    if (activeDragOwner === ownerRef.current) activeDragOwner = null;
    resetDocumentInteraction(transaction);
    if (displacement !== 0 && candidate > 0 && candidate !== previous) {
      commitValue(candidate);
    } else {
      setTentativePreferredPx(undefined);
    }
  }, [commitValue, config, containerPx, growSign, resetDocumentInteraction]);

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (transactionRef.current?.pointerId !== event.pointerId) return;
    rollback();
  }, [rollback]);

  const onLostPointerCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (transactionRef.current?.pointerId === event.pointerId) rollback();
  }, [rollback]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!policy.separatorVisible) return;
    // Ctrl/Meta/Alt arrow chords are OS navigation shortcuts, not resize intent.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 50 : 10;
    let next: number | undefined;
    if (config.axis === 'width' && event.key === 'ArrowLeft') next = size.effectivePx + growSign * step;
    if (config.axis === 'width' && event.key === 'ArrowRight') next = size.effectivePx - growSign * step;
    if (config.axis === 'height' && event.key === 'ArrowUp') next = size.effectivePx + step;
    if (config.axis === 'height' && event.key === 'ArrowDown') next = size.effectivePx - step;
    if (event.key === 'Home') next = size.floor;
    if (event.key === 'End') next = size.cap;
    if (next === undefined) return;
    event.preventDefault();
    const resolved = resolveOuterPanelSize(config, containerPx, next).effectivePx;
    if (resolved !== size.effectivePx && resolved > 0) commitValue(resolved);
  }, [commitValue, config, containerPx, growSign, policy.separatorVisible, size]);

  // Double-click forgets the remembered size: the panel goes back to its default.
  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!policy.separatorVisible) return;
    event.preventDefault();
    rollback();
    setTentativePreferredPx(undefined);
    setPreferredPx(undefined);
    clearOuterPanelPreference(config, window.localStorage);
  }, [config, policy.separatorVisible, rollback]);

  useEffect(() => {
    if (!policy.separatorVisible) resetTransaction();
  }, [policy.separatorVisible, resetTransaction]);

  useEffect(() => () => {
    resetTransaction();
  }, [resetTransaction]);

  return {
    preferredPx,
    effectivePx: size.effectivePx,
    floor: size.floor,
    cap: size.cap,
    renderedPx: policy.renderedPx,
    bodyActive: policy.bodyActive,
    separatorVisible: policy.separatorVisible,
    separatorHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onKeyDown,
      onDoubleClick,
    } satisfies OuterResizeSeparatorHandlers,
  };
}
