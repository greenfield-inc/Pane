import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useJourneyMark, useScreenJourney } from '@/features/perf/usePerfMarks';
import { useTheme } from '@/theme';
import { ErrorState, SkeletonSwap } from '@/ui';

import { TerminalScreen } from '../terminal/TerminalScreen';
import { ChatRowsSkeleton } from '../chatTab/ChatTabRows';
import { PanelTabsSkeleton } from '../terminal/TerminalSkeletons';
import { TerminalTopBar } from '../terminal/TerminalTopBar';
import { useSessionView } from './hooks';

/** Opens a Session: its workspace pane with the agent chat as the first tab. */
export function SessionScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const theme = useTheme();
  useScreenJourney('session', sessionId);
  const view = useSessionView(sessionId);
  useJourneyMark('session', 'data', view.data !== undefined);

  return (
    <SkeletonSwap
      loading={view.data === undefined && !view.isError}
      skeleton={(
        <View testID="session-skeleton" style={[styles.fill, { backgroundColor: theme.colors.surface }]}>
          <TerminalTopBar paneName="" />
          <PanelTabsSkeleton />
          {/* A Session opens on its agent chat. */}
          <View testID="session-chat-skeleton" accessible accessibilityLabel="Loading the Session" style={[styles.fill, styles.rows, { backgroundColor: theme.chat.background }]}>
            <ChatRowsSkeleton />
          </View>
        </View>
      )}
      style={styles.fill}
    >
      {view.data ? <TerminalScreen paneId={view.data.internalSession.id} session={view.data} /> : (
        <View testID="session-error-screen" style={[styles.fill, { backgroundColor: theme.colors.surface }]}>
          <TerminalTopBar paneName="" />
          <View style={[styles.fill, { backgroundColor: theme.terminal.background }]}>
            <ErrorState title="Couldn’t open the Session" error={view.error} onRetry={() => void view.refetch()} />
          </View>
        </View>
      )}
    </SkeletonSwap>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The chat's rows: their inset and the 4 pt padding above and below each.
  rows: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
});
