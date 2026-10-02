import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { ErrorState } from '@/ui';

import { TerminalScreen } from '../terminal/TerminalScreen';
import { TerminalTopBar } from '../terminal/TerminalTopBar';
import { useSessionView } from './hooks';

/** Opens a Session: its workspace pane with the agent chat as the first tab. */
export function SessionScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const theme = useTheme();
  const view = useSessionView(sessionId);

  if (view.data) return <TerminalScreen paneId={view.data.internalSession.id} session={view.data} />;
  return (
    <View testID="session-loading-screen" style={[styles.fill, { backgroundColor: theme.colors.surface }]}>
      <TerminalTopBar paneName="" />
      <View style={[styles.fill, styles.center, { backgroundColor: theme.terminal.background }]}>
        {view.isError
          ? <ErrorState title="Couldn’t open the Session" error={view.error} onRetry={() => void view.refetch()} />
          : <ActivityIndicator color={theme.colors.textMuted} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
