import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { originLine } from '@shared/approvalReceipts';
import type { NotifyItem, NotifyLink, NotifySharedState } from '@shared/types/notify';

import { useDaemon } from '@/daemon';
import { FileDoc, UrlDoc } from '@/features/pages/StaticPage';
import { ConnectionBar } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { MachineBadge } from '@/features/machines/MachineBadge';
import { useMachines } from '@/features/machines/useMachines';
import { AgentPromptActions } from '@/features/notify/AgentPromptActions';
import { useNotifyCommand, useNotifyShared } from '@/features/notify/hooks';
import { type AnsweredHere, isReply, notifySheetState } from '@/features/notify/notifyQuestions';
import { QuestionForm, questionFormKey, ReplyStatusLines, RevisionLines, SentLine } from '@/features/notify/NotifySheet';
import { Notice } from '@/features/panes/PaneKit';
import { useSessionView } from '@/features/sessions/hooks';
import { sinceLabel } from '@/features/allMachines/allMachinesList';
import { PanelTabs, type LeadingTab } from '@/features/terminal/PanelTabs';
import { BottomGap, LeadingBodies, type LeadingTabs, TerminalScreen } from '@/features/terminal/TerminalScreen';
import { StateScreen } from '@/features/tabs/StateScreen';
import { perfMark } from '@/features/perf/perfMarks';
import { useJourneyMark, useScreenJourney } from '@/features/perf/usePerfMarks';
import { useTheme } from '@/theme';
import { Button, ErrorState, Icon, Skeleton, SkeletonSwap, Text } from '@/ui';

import { ApprovalActions, ConnectedRow, QuestionActions } from './ApprovalActions';
import { useApprovalSort } from './approvalSortPreference';
import { approvalKindLabel, approvalLinkTarget, linkIcon, approvalListOrder, approvalParams, approvalPosition, approvalWorkspace, connectedLink, isResolved, nextApproval, OLDER_MACHINE_NOTE, receiptLines, resolveSelection, summaryItemId, type ApprovalList, type ApprovalWorkspace } from './approvals';
import { SummaryTab } from './SummaryTab';

/** The approval's own tab: always first, and it can't be closed. */
const APPROVAL_TAB = 'approval';
const SUMMARY_TAB = 'summary';
const linkTab = (index: number) => `link:${index}`;

/** Opens an item's approval screen on the machine the phone is on, stepping through the list it's in. */
export function openApproval(notifyId: string, list: ApprovalList = 'waiting') {
  router.push({ pathname: '/approval/[notifyId]', params: list === 'waiting' ? { notifyId } : { notifyId, list } });
}

/**
 * One approval at a time, as on the desktop's Approvals screen ("1 of N", Next), drawn as tabs: the
 * approval itself first, then the Summary and each related file or page opened from it, then the
 * tabs of the Session it belongs to (its orchestrator's chat, where you can ask about it) or of
 * the Pane that asked. An item answered elsewhere steps to the next, or back home when it was the
 * last. `hintPaneId` is the Pane a push alert named, shown when the item can't be read. `list` is
 * the one of Approvals' lists it steps through: Waiting, Stale or Answered.
 */
