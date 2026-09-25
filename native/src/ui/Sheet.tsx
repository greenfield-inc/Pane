import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

import { Text } from './Text';

export interface SheetProps {
  title?: string;
  children: ReactNode;
  /** Pinned below the content, e.g. the confirm button. */
  footer?: ReactNode;
  testID?: string;
}

/**
 * Body of a native sheet. Present it by declaring the route with
 * `presentation: 'formSheet'` (see src/app/_layout.tsx); this component only
 * lays out the content so every sheet looks the same.
 */
export function Sheet({ title, children, footer, testID }: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View testID={testID} style={[styles.container, { backgroundColor: theme.colors.surface }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {title ? <Text variant="title">{title}</Text> : null}
        {children}
      </ScrollView>
      {footer ? <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, gap: 16 },
  footer: { paddingHorizontal: 20, paddingTop: 8, gap: 8 },
});
