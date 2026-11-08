import { useEffect } from 'react';
import { useHotkey } from './useHotkey';
import { focusedSurfaceScroll, type ScrollDirection } from '../services/focusedSurfaceScroll';
import type { ScrollSurfaceId } from '../../../shared/constants/keyboardShortcuts';

function useScrollHotkey(
  id: ScrollSurfaceId,
  label: string,
  direction: ScrollDirection,
  page: boolean,
): void {
  useHotkey({
    id,
    label,
    category: 'view',
    action: () => {
      if (page) focusedSurfaceScroll.page(direction);
      else focusedSurfaceScroll.start(direction);
    },
    enabled: () => focusedSurfaceScroll.canScroll(),
    allowInModal: true,
    allowInXterm: true,
  });
}

export function useFocusedSurfaceScrolling(activeSessionId: string | null): void {
  useScrollHotkey('scroll-focused-surface-up', 'Scroll focused surface up', -1, false);
  useScrollHotkey('scroll-focused-surface-down', 'Scroll focused surface down', 1, false);
  useScrollHotkey('page-focused-surface-up', 'Page focused surface up', -1, true);
  useScrollHotkey('page-focused-surface-down', 'Page focused surface down', 1, true);

  useEffect(() => {
    focusedSurfaceScroll.setActiveSession(activeSessionId);
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => focusedSurfaceScroll.restoreActiveSessionFocus());
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [activeSessionId]);

  useEffect(() => {
    const noteInteraction = (event: Event) => {
      if (event.target instanceof Element) focusedSurfaceScroll.noteInteraction(event.target);
    };
    const stop = () => focusedSurfaceScroll.stop();
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift' || event.key === 'ArrowUp' || event.key === 'ArrowDown') stop();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) stop();
    };

    window.addEventListener('focusin', noteInteraction, true);
    window.addEventListener('pointerdown', noteInteraction, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focusin', noteInteraction, true);
      window.removeEventListener('pointerdown', noteInteraction, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stop();
    };
  }, []);
}