export function ApprovalScreen({ notifyId, hintPaneId, list = 'waiting' }: { notifyId: string; hintPaneId?: string; list?: ApprovalList }) {
  useScreenJourney('approval', notifyId);
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

  // The Summary and links opened on this item, in the order they were opened. Next starts over.
  const { panelId } = useLocalSearchParams<{ panelId?: string }>();
  const [opened, setOpened] = useState<{ itemId: string; ids: readonly string[] }>({ itemId: '', ids: [] });
  const openIds = item && opened.itemId === item.id ? opened.ids : [];
  const openTab = (id: string) => {
    if (!item) return;
    if (!openIds.includes(id)) setOpened({ itemId: item.id, ids: [...openIds, id] });
    router.setParams({ panelId: id });
  };
  const closeTab = (id: string) => {
    if (!item) return;
    setOpened({ itemId: item.id, ids: openIds.filter(open => open !== id) });
    if (panelId === id) router.setParams({ panelId: APPROVAL_TAB });
  };

  // The card draws from the Approvals snapshot the phone saved, so a skeleton shows only before the
  // first one this machine ever sent (or while the screen steps to another item).
  let content: ReactNode = null;
  if (item && shared.data) {
    content = <ApprovalCard key={item.id} item={item} shared={shared.data} onNext={onNext} onOpenTab={openTab} />;
  } else if (selection?.kind === 'gone') {
    content = <TabFrame testID="approval-gone"><Text variant="subhead" tone="secondary">This question is no longer waiting. Nothing else is waiting on you.</Text></TabFrame>;
  } else if (shared.isError) {
    content = <TabFrame testID="approval-error"><ErrorState title="Couldn’t read Approvals" error={shared.error} onRetry={() => void shared.refetch()} /></TabFrame>;
  }
  const card = <SkeletonSwap loading={content === null} skeleton={<CardSkeleton />} style={styles.fill}>{content}</SkeletonSwap>;

  const tabs: LeadingTab[] = [{ id: APPROVAL_TAB, title: 'Approval', icon: { ios: 'checkmark.circle', android: 'check_circle' } }];
  for (const id of openIds) {
    const reference = item ? referenceOf(item, id) : null;
    if (reference) tabs.push({ id, title: reference.title, icon: reference.icon, label: 'page', onClose: () => closeTab(id) });
  }
  const leading: LeadingTabs = {
    tabs,
    render: id => {
      const reference = item ? referenceOf(item, id) : null;
      return item && reference ? <ReferenceBody item={item} reference={reference} /> : card;
    },
  };

  // While the item is loading or gone, the alert's Pane stands in. A finished item's asker may be gone, so nothing mounts under it.
  const finished = item ? isResolved(item) : false;
  const workspace = item && !finished ? approvalWorkspace(item) : !item && (selection?.kind === 'gone' || shared.isError) ? approvalWorkspace(undefined, hintPaneId) : { kind: 'none' as const };
  useJourneyMark('approval', `workspace=${workspace.kind}`, true, true);
  return <Workspace workspace={workspace} topBar={topBar} leading={leading} />;
}

/** What one of the approval's tabs past its own shows: its Summary, or one of its links that isn't another approval. */
type Reference =
  | { kind: 'summary'; title: string; icon: LeadingTab['icon']; notifyId: string }
  | { kind: 'link'; title: string; icon: LeadingTab['icon']; link: Exclude<NotifyLink, { approval: string }> };

function referenceOf(item: NotifyItem, id: string): Reference | null {
  if (id === SUMMARY_TAB) {
    const notifyId = summaryItemId(item);
    return notifyId ? { kind: 'summary', title: 'Summary', icon: { ios: 'doc.richtext', android: 'article' }, notifyId } : null;
  }
  const link = item.links?.find((_link, at) => linkTab(at) === id);
  return link && !('approval' in link) ? { kind: 'link', title: link.label, icon: linkIcon(link), link } : null;
}

/**
 * A Summary or link tab. A file is read through the phone's connection (`autopilot:read-doc`, as
 * the desktop's Approvals tabs read it) and an html file draws as its page with scripts off. Only
 * the machine the phone is on serves its own approvals' files.
 */
function ReferenceBody({ item, reference }: { item: NotifyItem; reference: Reference }) {
  if (reference.kind === 'summary') return <SummaryTab notifyId={reference.notifyId} />;
  const { link } = reference;
  if ('url' in link) return <UrlDoc url={link.url} />;
  if (summaryItemId(item)) return <FileDoc path={link.path} />;
  const machine = item.machine ?? 'its machine';
  return <StateScreen testID="approval-link-elsewhere" icon={{ ios: 'doc.text', android: 'description' }} title={`${link.label} is on ${machine}`} message={`Connect the phone to ${machine} to read it, or open it in Pane there.`} />;
}

/**
 * The card's title and subtitle (its context, in full). A card Pane tidied (P8) says so, and Show
 * as sent swaps in the title and context exactly as the asker sent them.
 */
