import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Sheet, Text } from '@/ui';
import type { IconProps } from '@/ui/Icon';

import { useApprovalSort } from './approvalSortPreference';
import { APPROVAL_SORTS, type ApprovalSort } from './approvals';
import { Focusable } from '@/features/controller/Focusable';

const ICONS: Record<ApprovalSort, Pick<IconProps, 'ios' | 'android'>> = {
  recent: { ios: 'clock', android: 'schedule' },
  session: { ios: 'bubble.left', android: 'chat_bubble' },
  project: { ios: 'folder', android: 'folder' },
};

/** Home's sort sheet: the three ways Needs you lists, each saying what it does. Picking one closes it. */
export function SortApprovalsSheet() {
  const theme = useTheme();
  const sort = useApprovalSort(state => state.sort);
  const setSort = useApprovalSort(state => state.setSort);
  return (
    <Sheet title="Sort approvals" testID="sort-approvals-sheet">
      <View style={[styles.card, { borderRadius: theme.radius.card, backgroundColor: theme.colors.surfaceRaised }]} accessibilityRole="radiogroup">
        {APPROVAL_SORTS.map((option, index) => {
          const on = option.id === sort;
          const pick = () => {
            setSort(option.id);
            router.back();
          };
          return (
            <Focusable key={option.id} preferred={on} onActivate={pick}>
            <Pressable
              testID={`sort-approvals-${option.id}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${option.label}, ${option.description}`}
              onPress={pick}
              style={({ pressed }) => [styles.option, pressed && { backgroundColor: theme.colors.surfacePressed }]}
            >
              {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.colors.border }]} /> : null}
              <View style={[styles.icon, { backgroundColor: theme.colors.surfacePressed }]}>
                <Icon ios={ICONS[option.id].ios} android={ICONS[option.id].android} size={17} color={theme.colors.text} />
              </View>
              <View style={styles.text}>
                <Text variant="rowValue">{option.label}</Text>
                <Text variant="rowDetail" tone="muted">{option.description}</Text>
              </View>
              {/* The check keeps its box when hidden, so the text never shifts. */}
              <View style={styles.check}>
                {on ? <Icon ios="checkmark" android="check" size={17} color={theme.colors.accentText} /> : null}
              </View>
            </Pressable>
            </Focusable>
          );
        })}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden' },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 62, paddingHorizontal: 14, paddingVertical: 8 },
  divider: { position: 'absolute', top: 0, left: 60, right: 0, height: StyleSheet.hairlineWidth },
  icon: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0, gap: 1 },
  check: { width: 20, alignItems: 'center' },
});
