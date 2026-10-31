import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

/** A tab's full-screen state: an icon in a circle, what happened, what to do, and its buttons. */
export function StateScreen({ icon, title, message, actions, testID }: {
  icon: { ios: SFSymbol; android: AndroidSymbol };
  title: string;
  message: string;
  actions?: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <View testID={testID} style={styles.container}>
      <View style={[styles.glyph, { backgroundColor: colors.surfaceRaised }]}>
        <Icon ios={icon.ios} android={icon.android} size={26} color={colors.textSecondary} />
      </View>
      <Text variant="title" style={styles.center} accessibilityRole="header">{title}</Text>
      {message ? <Text variant="subhead" tone="secondary" style={styles.center}>{message}</Text> : null}
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10 },
  glyph: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  center: { textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
});
