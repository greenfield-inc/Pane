import type { ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

import { Text } from './Text';

export interface SheetProps {
  title?: string;
  children: ReactNode;
  /** Sits at the bottom of the sheet, e.g. the confirm button. */
  footer?: ReactNode;
  testID?: string;
}

/**
 * Body of a native sheet. Present it by declaring the route with
 * `presentation: 'formSheet'` (see src/app/_layout.tsx); this component only
 * lays out the content so every sheet looks the same. The ScrollView must be
 * the sheet's root view: react-native-screens collapses one nested in a View.
 * On iOS the footer sits at the bottom of the current detent. Android lays
 * the sheet out at full height and shows only the detent's part of it, so
 * there the footer follows the content to stay on screen.
 */
export function Sheet({ title, children, footer, testID }: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: theme.colors.surface }}
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 20) }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      {title ? <Text variant="title">{title}</Text> : null}
      {children}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: 20, paddingTop: 28, gap: 16 },
  footer: { marginTop: Platform.OS === 'ios' ? 'auto' : 8, gap: 8 },
});
