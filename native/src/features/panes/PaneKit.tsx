import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';
import { Icon, Skeleton, Text } from '@/ui';

/**
 * The PWA's drawer and dialog pieces (frontend/src/remote/components) that the
 * pane screens share: section labels, icon buttons, notices and sheet chrome.
 */

/** `rounded-md p-2` icon button; `size` is its square footprint. */
export function IconButton({ label, onPress, testID, disabled, size = 32, children }: {
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
  size?: number;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={Math.max(0, (44 - size) / 2)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        { width: size, height: size, borderRadius: theme.radius.md, opacity: disabled ? 0.5 : 1 },
        pressed && { backgroundColor: theme.colors.surfacePressed },
      ]}
    >
      {children}
    </Pressable>
  );
}

/** The drawer's uppercase `text-xs font-semibold` section label, with an optional icon and "+" button. */
export function SectionHeader({ title, first, icon, add }: {
  title: string;
  /** The first section sits flush with the top of the list. */
  first?: boolean;
  icon?: ReactNode;
  add?: { label: string; testID: string; onPress: () => void };
}) {
  return (
    <View style={[styles.section, !first && styles.sectionGap]}>
      {icon}
      <Text variant="caption" tone="muted" numberOfLines={1} style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {add ? (
        <IconButton label={add.label} testID={add.testID} size={22} onPress={add.onPress}>
          <Icon ios="plus" android="add" size={14} />
        </IconButton>
      ) : null}
    </View>
  );
}

/** The drawer's `rounded-md border bg-surface-secondary p-4 text-sm` message box. */
export function Notice({ message, danger, action, testID }: {
  message: string;
  danger?: boolean;
  action?: { title: string; onPress: () => void };
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessibilityLiveRegion={danger ? 'polite' : undefined}
      style={[styles.notice, {
        borderRadius: theme.radius.md,
        borderColor: danger ? theme.colors.danger : theme.colors.border,
        backgroundColor: theme.colors.surfaceRaised,
      }]}
    >
      <Text variant="subhead" style={{ color: danger ? theme.colors.danger : theme.colors.textSecondary }}>{message}</Text>
      {action ? (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={action.onPress}>
          <Text variant="callout" tone="accent">{action.title}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Placeholder rows in the drawer rows' footprint while the list loads. */
export function LoadingRows() {
  return (
    <View accessibilityLabel="Loading panes">
      {[0.55, 0.4, 0.5].map(width => (
        <View key={width} style={styles.loadingRow}>
          <Skeleton width={8} height={8} radius={4} />
          <Skeleton width={`${width * 100}%`} height={14} />
        </View>
      ))}
    </View>
  );
}

/** The dialogs' `rounded-md px-4 py-2 text-sm font-semibold` buttons. */
export function SheetButton({ title, onPress, variant = 'plain', loading, disabled, testID, style }: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'plain' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const inactive = disabled || loading;
  const color = variant === 'primary' ? theme.colors.onAccent : variant === 'danger' ? theme.colors.danger : theme.colors.textSecondary;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.sheetButton,
        {
          borderRadius: theme.radius.md,
          backgroundColor: variant === 'primary' ? theme.colors.accent : pressed ? theme.colors.surfacePressed : 'transparent',
          borderColor: variant === 'danger' ? theme.colors.border : 'transparent',
          opacity: inactive ? 0.6 : pressed && variant === 'primary' ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={color} /> : null}
      <Text variant="callout" style={[styles.bold, { color }]}>{title}</Text>
    </Pressable>
  );
}

/**
 * A PWA dialog as a native sheet: title bar with a close X, body, and a
 * bordered footer. The ScrollView must be the sheet's root view (see
 * src/ui/Sheet.tsx); on Android the footer follows the content to stay on screen.
 */
export function DialogSheet({ title, onClose, closeDisabled, footer, children, testID }: {
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  footer: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const divider = { borderColor: theme.colors.border };
  return (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: theme.colors.surface }}
      contentContainerStyle={styles.sheet}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={[styles.sheetHeader, divider]}>
        <Text variant="headline" accessibilityRole="header" numberOfLines={1} style={styles.sheetTitle}>{title}</Text>
        <IconButton label="Close" testID={testID ? `${testID}-close` : undefined} disabled={closeDisabled} onPress={onClose}>
          <Icon ios="xmark" android="close" size={16} />
        </IconButton>
      </View>
      {children}
      <View style={[styles.sheetFooter, divider, { paddingBottom: Math.max(insets.bottom, 20) }]}>{footer}</View>
    </ScrollView>
  );
}

/** A `p-5` dialog section; `divided` draws the border under it. */
export function DialogSection({ children, divided = true }: { children: ReactNode; divided?: boolean }) {
  const theme = useTheme();
  return <View style={[styles.dialogSection, divided && { borderBottomWidth: 1, borderColor: theme.colors.border }]}>{children}</View>;
}

const styles = StyleSheet.create({
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  // mb-1 px-2 gap-2; sections sit mb-4 apart.
  section: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, minHeight: 22, marginBottom: 4 },
  sectionGap: { marginTop: 12 },
  sectionTitle: { flex: 1, letterSpacing: 0.3 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, marginBottom: 4 },
  notice: { borderWidth: 1, padding: 16, gap: 8 },
  sheetButton: { minHeight: 40, paddingHorizontal: 16, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  bold: { fontWeight: '600' },
  sheet: { flexGrow: 1 },
  // px-5 py-4 border-b; title text-lg font-semibold.
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1 },
  sheetTitle: { flex: 1, fontSize: 18, lineHeight: 28 },
  sheetFooter: {
    flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12,
    padding: 20, borderTopWidth: 1, marginTop: Platform.OS === 'ios' ? 'auto' : 0,
  },
  dialogSection: { padding: 20, gap: 8 },
});
