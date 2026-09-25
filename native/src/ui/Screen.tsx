import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

export interface ScreenProps {
  children: ReactNode;
  /** Scrollable content that sits under a native (large-title) header. */
  scroll?: boolean;
  /** Safe-area edges to pad. Screens under a native header only need the bottom. */
  edges?: Edge[];
  padded?: boolean;
  style?: ViewStyle;
  testID?: string;
}

/**
 * Screen background and safe areas. Long data lists should render a
 * Legend List directly instead of passing `scroll`.
 */
export function Screen({ children, scroll, edges = ['bottom'], padded = true, style, testID }: ScreenProps) {
  const theme = useTheme();
  const padding = padded ? theme.spacing.lg : 0;

  if (scroll) {
    return (
      <ScrollView
        testID={testID}
        style={{ backgroundColor: theme.colors.background }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[{ padding, gap: theme.spacing.lg }, style]}
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <SafeAreaView testID={testID} edges={edges} style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.fill, { padding }, style]}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
