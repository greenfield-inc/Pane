import type { ToolPanel, ToolPanelType } from '@shared/types/panels';
import { StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { MachineMark } from '../machines/MachineMark';
import { useMachines } from '../machines/useMachines';
import { TAB_TYPES } from '../terminal/PanelTabs';

/** What each tab the phone doesn't draw holds, said where the person looks for it. */
const ABOUT: Partial<Record<ToolPanelType, { title: string; message: string }>> = {
  notes: { title: 'Notes', message: 'Notes are written and drawn on the computer.' },
  dashboard: { title: 'Dashboard', message: 'The dashboard’s charts and lists show on the computer.' },
  'setup-tasks': { title: 'Setup tasks', message: 'Setup tasks run once, on the computer.' },
  diff: { title: 'Diff', message: 'This branch’s changes show on the computer for now.' },
  logs: { title: 'Script output', message: 'The Run script’s output shows on the computer for now.' },
  editor: { title: 'Diff', message: 'This file’s changes show on the computer for now.' },
};

/** A tab whose content stays on the computer: what it is, and where it opens. */
export function PlaceholderTab({ panel }: { panel: ToolPanel }) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const current = useMachines().find(machine => machine.current);
  const about = ABOUT[panel.type] ?? { title: panel.title, message: 'This tab shows on the computer.' };
  const type = TAB_TYPES[panel.type];
  return (
    <View testID="tab-placeholder" style={[styles.fill, { backgroundColor: colors.background }]}>
      <View style={[styles.card, { borderRadius: theme.radius.hero, backgroundColor: colors.surfaceRaised }]}>
        <View style={[styles.glyph, { borderRadius: theme.radius.lg, backgroundColor: colors.background }]}>
          <Icon ios={type.ios} android={type.android} size={26} color={colors.textSecondary} />
        </View>
        <Text variant="headline" style={styles.center}>{about.title}</Text>
        <Text variant="subhead" tone="secondary" style={styles.center}>{about.message}</Text>
        <View style={[styles.pill, { borderRadius: theme.radius.pill, backgroundColor: colors.background }]}>
          <View style={styles.mark}>{current ? <MachineMark os={current.os} slot={current.slot} state={current.state} /> : null}</View>
          <Text variant="subhead" tone="secondary" numberOfLines={1}>Opens on {profile.label}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'center', padding: 20 },
  card: { alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 24 },
  glyph: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  center: { textAlign: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 6, marginTop: 4, maxWidth: '100%' },
  mark: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
});
