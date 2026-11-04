import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NotifyItem, NotifyLink, NotifySharedState } from '@shared/types/notify';
import type { RunpanePanelOpenRequest, RunpanePanelOpenResult } from '@shared/types/runpaneOrchestration';

import { useInvokeMutation } from '@/daemon';
import { ConnectionBar } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { MachineBadge } from '@/features/machines/MachineBadge';
import { useMachines } from '@/features/machines/useMachines';
import { AgentPromptActions } from '@/features/notify/AgentPromptActions';
import { useNotifyCommand, useNotifyShared } from '@/features/notify/hooks';
import { type AnsweredHere, NOTIFY_KIND_LABEL, notifySheetState } from '@/features/notify/notifyQuestions';
import { QuestionForm, SentLine } from '@/features/notify/NotifySheet';
import { Notice } from '@/features/panes/PaneKit';
import { useSessionView } from '@/features/sessions/hooks';
import { sinceLabel } from '@/features/allMachines/allMachinesList';
import { TerminalScreen } from '@/features/terminal/TerminalScreen';
import { useTheme } from '@/theme';
import { Button, ErrorState, Icon, Text } from '@/ui';

import { approvalOrder, approvalPosition, approvalWorkspace, approvalMeta, nextApproval, relayLine, resolveSelection, type ApprovalWorkspace } from './approvals';

/** The card never takes more than this share of the screen; the Session below keeps the rest. */
const CARD_MAX_SHARE = 0.45;

/** Opens an item's approval screen on the machine the phone is on. */
export function openApproval(notifyId: string) {
  router.push({ pathname: '/approval/[notifyId]', params: { notifyId } });
}

/**
 * One approval at a time, as on the desktop's Approvals screen: the card on top ("1 of N", Next),
 * then the Session it belongs to (its tabs and its orchestrator's chat, where you can ask about
 * it) or the Pane that asked. An item answered elsewhere steps to the next, or back home when it
 * was the last. `hintPaneId` is the Pane a push alert named, shown when the item can't be read.
 */
export function ApprovalScreen({ notifyId, hintPaneId }: { notifyId: string; hintPaneId?: string }) {
  const shared = useNotifyShared();
  const order = approvalOrder(shared.data);
  // The order this screen last showed, so an item that vanishes is followed by the one after it.
  const [shown, setShown] = useState<readonly string[]>([]);
  const selection = shared.data ? resolveSelection(order, notifyId, shown) : null;
  if (selection?.kind === 'show' && shown.join('\n') !== order.join('\n')) setShown(order);

  const moveTo = selection?.kind === 'move' ? selection.id : null;
  const goHome = selection?.kind === 'home';
  useEffect(() => {
    if (moveTo) router.setParams({ notifyId: moveTo, panelId: undefined });
    else if (goHome) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  }, [moveTo, goHome]);

  const item = selection?.kind === 'show' ? shared.data?.items.find(candidate => candidate.id === selection.id) : undefined;
  const position = item ? approvalPosition(order, item.id) : null;
  const next = item ? nextApproval(order, item.id) : null;
  const topBar = <ApprovalTopBar position={position} onNext={next ? () => router.setParams({ notifyId: next, panelId: undefined }) : undefined} />;

  let card: ReactNode;
  if (item && shared.data) {
    card = <ApprovalCard key={item.id} item={item} shared={shared.data} onNext={next ? () => router.setParams({ notifyId: next, panelId: undefined }) : undefined} />;
  } else if (selection?.kind === 'gone') {
    card = <CardFrame testID="approval-gone"><Text variant="subhead" tone="secondary">This question is no longer waiting. Nothing else is waiting on you.</Text></CardFrame>;
  } else if (shared.isError) {
    card = <CardFrame testID="approval-error"><ErrorState title="Couldn’t read Approvals" error={shared.error} onRetry={() => void shared.refetch()} /></CardFrame>;
  } else {
    card = <CardFrame testID="approval-loading"><ActivityIndicator /></CardFrame>;
  }

  // While the item is loading or gone, the alert's Pane stands in.
  const workspace = item ? approvalWorkspace(item) : selection?.kind === 'gone' || shared.isError ? approvalWorkspace(undefined, hintPaneId) : { kind: 'none' as const };
  return <Workspace workspace={workspace} topBar={topBar} card={card} loading={!item} />;
}

