import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import type { ControllerContext } from '@shared/controller/bindings';

import { useFocusable } from './useFocusable';

/**
 * Wraps a control so the controller's focus ring can land on it; A runs
 * `onActivate` (pass the control's own onPress). Touch is untouched.
 */
export function Focusable({ onActivate, preferred, context, enabled, style, children }: {
  onActivate(): void;
  preferred?: boolean;
  context?: ControllerContext;
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const { ref } = useFocusable({ onActivate, preferred, context, enabled });
  return <View ref={ref} collapsable={false} style={style}>{children}</View>;
}
