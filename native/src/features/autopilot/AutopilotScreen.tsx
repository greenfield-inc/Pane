import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { decisionModel } from '@shared/autopilotDecision';
import { AWAY_BLOCK, controlLine, ITEMS_BLOCK, LOG_BLOCK, parseItemIds, queuedControlLabel } from '@shared/autopilotTranscript';
import type { AutopilotSnapshot } from '@shared/types/autopilot';
import type { NotifyItem } from '@shared/types/notify';

import { useDaemon } from '@/daemon';
import { ChatTabScreen } from '@/features/chatTab/ChatTabScreen';
import { ConnectionBar } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { MachineBadge } from '@/features/machines/MachineBadge';
import { useMachines } from '@/features/machines/useMachines';
import { useNotifyShared } from '@/features/notify/hooks';
import { useTheme, withAlpha } from '@/theme';
import { Button, ErrorState, Icon, Text } from '@/ui';

import { composerPlaceholder, startBlocked, walkBar } from './autopilot';
import { DecisionCard, useDecisionAnswer } from './DecisionCard';
import { useAutopilot, useAutopilotControl, useAutopilotOpened, useAutopilotSentinel } from './hooks';
import { SentinelAwayCard, SentinelLogRows } from './SentinelBlocks';

/** Opens an item's approval full screen above the chat. */
function openAutopilotItem(notifyId: string) {
  router.push({ pathname: '/autopilot/item/[notifyId]', params: { notifyId } });
}

/**
 * Autopilot on the phone (D-75, D-76): its chat tab, with the walk bar above it and Start before
 * Start (opening it never starts a turn). Items it names in an `autopilot-items` block show as
 * decision cards you answer in place; their footer opens the approval full screen. No tabs.
 */
export function AutopilotScreen() {
  const theme = useTheme();
  const { colors } = theme;
  const autopilot = useAutopilot();
  const notify = useNotifyShared();
  const { profile } = useDaemon();
  const snapshot = autopilot.data;
  useAutopilotOpened();

  let body: ReactNode;
  if (autopilot.unsupported) {
    body = <Message testID="autopilot-update" title="Update Pane on the computer" text={`${profile.label}’s Pane is older than Autopilot. Update it, then open Autopilot again.`} />;
  } else if (autopilot.isError) {
    body = <ErrorState title="Couldn’t read Autopilot" error={autopilot.error} onRetry={() => void autopilot.refetch()} />;
  } else if (!snapshot) {
    body = <View style={[styles.fill, styles.center]}><ActivityIndicator /></View>;
  } else if (!snapshot.enabled) {
    body = <Message testID="autopilot-off" title="Autopilot is off" text={`Turn it on on ${profile.label} in Settings › Advanced › Experimental › Autopilot.`} />;
  } else if (snapshot.state === 'stopped' || !snapshot.panelId) {
    body = <StartPanel snapshot={snapshot} />;
  } else {
    const items = notify.data?.items ?? [];
    body = (
      <ChatTabScreen
        key={snapshot.panelId}
        panelId={snapshot.panelId}
        placeholder={composerPlaceholder(snapshot, items, decisionModel)}
        blocks={{
          [ITEMS_BLOCK]: content => <ItemCards content={content} />,
          [LOG_BLOCK]: content => <SentinelLogRows content={content} />,
          [AWAY_BLOCK]: content => <SentinelAwayCard content={content} panelId={snapshot.panelId ?? ''} />,
        }}
        userNotice={controlLine}
        queuedLabel={queuedControlLabel}
        settings={false}
      />
    );
  }

  return (
    <KeyboardAvoidingView testID="autopilot-screen" behavior="padding" style={[styles.fill, { backgroundColor: colors.surface }]}>
      <Header snapshot={snapshot} />
      {snapshot?.enabled && snapshot.state !== 'stopped' ? <WalkBar snapshot={snapshot} /> : null}
      <View style={styles.fill}>{body}</View>
    </KeyboardAvoidingView>
  );
}

