import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { originLine } from '@shared/approvalReceipts';
import type { NotifyItem, NotifyRemoteCommand, NotifySharedState } from '@shared/types/notify';
import type { ToolPanel } from '@shared/types/panels';

import { invokeChannel, useDaemon, useInvokeMutation } from '@/daemon';
import { ConnectionBar } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { MachineBadge } from '@/features/machines/MachineBadge';
import { useMachines } from '@/features/machines/useMachines';
import { AgentPromptActions } from '@/features/notify/AgentPromptActions';
import { useNotifyCommand, useNotifyShared } from '@/features/notify/hooks';
import { type AnsweredHere, notifySheetState } from '@/features/notify/notifyQuestions';
import { QuestionForm, SentLine } from '@/features/notify/NotifySheet';
import { Notice } from '@/features/panes/PaneKit';
import { useSessionView } from '@/features/sessions/hooks';
import { sinceLabel } from '@/features/allMachines/allMachinesList';
import { TerminalScreen } from '@/features/terminal/TerminalScreen';
import { useTheme } from '@/theme';
import { Button, ErrorState, Icon, Text } from '@/ui';

import { ApprovalActions, ConnectedRow, QuestionActions } from './ApprovalActions';
import { useApprovalSort } from './approvalSortPreference';
import { approvalKindLabel, approvalListOrder, approvalParams, approvalPosition, approvalWorkspace, connectedLink, isResolved, nextApproval, OLDER_MACHINE_NOTE, openApprovalLink, receiptLines, resolveSelection, type ApprovalList, type ApprovalWorkspace } from './approvals';

/** The card never takes more than this share of the screen; the Session below keeps the rest. */
const CARD_MAX_SHARE = 0.45;

/** Opens an item's approval screen on the machine the phone is on, stepping through the list it's in. */
export function openApproval(notifyId: string, list: ApprovalList = 'waiting') {
  router.push({ pathname: '/approval/[notifyId]', params: list === 'waiting' ? { notifyId } : { notifyId, list } });
}

/**
 * One approval at a time, as on the desktop's Approvals screen: the card on top ("1 of N", Next),
 * then the Session it belongs to (its tabs and its orchestrator's chat, where you can ask about
 * it) or the Pane that asked. An item answered elsewhere steps to the next, or back home when it
 * was the last. `hintPaneId` is the Pane a push alert named, shown when the item can't be read.
 * `list` is the one of Approvals' lists it steps through: Waiting, Stale or Answered.
 */
export function ApprovalScreen({ notifyId, hintPaneId, list = 'waiting' }: { notifyId: string; hintPaneId?: string; list?: ApprovalList }) {
  const shared = useNotifyShared();
  const sort = useApprovalSort(state => state.sort);
  const order = approvalListOrder(shared.data, list, Date.now(), sort);
  // The order this screen last showed, so an item that vanishes is followed by the one after it.
  const [shown, setShown] = useState<readonly string[]>([]);
  const selection = shared.data ? resolveSelection(order, notifyId, shown) : null;
  if (selection?.kind === 'show' && shown.join('\n') !== order.join('\n')) setShown(order);

  const moveTo = selection?.kind === 'move' ? selection.id : null;
  const goHome = selection?.kind === 'home';
  useEffect(() => {
    if (moveTo) router.setParams(approvalParams(moveTo));
    else if (goHome) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  }, [moveTo, goHome]);

  const item = selection?.kind === 'show' ? shared.data?.items.find(candidate => candidate.id === selection.id) : undefined;
  const position = item ? approvalPosition(order, item.id) : null;
  const next = item ? nextApproval(order, item.id) : null;
  const onNext = next ? () => router.setParams(approvalParams(next)) : undefined;
  const topBar = <ApprovalTopBar position={position} onNext={onNext} />;

  let card: ReactNode;
  if (item && shared.data) {
    card = <ApprovalCard key={item.id} item={item} shared={shared.data} onNext={onNext} />;
  } else if (selection?.kind === 'gone') {
    card = <CardFrame testID="approval-gone"><Text variant="subhead" tone="secondary">This question is no longer waiting. Nothing else is waiting on you.</Text></CardFrame>;
  } else if (shared.isError) {
    card = <CardFrame testID="approval-error"><ErrorState title="Couldn’t read Approvals" error={shared.error} onRetry={() => void shared.refetch()} /></CardFrame>;
  } else {
    card = <CardFrame testID="approval-loading"><ActivityIndicator /></CardFrame>;
  }

  // While the item is loading or gone, the alert's Pane stands in. A finished item's asker may be gone, so nothing mounts under it.
  const finished = item ? isResolved(item) : false;
  const workspace = item && !finished ? approvalWorkspace(item) : !item && (selection?.kind === 'gone' || shared.isError) ? approvalWorkspace(undefined, hintPaneId) : { kind: 'none' as const };
  return <Workspace workspace={workspace} topBar={topBar} card={card} quiet={!item || finished} />;
}

