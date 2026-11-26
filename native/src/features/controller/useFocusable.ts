import { use, useContext, useEffect, useEffectEvent, useId, useRef, useSyncExternalStore } from 'react';
import { Dimensions, type View } from 'react-native';

import type { ControllerContext } from '@shared/controller/bindings';

import { ScreenFocus } from '@/daemon/screenFocus';

import { useControllerState } from './controllerState';
import { ColumnActive, FocusListContext, FocusScopeKey } from './focusContext';
import { controllerFocus } from './runtime';

/** Preferred controls mounting within this window belong to the same screen. */
const CLAIM_MS = 100;
let lastClaim = 0;

interface Options {
  /** What A does here; usually the control's own onPress. */
  onActivate(): void;
  /** Focus lands here when its screen or sheet opens. */
  preferred?: boolean;
  /** The context while focused ('terminal' sends the D-pad to the agent). */
  context?: ControllerContext;
  enabled?: boolean;
}

/**
 * Lets a control take the controller's focus ring. Put the returned ref on
 * its outer view. The ring measures it when focus moves, so it follows lists
 * and layout changes without any work while no controller is in use.
 */
export function useFocusable({ onActivate, preferred, context, enabled: wanted = true }: Options) {
  // Controls on a screen out of view (Home under a Pane, a Pane under an approval) can't take focus.
  const enabled = wanted && use(ScreenFocus) && use(ColumnActive);
  const id = useId();
  const ref = useRef<View>(null);
  const scope = useContext(FocusScopeKey);
  const list = useContext(FocusListContext);
  const activate = useEffectEvent(onActivate);
  useEffect(() => {
    if (!enabled) return;
    const remove = controllerFocus.add({
      id,
      scope,
      preferred,
      context,
      activate: () => activate(),
      // A control off the window (below a half-height sheet, past a list's mounted rows) can't take focus or A.
      measure: () => {
        const box = ref.current?.getBoundingClientRect?.();
        if (!box) return null;
        const window = Dimensions.get('window');
        const middle = box.y + box.height / 2;
        return middle < 0 || middle > window.height ? null : { x: box.x, y: box.y, width: box.width, height: box.height };
      },
      reveal: list?.reveal,
      onEdge: list?.onEdge,
    });
    // A screen or sheet opening while the controller is in use lands on its preferred control:
    // the first one to mount in a commit wins, so a list of recommended options starts at the top.
    if (preferred && useControllerState.getState().ringShown && Date.now() - lastClaim > CLAIM_MS) {
      lastClaim = Date.now();
      controllerFocus.focus(id);
    }
    return remove;
  }, [id, scope, preferred, context, list, enabled]);
  const focused = useSyncExternalStore(controllerFocus.subscribe, () => controllerFocus.focused()?.id === id);
  return { ref, focused };
}