/** Back, Autopilot's mark and name, the machine's badge, and Sentinel before Start (the walk bar has it after). */
function Header({ snapshot }: { snapshot: AutopilotSnapshot | undefined }) {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const { notice, retry } = useConnectionPresence();
  const current = useMachines().find(machine => machine.current);
  return (
    <>
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surface, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }}>
        <View style={styles.bar}>
          <Pressable testID="autopilot-back" accessibilityRole="button" accessibilityLabel="Back" hitSlop={4}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            style={({ pressed }) => [styles.square, { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}>
            <Icon ios="chevron.left" android="arrow_back" size={20} color={colors.text} />
          </Pressable>
          <AutopilotMark size={30} />
          <Text variant="title" accessibilityRole="header" numberOfLines={1} style={styles.fill}>Autopilot</Text>
          {current ? <MachineBadge machine={current} /> : null}
          {/* r4/J24: turning Sentinel on starts Autopilot, so it is here before Start too. */}
          {snapshot?.enabled && snapshot.state === 'stopped' ? <SentinelToggle snapshot={snapshot} /> : null}
        </View>
      </View>
      <ConnectionBar notice={notice} onRetry={retry} />
    </>
  );
}

/** Autopilot's violet arrow on its tint. */
export function AutopilotMark({ size }: { size: number }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.mark, { width: size, height: size, borderRadius: size * 0.3, backgroundColor: withAlpha(colors.autopilot, 0.14) }]}>
      <Icon ios="location" android="near_me" size={size * 0.55} color={colors.autopilot} />
    </View>
  );
}

/** Running or Paused, every Session with what waits in it (the current one violet), and Pause or Go on. */
function WalkBar({ snapshot }: { snapshot: AutopilotSnapshot }) {
  const theme = useTheme();
  const { colors } = theme;
  const pause = useAutopilotControl('pause');
  const goOn = useAutopilotControl('go-on');
  const { status, chips } = walkBar(snapshot);
  const paused = snapshot.state === 'paused';
  const control = paused ? goOn : pause;
  const on = snapshot.sentinel;
  return (
    <View testID="autopilot-walk" style={[styles.walk, { borderBottomColor: colors.border }]}>
      {/* Fixed box: the dot changes colour, never size. */}
      <View style={styles.dotBox}><View style={[styles.walkDot, { backgroundColor: on ? colors.autopilot : paused ? colors.warning : colors.accent }]} /></View>
      <Text testID="autopilot-walk-status" variant="callout" tone="secondary" style={styles.bold}>{status}</Text>
      <LegendList
        testID="autopilot-walk-sessions"
        horizontal
        data={chips}
        keyExtractor={chip => chip.id}
        estimatedItemSize={110}
        showsHorizontalScrollIndicator={false}
        style={styles.fill}
        contentContainerStyle={styles.chips}
        renderItem={({ item: chip, index }) => (
          <View style={styles.chipRow}>
            {index > 0 ? <Icon ios="chevron.right" android="chevron_right" size={11} color={colors.textMuted} /> : null}
            <View testID={`autopilot-walk-session-${chip.id}`} style={[styles.chip, {
              borderColor: chip.current ? colors.autopilot : colors.border,
              backgroundColor: chip.current ? withAlpha(colors.autopilot, 0.08) : 'transparent',
            }]}>
              <Text variant="subhead" numberOfLines={1}>{chip.name}</Text>
              <Text variant="subhead" tone="muted">{chip.waiting}</Text>
            </View>
          </View>
        )}
      />
      <SentinelToggle snapshot={snapshot} />
      <Pressable testID={paused ? 'autopilot-go-on' : 'autopilot-pause'} accessibilityRole="button" accessibilityLabel={paused ? 'Go on' : 'Pause'}
        disabled={control.isPending} onPress={() => control.mutate([])} hitSlop={6}
        style={({ pressed }) => [styles.control, { opacity: control.isPending ? 0.5 : pressed ? 0.7 : 1 }]}>
        <Icon ios={paused ? 'play' : 'stop'} android={paused ? 'play_arrow' : 'stop'} size={14} color={paused ? colors.accentText : colors.textSecondary} />
        <Text variant="subhead" tone={paused ? 'accent' : 'secondary'}>{paused ? 'Go on' : 'Pause'}</Text>
      </Pressable>
    </View>
  );
}

/**
 * Sentinel Mode's switch (package 7): in the walk bar while Autopilot runs, in the header before
 * Start. Turning it on also starts Autopilot, so it is off when Start can't run.
 */
