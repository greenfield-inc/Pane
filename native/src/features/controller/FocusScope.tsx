import { use, useEffect, useId, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { ControllerActionId } from '@shared/controller/bindings';

import { useControllerState } from './controllerState';
import { FocusScopeKey } from './focusContext';
import { FocusRing } from './FocusRing';
import { controllerFocus } from './runtime';
import { useControllerActions } from './useControllerActions';

/** A question or approval ignores A this long after it opens, so the press that opened it can't answer it. */
export const ACTIVATE_GUARD_MS = 250;

/**
 * A sheet or screen that keeps the controller's focus to itself while open:
 * the stick and D-pad move only among its controls, focus lands on the
 * preferred one, B runs `onBack`, and it draws its own ring.
 */
export function FocusScope({ onBack, guardActivate = false, context = 'sheet', also, style, bare = false, children }: {
  onBack(): void;
  /** Adds no view: for a native sheet, whose root must stay its ScrollView; the sheet draws <ScopeRing /> itself. */
  bare?: boolean;
  guardActivate?: boolean;
  context?: 'sheet' | 'keypad';
  /** One more action that closes it, such as X for the key pad. */
  also?: ControllerActionId;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const key = useId();
  const [openedAt] = useState(Date.now);
  useEffect(() => {
    const close = controllerFocus.openScope({ key });
    // The controls registered first (child effects run before this one), so the initial focus can land now.
    if (useControllerState.getState().ringShown) controllerFocus.move('down');
    return close;
  }, [key]);
  useControllerActions(context, {
    'controller-back': () => onBack(),
    ...(also ? { [also]: () => onBack() } : {}),
    'controller-activate': () => guardActivate && Date.now() - openedAt < ACTIVATE_GUARD_MS,
  });
  if (bare) return <FocusScopeKey value={key}>{children}</FocusScopeKey>;
  return (
    <FocusScopeKey value={key}>
      <View style={style ?? styles.fill}>
        {children}
        <FocusRing scope={key} />
      </View>
    </FocusScopeKey>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

/** The ring of the focus scope around it; nothing outside one, where the app's own ring draws. */
export function ScopeRing() {
  const key = use(FocusScopeKey);
  return key ? <FocusRing scope={key} /> : null;
}