/** The card above the workspace: a Session's (with its chat), a Pane's tabs, or nothing for a question asked outside Pane. */
const CONTEXT_LINES = 4;

/** A card's context, four lines at most until Show more, so the answers stay in view. */
function ClampedContext({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  return (
    <View>
      <Text testID="approval-context" variant="subhead" tone="secondary" selectable numberOfLines={open ? undefined : CONTEXT_LINES}
        onTextLayout={event => { if (!open) setClamped(event.nativeEvent.lines.length >= CONTEXT_LINES); }}>
        {text}
      </Text>
      {clamped || open ? (
        <Pressable testID="approval-context-more" accessibilityRole="button" hitSlop={8} onPress={() => setOpen(!open)}>
          <Text variant="footnote" tone="secondary">{open ? 'Show less' : 'Show more'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Workspace({ workspace, topBar, card, quiet }: { workspace: ApprovalWorkspace; topBar: ReactNode; card: ReactNode; quiet: boolean }) {
  if (workspace.kind === 'session') return <SessionWorkspace key={workspace.sessionId} sessionId={workspace.sessionId} paneId={workspace.paneId} topBar={topBar} card={card} />;
  if (workspace.kind === 'pane') return <TerminalScreen key={workspace.paneId} paneId={workspace.paneId} initialPanelId={workspace.panelId} topBar={topBar} above={card} />;
  return (
    <Bare topBar={topBar} card={card}>
      {quiet ? null : <Text testID="approval-no-pane" variant="footnote" tone="muted" style={styles.bareNote}>Asked from outside Pane, so there are no tabs to show.</Text>}
    </Bare>
  );
}

function SessionWorkspace({ sessionId, paneId, topBar, card }: { sessionId: string; paneId: string; topBar: ReactNode; card: ReactNode }) {
  const view = useSessionView(sessionId);
  if (view.data) return <TerminalScreen key={view.data.internalSession.id} paneId={view.data.internalSession.id} session={view.data} topBar={topBar} above={card} />;
  // A host that can't read the Session still shows its workspace Pane's tabs.
  if (view.isError) return <TerminalScreen key={paneId} paneId={paneId} topBar={topBar} above={card} />;
  return <Bare topBar={topBar} card={card}><ActivityIndicator style={styles.bareNote} /></Bare>;
}

function Bare({ topBar, card, children }: { topBar: ReactNode; card: ReactNode; children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView testID="approval-bare" behavior="padding" style={[styles.fill, { backgroundColor: theme.colors.surface, paddingBottom: insets.bottom }]}>
      {topBar}
      {card}
      {children}
    </KeyboardAvoidingView>
  );
}

/** Back, "Approvals 1 of N", the machine's badge, and Next. */
function ApprovalTopBar({ position, onNext }: { position: string | null; onNext?: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const { notice, retry } = useConnectionPresence();
  const current = useMachines().find(machine => machine.current);
  return (
    <>
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surface, borderBottomColor: colors.border, borderBottomWidth: 1 }}>
        <View style={styles.bar}>
          <Pressable
            testID="approval-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={4}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            style={({ pressed }) => [styles.square, { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
          >
            <Icon ios="chevron.left" android="arrow_back" size={20} color={colors.textSecondary} />
          </Pressable>
          <View style={styles.barTitle} accessible accessibilityRole="header" accessibilityLabel={position ? `Approvals, ${position}` : 'Approvals'}>
            <Text variant="headline" numberOfLines={1}>Approvals</Text>
            {position ? <Text testID="approval-position" variant="subhead" tone="muted" numberOfLines={1}>{position}</Text> : null}
          </View>
          {current ? <MachineBadge machine={current} /> : null}
          <Pressable
            testID="approval-next"
            accessibilityRole="button"
            accessibilityLabel="Next approval"
            accessibilityState={{ disabled: !onNext }}
            disabled={!onNext}
            hitSlop={4}
            onPress={onNext}
            style={({ pressed }) => [styles.square, { opacity: onNext ? 1 : 0.35, borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
          >
            <Icon ios="chevron.right" android="chevron_right" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>
      <ConnectionBar notice={notice} onRetry={retry} />
    </>
  );
}

function CardFrame({ children, testID }: { children: ReactNode; testID: string }) {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  return (
    <View testID={testID} style={[styles.card, { maxHeight: height * CARD_MAX_SHARE, borderRadius: theme.radius.card, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
      {children}
    </View>
  );
}

/**
 * The approval card: what it needs and when, who asked, the question, what it's connected to, its
 * related links, its answer controls (the Notify sheet's, or Yes and No for an agent's prompt),
 * its receipts, and Close, Override or Reopen. An older machine's mirror is read-only.
 */
function ApprovalCard({ item, shared, onNext }: { item: NotifyItem; shared: NotifySharedState; onNext?: () => void }) {
  const theme = useTheme();
  const { profile } = useDaemon();
  const [answeredHere, setAnsweredHere] = useState<AnsweredHere | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [moreChoices, setMoreChoices] = useState(false);
  const markAnswered = () => setAnsweredHere({ epoch: shared.epoch, revision: shared.revision });
  const command = useNotifyCommand(sent => {
    if (sent.type !== 'answer') return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    markAnswered();
  });
  const state = notifySheetState(shared, item.id, answeredHere);
  // Undone on some screen: the question is open again.
  if (answeredHere && state.kind === 'question') setAnsweredHere(null);
  const undoing = command.isPending && command.variables[0].type === 'undo';
  const error = command.isError ? command.error.message : null;
  const finished = isResolved(item);
  const workspace = approvalWorkspace(item);
  const shownPaneId = workspace.kind === 'none' ? undefined : workspace.paneId;

  let body: ReactNode = null;
  if (item.relay) {
    body = <Text testID="approval-read-only" variant="subhead" tone="secondary" selectable>{OLDER_MACHINE_NOTE}</Text>;
  } else if (state.kind === 'question' && item.agentPrompt && !moreChoices) {
    body = (
      <>
        <AgentPromptActions item={item} inset={0} onAnswered={markAnswered} />
        <Pressable testID="approval-more-choices" accessibilityRole="button" hitSlop={8} onPress={() => setMoreChoices(true)}>
          <Text variant="footnote" tone="accent">Other choices</Text>
        </Pressable>
      </>
    );
  } else if (state.kind === 'question') {
    body = (
      <QuestionForm item={state.item} answer={value => command.mutate([{ type: 'answer', id: item.id, answer: value }])} busy={command.isPending}>
        {({ fields, actions }) => (
          <>
            {fields}
            <QuestionActions actions={actions} />
          </>
        )}
      </QuestionForm>
    );
  } else if (state.kind === 'held' || state.kind === 'done') {
    body = (
      <>
        <Text variant="footnote" tone="muted">{state.title}</Text>
        <SentLine summary={state.summary} />
        <View style={styles.actions}>
          {state.kind === 'held' || undoing ? (
            <View style={styles.action}>
              <Button testID="notify-undo" title="Undo" variant="secondary" loading={undoing} onPress={() => command.mutate([{ type: 'undo', id: item.id }])} />
            </View>
          ) : null}
          {onNext ? <View style={styles.action}><Button testID="approval-card-next" title="Next" variant="secondary" onPress={onNext} /></View> : null}
        </View>
      </>
    );
  } else if (state.kind === 'closed') {
    body = (
      <>
        <Text testID="notify-closed" variant="subhead" tone="secondary">{state.message}</Text>
        {item.state === 'answered' && item.answerSummary ? <SentLine summary={item.answerSummary} /> : null}
      </>
    );
  }

  return (
    <CardFrame testID="approval-card">
      <ScrollView style={styles.cardScroll} contentContainerStyle={styles.cardContent} keyboardShouldPersistTaps="handled">
        <Pressable
          testID="approval-collapse"
          accessibilityRole="button"
          accessibilityLabel={collapsed ? 'Show the whole card' : 'Show less of the card'}
          onPress={() => setCollapsed(!collapsed)}
          style={styles.metaRow}
        >
          <Icon ios="checkmark.circle" android="check_circle" size={15} color={finished ? theme.colors.textMuted : theme.colors.warning} />
          <Text variant="footnote" tone="secondary" numberOfLines={1} style={[styles.fill, styles.bold]}>{approvalKindLabel(item)}</Text>
          <Text variant="footnote" tone="muted">{sinceLabel(item.createdAt, Date.now())}</Text>
          <Icon ios={collapsed ? 'chevron.down' : 'chevron.up'} android={collapsed ? 'expand_more' : 'expand_less'} size={14} color={theme.colors.textMuted} />
        </Pressable>
        <Text testID="approval-origin" variant="footnote" tone="muted" numberOfLines={1}>{originLine(item, profile.label)}</Text>
        <Text testID="notify-title" variant="headline" selectable numberOfLines={collapsed ? 1 : undefined}>{item.title}</Text>
        {collapsed ? null : (
          <>
            {item.context ? <ClampedContext text={item.context} /> : null}
            <ConnectedRow link={connectedLink(item, profile.label)} />
            <LinkChips item={item} shownPaneId={shownPaneId} />
            {body}
            {receiptLines(item).filter(line => state.kind !== 'closed' || line !== state.message).map(line => (
              <Text key={line} testID="approval-receipt" variant="footnote" tone="secondary" selectable>{line}</Text>
            ))}
            <ApprovalActions item={item} />
            {error ? <Notice testID="notify-error" danger message={error} /> : null}
          </>
        )}
      </ScrollView>
    </CardFrame>
  );
}

/**
 * The card's related files and pages. Tapping one asks the host to open it as a tab of the
 * workspace below (the way the desktop card does), with the host's fallbacks: a file page there,
 * then the asking Pane. One command per tap; a lost reply is never sent again.
 */
function LinkChips({ item, shownPaneId }: { item: NotifyItem; shownPaneId?: string }) {
  const theme = useTheme();
  const { client, profile } = useDaemon();
  const queryClient = useQueryClient();
  // No `invalidates`: `readPanels` reads the shown Pane's tabs again once the host answers.
  const open = useInvokeMutation<[NotifyRemoteCommand]>('notify:remote-command');
  const links = item.links ?? [];
  if (links.length === 0) return null;
  const canOpen = Boolean(shownPaneId || item.source.paneId);
  // The same query the tabs below read, so reading it again refreshes them too.
  const panelsKey = [profile.id, 'panels:list', shownPaneId, { chatTabs: true }];

  const readPanels = async (): Promise<readonly string[]> => {
    void queryClient.invalidateQueries({ queryKey: [profile.id, 'panels:getActive'] });
    if (!shownPaneId) return [];
    const panels = await queryClient.fetchQuery({ queryKey: panelsKey, queryFn: () => invokeChannel<ToolPanel[]>(client, 'panels:list', [shownPaneId, { chatTabs: true }]), staleTime: 0 });
    return panels.map(panel => panel.id);
  };

  const openLink = async (index: number) => {
    const before = queryClient.getQueryData<ToolPanel[]>(panelsKey)?.map(panel => panel.id);
    const outcome = await openApprovalLink(item, index, shownPaneId, before, { send: command => open.mutateAsync([command]), readPanels });
    const label = links[index]?.label ?? 'the link';
    if (outcome.kind === 'opened') {
      if (outcome.panelId) router.setParams({ panelId: outcome.panelId });
    } else if (outcome.kind === 'unknown') {
      Alert.alert(`${label} may have opened`, outcome.message);
    } else {
      Alert.alert(`Couldn’t open ${label}`, outcome.message);
    }
  };

  return (
    <View style={styles.links}>
      <Text variant="caption" tone="muted" style={styles.linksTitle}>RELATED</Text>
      <View style={styles.chips}>
        {links.map((link, index) => (
          <Pressable
            key={`${index}:${link.label}`}
            testID={`approval-link-${index}`}
            accessibilityRole="link"
            accessibilityLabel={`Open ${link.label}`}
            disabled={open.isPending || !canOpen}
            onPress={() => void openLink(index)}
            style={({ pressed }) => [styles.chip, { borderRadius: theme.radius.md, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised }]}
          >
            <Icon ios={'url' in link ? 'globe' : 'doc.text'} android={'url' in link ? 'language' : 'description'} size={14} color={theme.colors.textSecondary} />
            <Text variant="subhead" numberOfLines={1} style={styles.chipLabel}>{link.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bold: { fontWeight: '600' },
  bar: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 2 },
  barTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  square: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: 12, marginTop: 10, marginBottom: 6, borderWidth: 1, overflow: 'hidden' },
  cardScroll: { flexGrow: 0 },
  cardContent: { padding: 14, gap: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  action: { flex: 1, maxWidth: 200 },
  links: { gap: 6 },
  linksTitle: { letterSpacing: 0.6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, maxWidth: '100%', paddingHorizontal: 10 },
  chipLabel: { flexShrink: 1 },
  bareNote: { padding: 16, textAlign: 'center' },
});
