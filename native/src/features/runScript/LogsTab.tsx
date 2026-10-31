import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { LogsPanelState, ToolPanel } from '@shared/types/panels';

import { useDaemon, useDaemonEvent, useDaemonQueryKey, useInvokeQuery } from '@/daemon';
import { monoFontFamily, useTheme, withAlpha } from '@/theme';
import { ErrorState, Icon, Text } from '@/ui';

import { TabFooter } from '../tabs/TabFooter';
import { appendLog, decodeLogEntry, type LogLine, logText } from './logs';

/** How close to the end, in points, still counts as at the end. */
const AT_END_SLOP = 24;

/**
 * A Run script tab, read-only: the Pane's script output, live. It follows the end until you
 * scroll up, and again once you scroll back down or tap Latest.
 */
export function LogsTab({ panel }: { panel: ToolPanel }) {
  const theme = useTheme();
  const { colors, terminal } = theme;
  const { profile } = useDaemon();
  const queryClient = useQueryClient();
  const state = panel.state.customState as LogsPanelState | undefined;
  const key = useDaemonQueryKey('sessions:get-logs', [panel.sessionId]);
  const logs = useInvokeQuery<LogLine[]>('sessions:get-logs', [panel.sessionId]);
  useDaemonEvent('session-log', event => {
    const payload = event.args[0] as { sessionId?: string; entry?: unknown } | undefined;
    const entry = payload?.sessionId === panel.sessionId ? decodeLogEntry(payload.entry) : null;
    if (entry) queryClient.setQueryData<LogLine[]>(key, current => appendLog(current ?? [], entry));
  });
  useDaemonEvent('session-logs-cleared', event => {
    const payload = event.args[0] as { sessionId?: string } | undefined;
    if (payload?.sessionId === panel.sessionId) queryClient.setQueryData<LogLine[]>(key, []);
  });
  const list = useRef<LegendListRef>(null);
  const [following, setFollowing] = useState(true);

  let body;
  if (logs.isPending) body = <View style={styles.center}><ActivityIndicator color={colors.textMuted} /></View>;
  else if (logs.isError) body = <ErrorState title="Couldn’t read the script’s output" error={logs.error} onRetry={() => void logs.refetch()} testID="logs-error" />;
  else if (logs.data.length === 0) body = <View style={styles.center}><Text variant="subhead" style={{ color: terminal.brightBlack }}>No output yet.</Text></View>;
  else {
    body = (
      <>
        <LegendList
          ref={list}
          testID="logs-list"
          data={logs.data}
          keyExtractor={(_line, index) => String(index)}
          estimatedItemSize={20}
          recycleItems
          // New output keeps the end in view while following; only the person's own scrolling pauses it.
          onContentSizeChange={() => { if (following) void list.current?.scrollToEnd({ animated: false }); }}
          onScrollEndDrag={event => setFollowing(atEnd(event.nativeEvent))}
          onMomentumScrollEnd={event => setFollowing(atEnd(event.nativeEvent))}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <Text selectable style={[styles.line, { color: item.level === 'error' ? terminal.red : item.level === 'warn' ? terminal.yellow : terminal.foreground }]}>
              {logText(item)}
            </Text>
          )}
        />
        {!following ? (
          <Pressable
            testID="logs-latest"
            accessibilityRole="button"
            accessibilityLabel="Scroll to the latest output"
            onPress={() => {
              setFollowing(true);
              void list.current?.scrollToEnd({ animated: true });
            }}
            style={[styles.latest, { borderRadius: theme.radius.md, backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Icon ios="arrow.down" android="arrow_downward" size={14} color={colors.textSecondary} />
            <Text variant="callout" tone="secondary">Latest</Text>
          </Pressable>
        ) : null}
      </>
    );
  }

  return (
    <View testID="logs-tab" style={[styles.fill, { backgroundColor: terminal.background }]}>
      <View style={[styles.header, { borderBottomColor: withAlpha(terminal.foreground, 0.1) }]}>
        {state?.command ? (
          <View style={[styles.chip, styles.command, { borderRadius: theme.radius.sm, backgroundColor: withAlpha(terminal.foreground, 0.08) }]}>
            <Text numberOfLines={1} style={[styles.mono, { color: terminal.foreground }]}>{state.command}</Text>
          </View>
        ) : null}
        <View style={[styles.chip, styles.status, { borderRadius: theme.radius.pill, backgroundColor: withAlpha(state?.isRunning ? terminal.green : terminal.brightBlack, 0.16) }]}>
          <Text variant="callout" style={[styles.semibold, { color: state?.isRunning ? terminal.green : terminal.brightBlack }]}>
            {state?.isRunning ? 'Running' : state?.exitCode !== undefined ? `Exited ${state.exitCode}` : 'Stopped'}
          </Text>
        </View>
        <Text variant="subhead" style={[styles.follow, { color: terminal.brightBlack }]}>{following ? 'Follows the end' : 'Paused'}</Text>
      </View>
      <View style={styles.fill}>{body}</View>
      <TabFooter left="Read-only on the phone" right={`Start and stop on ${profile.label}`} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  semibold: { fontWeight: '600' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  chip: { paddingHorizontal: 8, paddingVertical: 3 },
  command: { flexShrink: 1 },
  status: { flexShrink: 0 },
  follow: { marginLeft: 'auto', flexShrink: 0 },
  mono: { fontFamily: monoFontFamily, fontSize: 14 },
  content: { paddingHorizontal: 12, paddingVertical: 10 },
  line: { fontFamily: monoFontFamily, fontSize: 13, lineHeight: 19 },
  latest: { position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 36, borderWidth: 1 },
});

function atEnd({ contentOffset, contentSize, layoutMeasurement }: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } }): boolean {
  return contentOffset.y + layoutMeasurement.height >= contentSize.height - AT_END_SLOP;
}