function CardHeading({ item }: { item: NotifyItem }) {
  const [asSent, setAsSent] = useState(false);
  const sent = asSent ? item.asSent : undefined;
  const title = sent ? sent.title : item.title;
  const context = sent ? sent.context : item.context;
  return (
    <>
      <Text testID="notify-title" variant="headline" selectable>{title}</Text>
      {context ? <Text testID="approval-context" variant="subhead" tone="secondary" selectable>{context}</Text> : null}
      {item.asSent ? (
        <View style={styles.tidied}>
          <Text testID="approval-tidied" variant="footnote" tone="muted">Tidied by Pane</Text>
          <Pressable testID="approval-show-as-sent" accessibilityRole="button" accessibilityState={{ selected: asSent }} hitSlop={8} onPress={() => setAsSent(!asSent)}>
            <Text variant="footnote" tone="accent">{asSent ? 'Show tidied' : 'Show as sent'}</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

/** Opens the approval's Summary tab; only an approval of the machine the phone is on has one here. */
function SummaryRow({ item, onOpen }: { item: NotifyItem; onOpen: () => void }) {
  const theme = useTheme();
  const id = summaryItemId(item);
  if (!id) return null;
  return (
    <Pressable
      testID="approval-summary"
      accessibilityRole="button"
      accessibilityLabel="Open the Summary"
      onPress={onOpen}
      style={({ pressed }) => [styles.chip, styles.summary, { borderRadius: theme.radius.md, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised }]}
    >
      <Icon ios="doc.richtext" android="article" size={14} color={theme.colors.textSecondary} />
      <Text variant="subhead" numberOfLines={1} style={styles.chipLabel}>Summary</Text>
    </Pressable>
  );
}

function Workspace({ workspace, topBar, leading }: { workspace: ApprovalWorkspace; topBar: ReactNode; leading: LeadingTabs }) {
  if (workspace.kind === 'session') return <SessionWorkspace key={workspace.sessionId} sessionId={workspace.sessionId} paneId={workspace.paneId} topBar={topBar} leading={leading} />;
  if (workspace.kind === 'pane') return <TerminalScreen key={workspace.paneId} paneId={workspace.paneId} topBar={topBar} leading={leading} />;
  return <Bare topBar={topBar} leading={leading} />;
}

/**
 * The Session's workspace Pane from the first frame, its saved tabs included, with the Session's
 * chat tab added when the Session is read. One screen throughout, so the card keeps its state and
 * place. A host that can't read the Session still shows its workspace Pane's tabs.
 */
function SessionWorkspace({ sessionId, paneId, topBar, leading }: { sessionId: string; paneId: string; topBar: ReactNode; leading: LeadingTabs }) {
  const view = useSessionView(sessionId);
  return <TerminalScreen paneId={view.data?.internalSession.id ?? paneId} session={view.data} topBar={topBar} leading={leading} />;
}

/** The approval's own tabs with no Pane's after them: asked from outside Pane, or finished. */
function Bare({ topBar, leading }: { topBar: ReactNode; leading: LeadingTabs }) {
  const theme = useTheme();
  const { panelId } = useLocalSearchParams<{ panelId?: string }>();
  const tab = leading.tabs.find(candidate => candidate.id === panelId) ?? leading.tabs[0];
  return (
    <KeyboardAvoidingView testID="approval-bare" behavior="padding" style={[styles.fill, { backgroundColor: theme.colors.surface }]}>
      {topBar}
      <PanelTabs panels={[]} selectedId={tab?.id ?? null} leading={leading.tabs} onSelectLeading={id => router.setParams({ panelId: id })} />
      <LeadingBodies leading={leading} selectedId={tab?.id ?? null} />
      <BottomGap />
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
          {current ? <MachineBadge machine={current} full /> : null}
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

/** The approval tab's page, for the card or what stands in for it. */
function TabFrame({ children, testID }: { children: ReactNode; testID: string }) {
  const theme = useTheme();
  return <View testID={testID} onLayout={({ nativeEvent: { layout } }) => perfMark('approval', `card=${Math.round(layout.y)}+${Math.round(layout.height)}`, { changes: true })} style={[styles.fill, styles.cardContent, { backgroundColor: theme.colors.background }]}>{children}</View>;
}

/** The card's footprint before the first snapshot: its kind line, origin, question, context and two answer buttons. */
function CardSkeleton() {
  const theme = useTheme();
  return (
    <View testID="approval-skeleton" accessible accessibilityLabel="Loading the approval" style={[styles.fill, styles.cardContent, { backgroundColor: theme.colors.background }]}>
      <View style={styles.metaRow}>
        <Skeleton width={15} height={15} radius={8} />
        <Skeleton width="35%" height={12} />
      </View>
      <Skeleton width="50%" height={12} style={styles.boneFootnote} />
      <Skeleton width="85%" height={16} style={styles.boneHeadline} />
      <Skeleton width="95%" height={14} style={styles.boneSubhead} />
      <Skeleton width="60%" height={14} style={styles.boneSubhead} />
      <View style={styles.actions}>
        <View style={styles.action}><Skeleton height={44} radius={theme.radius.md} /></View>
        <View style={styles.action}><Skeleton height={44} radius={theme.radius.md} /></View>
      </View>
    </View>
  );
}

/**
 * The approval card: what it needs and when, who asked, the question, what it's connected to, its
 * related links, its answer controls (the Notify sheet's, or Yes and No for an agent's prompt),
 * its receipts, and Close, Override or Reopen. An older machine's mirror is read-only.
 */
function ApprovalCard({ item, shared, onNext, onOpenTab }: { item: NotifyItem; shared: NotifySharedState; onNext?: () => void; onOpenTab: (id: string) => void }) {
  const theme = useTheme();
  const { profile } = useDaemon();
  const [answeredHere, setAnsweredHere] = useState<AnsweredHere | null>(null);
  const [moreChoices, setMoreChoices] = useState(false);
  const markAnswered = () => setAnsweredHere({ epoch: shared.epoch, revision: shared.revision });
  const command = useNotifyCommand(sent => {
    if (sent.type !== 'answer' && sent.type !== 'fix-reply') return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // A reply isn't held for Undo: the next snapshot shows it being read, then how it was taken.
    if (sent.type === 'answer' && !isReply(sent.answer)) markAnswered();
  });
  const fixing = command.isPending && command.variables[0].type === 'fix-reply';
  const state = notifySheetState(shared, item.id, answeredHere);
  // Undone on some screen: the question is open again.
  if (answeredHere && state.kind === 'question') setAnsweredHere(null);
  const undoing = command.isPending && command.variables[0].type === 'undo';
  const error = command.isError ? command.error.message : null;
  const finished = isResolved(item);

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
      <QuestionForm key={questionFormKey(state.item)} item={state.item} answer={value => command.mutate([{ type: 'answer', id: item.id, answer: value }])} busy={command.isPending}>
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
    <ScrollView testID="approval-card" onLayout={({ nativeEvent: { layout } }) => perfMark('approval', `card=${Math.round(layout.y)}+${Math.round(layout.height)}`, { changes: true })} style={[styles.fill, { backgroundColor: theme.colors.background }]} contentContainerStyle={styles.cardContent} keyboardShouldPersistTaps="handled">
      <View style={styles.metaRow}>
        <Icon ios="checkmark.circle" android="check_circle" size={15} color={finished ? theme.colors.textMuted : theme.colors.warning} />
        <Text variant="footnote" tone="secondary" numberOfLines={1} style={[styles.fill, styles.bold]}>{approvalKindLabel(item)}</Text>
        <Text variant="footnote" tone="muted">{sinceLabel(item.createdAt, Date.now())}</Text>
      </View>
      <Text testID="approval-origin" variant="footnote" tone="muted" numberOfLines={1}>{originLine(item, profile.label)}</Text>
      <CardHeading item={item} />
      <RevisionLines item={item} />
      <ConnectedRow link={connectedLink(item, profile.label)} />
      <LinkChips item={item} shared={shared} onOpenTab={onOpenTab} />
      <SummaryRow item={item} onOpen={() => onOpenTab(SUMMARY_TAB)} />
      {item.relay ? null : <ReplyStatusLines item={item} fixing={fixing} onFix={as => command.mutate([{ type: 'fix-reply', id: item.id, as }])} />}
      {body}
      {receiptLines(item).filter(line => state.kind !== 'closed' || line !== state.message).map(line => (
        <Text key={line} testID="approval-receipt" variant="footnote" tone="secondary" selectable>{line}</Text>
      ))}
      <ApprovalActions item={item} />
      {error ? <Notice testID="notify-error" danger message={error} /> : null}
    </ScrollView>
  );
}

/**
 * The card's related files and pages. Tapping one opens it as a tab beside the approval, or brings
 * its tab forward; another approval opens on this screen instead, with Back to this one.
 */
function LinkChips({ item, shared, onOpenTab }: { item: NotifyItem; shared: NotifySharedState; onOpenTab: (id: string) => void }) {
  const theme = useTheme();
  const { profile } = useDaemon();
  const links = item.links ?? [];
  if (links.length === 0) return null;

  const openLink = (index: number) => {
    const link = links[index];
    if (link && 'approval' in link) {
      const target = approvalLinkTarget(shared, link.approval, Date.now());
      if (target) openApproval(target.id, target.list);
      else Alert.alert(`Couldn’t open ${link.label}`, `${profile.label} doesn’t list it on Approvals: it may be older than a day or named by its Q-n. Open it in Pane on ${profile.label}.`);
      return;
    }
    onOpenTab(linkTab(index));
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
            onPress={() => openLink(index)}
            style={({ pressed }) => [styles.chip, { borderRadius: theme.radius.md, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised }]}
          >
            <Icon {...linkIcon(link)} size={14} color={theme.colors.textSecondary} />
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
  cardContent: { padding: 16, gap: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  action: { flex: 1, maxWidth: 200 },
  links: { gap: 6 },
  linksTitle: { letterSpacing: 0.6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, maxWidth: '100%', paddingHorizontal: 10 },
  chipLabel: { flexShrink: 1 },
  summary: { alignSelf: 'flex-start' },
  tidied: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  // Bones sit centred in their text's line: footnote 16, headline 24, subhead 20.
  boneFootnote: { marginVertical: 2 },
  boneHeadline: { marginVertical: 4 },
  boneSubhead: { marginVertical: 3 },
});