function SentinelToggle({ snapshot }: { snapshot: AutopilotSnapshot }) {
  const { colors } = useTheme();
  const sentinel = useAutopilotSentinel();
  const on = snapshot.sentinel;
  const disabled = sentinel.isPending || (!on && !!startBlocked(snapshot));
  return (
    <Pressable testID="autopilot-sentinel" accessibilityRole="switch" accessibilityState={{ checked: on, disabled }} accessibilityLabel="Sentinel"
      disabled={disabled} onPress={() => sentinel.mutate([!on])} hitSlop={6}
      style={({ pressed }) => [styles.control, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}>
      <Icon ios={on ? 'shield.fill' : 'shield'} android="shield" size={14} color={on ? colors.autopilot : colors.textSecondary} />
      <Text variant="subhead" tone={on ? 'accent' : 'secondary'} style={on ? { color: colors.autopilotText } : undefined}>Sentinel</Text>
    </Pressable>
  );
}

/** Before Start (D-57): opening Autopilot never starts an agent turn. */
function StartPanel({ snapshot }: { snapshot: AutopilotSnapshot }) {
  const { colors } = useTheme();
  const start = useAutopilotControl('start');
  const blocked = startBlocked(snapshot);
  return (
    <Centered testID="autopilot-start">
      <AutopilotMark size={56} />
      <Text variant="title" style={styles.centerText}>Autopilot</Text>
      <Text variant="body" tone="secondary" style={styles.centerText}>
        Press Start and I’ll bring what needs you, one at a time, from the top Session down. You answer every approval yourself.
      </Text>
      {blocked ? <Text testID="autopilot-start-blocked" variant="subhead" style={[styles.centerText, { color: colors.warning }]}>{blocked}</Text> : null}
      {start.isError ? <Text testID="autopilot-start-error" variant="subhead" tone="danger" style={styles.centerText}>{start.error.message}</Text> : null}
      <View style={styles.startButton}>
        <Button testID="autopilot-start-button" title="Start" loading={start.isPending} disabled={!!blocked} onPress={() => start.mutate([])}
          icon={<Icon ios="location.fill" android="near_me" size={15} color={colors.onAccent} />} />
      </View>
    </Centered>
  );
}

/** Centred while it fits; scrolls when it doesn't (a long error under Start), so Start stays reachable. */
function Centered({ testID, children }: { testID: string; children: ReactNode }) {
  return <ScrollView testID={testID} style={styles.fill} contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}

function Message({ title, text, testID }: { title: string; text: string; testID: string }) {
  return (
    <Centered testID={testID}>
      <AutopilotMark size={56} />
      <Text variant="title" style={styles.centerText}>{title}</Text>
      <Text variant="body" tone="secondary" style={styles.centerText}>{text}</Text>
    </Centered>
  );
}

/** An `autopilot-items` block: one decision card per item it names, in its order. */
function ItemCards({ content }: { content: string }) {
  const notify = useNotifyShared();
  const ids = parseItemIds(content);
  return (
    <View testID="autopilot-items" style={styles.cards}>
      {ids.map(id => <ChatCard key={id} notifyId={id} items={notify.data?.items} />)}
    </View>
  );
}

function ChatCard({ notifyId, items }: { notifyId: string; items: readonly NotifyItem[] | undefined }) {
  const answer = useDecisionAnswer(notifyId);
  if (!items) return <View style={styles.cardLoading}><ActivityIndicator /></View>;
  return <DecisionCard notifyId={notifyId} item={items.find(item => item.id === notifyId)} variant="chat" answer={answer} onOpen={() => openAutopilotItem(notifyId)} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  bold: { fontWeight: '600' },
  bar: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 4 },
  square: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  mark: { alignItems: 'center', justifyContent: 'center' },
  walk: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, paddingLeft: 14, paddingRight: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  dotBox: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  walkDot: { width: 8, height: 8, borderRadius: 4 },
  chips: { alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 9, paddingHorizontal: 9, minHeight: 28 },
  control: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 8 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32, paddingVertical: 24 },
  centerText: { textAlign: 'center' },
  startButton: { marginTop: 8, minWidth: 140 },
  cards: { gap: 10, paddingVertical: 4 },
  cardLoading: { minHeight: 80, alignItems: 'center', justifyContent: 'center' },
});