/** The card above the workspace: a Session's (with its chat), a Pane's tabs, or nothing for a question asked outside Pane. */
function Workspace({ workspace, topBar, card, loading }: { workspace: ApprovalWorkspace; topBar: ReactNode; card: ReactNode; loading: boolean }) {
  if (workspace.kind === 'session') return <SessionWorkspace key={workspace.sessionId} sessionId={workspace.sessionId} paneId={workspace.paneId} topBar={topBar} card={card} />;
  if (workspace.kind === 'pane') return <TerminalScreen key={workspace.paneId} paneId={workspace.paneId} topBar={topBar} above={card} />;
  return (
    <Bare topBar={topBar} card={card}>
      {loading ? null : <Text testID="approval-no-pane" variant="footnote" tone="muted" style={styles.bareNote}>Asked from outside Pane, so there are no tabs to show.</Text>}
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
 * The approval card: who asked and when, the question, its related links, and its answer
 * controls (the Notify sheet's, or Yes and No for an agent's prompt). A fallback item is read-only.
 */
function ApprovalCard({ item, shared, onNext }: { item: NotifyItem; shared: NotifySharedState; onNext?: () => void }) {
  const theme = useTheme();
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
  const relay = relayLine(item);
  const workspace = approvalWorkspace(item);
  const shownPaneId = workspace.kind === 'none' ? undefined : workspace.paneId;

  let body: ReactNode = null;
  if (relay) {
    body = <Text testID="approval-relay" variant="subhead" tone="secondary" selectable>{relay}</Text>;
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
            {actions.length > 0 ? (
              <View style={styles.actions}>
                {actions.map(action => (
                  <View key={action.testID} style={styles.action}>
                    <Button
                      testID={action.testID}
                      title={action.title}
                      variant={action.variant === 'danger' ? 'destructive' : 'primary'}
                      loading={action.loading}
                      disabled={action.disabled}
                      onPress={action.onPress}
                    />
                  </View>
                ))}
              </View>
            ) : null}
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
    body = <Text testID="notify-closed" variant="subhead" tone="secondary">{state.message}</Text>;
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
          <Icon ios={relay ? 'hourglass' : 'checkmark.circle'} android={relay ? 'hourglass_empty' : 'check_circle'} size={15} color={theme.colors.warning} />
          <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.fill}>
            <Text variant="footnote" tone="secondary" style={styles.bold}>{relay ? 'Waiting' : NOTIFY_KIND_LABEL[item.ui]}</Text>
            {`  ·  ${approvalMeta(item)}`}
          </Text>
          <Text variant="footnote" tone="muted">{sinceLabel(item.createdAt, Date.now())}</Text>
          <Icon ios={collapsed ? 'chevron.down' : 'chevron.up'} android={collapsed ? 'expand_more' : 'expand_less'} size={14} color={theme.colors.textMuted} />
        </Pressable>
        <Text testID="notify-title" variant="headline" selectable numberOfLines={collapsed ? 1 : undefined}>{item.title}</Text>
        {collapsed ? null : (
          <>
            {item.context ? <Text variant="subhead" tone="secondary" selectable>{item.context}</Text> : null}
            <LinkChips item={item} shownPaneId={shownPaneId} />
            {body}
            {error ? <Notice testID="notify-error" danger message={error} /> : null}
          </>
        )}
      </ScrollView>
    </CardFrame>
  );
}

/**
 * The card's related files and pages. Tapping one opens it as a tab of the workspace below (the
 * way the desktop card does), or of the asking Pane when the workspace can't open it.
 */
function LinkChips({ item, shownPaneId }: { item: NotifyItem; shownPaneId?: string }) {
  const theme = useTheme();
  const open = useInvokeMutation<[RunpanePanelOpenRequest], RunpanePanelOpenResult>('runpane:panels:open', { invalidates: ['panels:list', 'panels:getActive'] });
  const links = item.links ?? [];
  if (links.length === 0) return null;
  const panes = [...new Set([shownPaneId, item.source.paneId].filter((paneId): paneId is string => Boolean(paneId)))];

  const openLink = async (link: NotifyLink) => {
    const target = 'url' in link ? { url: link.url } : { filePath: link.path };
    let failure: unknown = new Error('the card names no Pane');
    for (const paneId of panes) {
      try {
        const opened = await open.mutateAsync([{ paneId, ...target, placement: 'tab', source: 'user' }]);
        if (opened.paneId === shownPaneId) router.setParams({ panelId: opened.panelId });
        else router.push({ pathname: '/pane/[paneId]', params: { paneId: opened.paneId, panelId: opened.panelId } });
        return;
      } catch (error) {
        failure = error;
      }
    }
    Alert.alert(`Couldn’t open ${link.label}`, `${failure instanceof Error ? failure.message : String(failure)} Nothing was opened.`);
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
            disabled={open.isPending || panes.length === 0}
            onPress={() => void openLink(link)}
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
