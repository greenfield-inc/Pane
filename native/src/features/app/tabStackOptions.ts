import { Platform } from 'react-native';

/**
 * Screen options for the stacks inside each tab. iOS gets the large,
 * translucent title that lists scroll under (they inset themselves with
 * contentInsetAdjustmentBehavior). Android has no such inset, so a
 * transparent header there would cover the first rows.
 */
export const tabStackOptions = {
  fullScreenGestureEnabled: true,
  ...(Platform.OS === 'ios' ? { headerLargeTitle: true, headerTransparent: true } : {}),
};
