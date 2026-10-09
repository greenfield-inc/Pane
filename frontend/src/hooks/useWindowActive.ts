import { useEffect, useState } from 'react';

export interface WindowActivity {
  /** The window is on screen at all (not minimised, not a hidden tab). */
  visible: boolean;
  /** The window has focus, so the user is looking at this app right now. */
  focused: boolean;
}

/**
 * How much attention this window is getting.
 *
 * Two signals, because they mean different things and `document.visibilityState`
 * alone answers neither: a window sitting behind another application stays
 * "visible" (notably on macOS), so a visibility-only guard never fires for the
 * case that costs the most battery. `App.tsx` gates its animations on the same
 * pair.
 */
export function useWindowActive(): WindowActivity {
  const [activity, setActivity] = useState<WindowActivity>(() => ({
    visible: document.visibilityState === 'visible',
    focused: true,
  }));

  useEffect(() => {
    const update = (change: Partial<WindowActivity>) => setActivity(current => (
      (change.visible ?? current.visible) === current.visible
      && (change.focused ?? current.focused) === current.focused
        ? current
        : { ...current, ...change }
    ));

    const handleVisibility = () => update({ visible: document.visibilityState === 'visible' });
    document.addEventListener('visibilitychange', handleVisibility);

    // Pulled rather than awaited on an event: the first focus change may be a
    // long way off, and until then the initial answer is all there is.
    void window.electronAPI.window?.isFocused?.()
      .then(focused => update({ focused }))
      .catch(() => {
        // Default to focused when the query is unavailable.
      });

    const unsubscribe = window.electronAPI.events.onWindowFocusChanged(focused => update({ focused }));

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      unsubscribe();
    };
  }, []);

  return activity;
}
