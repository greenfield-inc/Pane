import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Leading slot, e.g. a status dot or icon. */
  leading?: ReactNode;
  /** Trailing slot; `chevron` draws the platform disclosure indicator. */
  trailing?: ReactNode | 'chevron';
  onPress?: () => void;
  onLongPress?: () => void;
  destructive?: boolean;
  testID?: string;
}

export function ListRow({ title, subtitle, leading, trailing, onPress, onLongPress, destructive, testID }: ListRowProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      android_ripple={{ color: theme.colors.surfacePressed }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed && Platform.OS === 'ios' ? theme.colors.surfacePressed : theme.colors.surface },
      ]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text variant="body" tone={destructive ? 'danger' : 'primary'} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text variant="footnote" tone="muted" numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {trailing === 'chevron'
        ? <Icon ios="chevron.right" android="chevron_right" size={14} />
        : trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  leading: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
});
