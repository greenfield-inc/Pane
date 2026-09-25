import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import type { AgentDisplayStatus } from '@shared/types/agentStatus';

import { useTheme, type ThemeColors } from '@/theme';
import { Icon } from '@/ui';

interface Presentation {
  label: string;
  color: keyof ThemeColors;
  ios?: SFSymbol;
  android?: AndroidSymbol;
}

export const statusPresentation: Record<AgentDisplayStatus, Presentation> = {
  blocked: { label: 'Needs input', color: 'warning', ios: 'exclamationmark.circle.fill', android: 'error' },
  working: { label: 'Working', color: 'accentText' },
  done: { label: 'Ready', color: 'success', ios: 'checkmark.circle.fill', android: 'check_circle' },
  idle: { label: 'Idle', color: 'neutral', ios: 'circle', android: 'radio_button_unchecked' },
  unknown: { label: 'No agent', color: 'textMuted', ios: 'terminal', android: 'terminal' },
};

/** Fixed 22 pt footprint so rows don't shift when the status changes. */
export function StatusBadge({ status }: { status: AgentDisplayStatus }) {
  const theme = useTheme();
  const { label, color, ios, android } = statusPresentation[status];
  return (
    <View style={styles.badge} testID={`status-${status}`} accessibilityLabel={label}>
      {status === 'working' || !ios || !android
        ? <ActivityIndicator size="small" color={theme.colors[color]} />
        : <Icon ios={ios} android={android} size={20} color={theme.colors[color]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
});
