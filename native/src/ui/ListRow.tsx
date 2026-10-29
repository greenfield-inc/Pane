import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type AccessibilityActionInfo, type AccessibilityActionEvent } from 'react-native';

import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Holds the subtitle at exactly this many lines, so swapping its text never resizes the row. */
  subtitleLines?: number;
  /** Leading slot, e.g. a status dot or icon, centered in a 24-wide box. */
  leading?: ReactNode;
  /** Current setting, shown muted before the trailing slot ("On", "studio-mac"). */
  value?: string;
  /** Trailing slot; `chevron` draws the platform disclosure indicator. */
  trailing?: ReactNode | 'chevron';
  onPress?: () => void;
  onLongPress?: () => void;
  destructive?: boolean;
  /** An action row such as "Add a machine": the title in the accent color. */
  accent?: boolean;
  /**
   * Extra screen reader actions. A control in `trailing` sits inside the row's focus target, so
   * VoiceOver and TalkBack reach it only through an action here.
   */
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  testID?: string;
}

/** One row of a grouped card (ListSection). */
export function ListRow({ title, subtitle, subtitleLines, leading, value, trailing, onPress, onLongPress, destructive, accent, accessibilityActions, onAccessibilityAction, testID }: ListRowProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      // A row without an action must not group its children, or it hides a
      // trailing control (a Switch) from VoiceOver and TalkBack.
      accessible={Boolean(onPress || onLongPress)}
      accessibilityRole={onPress ? 'button' : undefined}
      // Explicit, so icon symbol names don't leak into the merged label.
      accessibilityLabel={[title, value, subtitle].filter(Boolean).join(', ')}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      android_ripple={{ color: theme.colors.surfacePressed }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed && Platform.OS === 'ios' ? theme.colors.surfacePressed : theme.colors.card },
      ]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text variant="rowTitle" tone={destructive ? 'danger' : accent ? 'accent' : 'primary'} numberOfLines={1}>{title}</Text>
        {subtitle ? (
          <Text
            variant="rowDetail"
            tone="muted"
            numberOfLines={subtitleLines ?? 2}
            style={subtitleLines ? { minHeight: subtitleLines * theme.typography.rowDetail.lineHeight } : undefined}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? <Text variant="rowValue" tone="muted" numberOfLines={1} style={styles.value}>{value}</Text> : null}
      {trailing === 'chevron'
        ? <Icon ios="chevron.right" android="chevron_right" size={15} />
        : trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 9, gap: 14 },
  leading: { minWidth: 24, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 1 },
  value: { flexShrink: 1, maxWidth: '45%' },
});
