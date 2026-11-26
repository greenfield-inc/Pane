import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage } from '@assistant-ui/react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';

import { chatAgentLabel } from '@shared/chatAgentMenu';
import { arrangeComposerControls, choiceName, isRiskyMode, paneFullAccessOn, triggerLabels } from '@shared/chatComposerControls';
import { applyPick, commandText, composerPlaceholder, fileReference, messageReferences, moveMarks, skillNames, type ComposerMark } from '@shared/composerMentions';
import { chatTurns, waitingToolIds, type ChatWorkerLine } from '@shared/chatTabPresentation';
import { rejectOption } from '@shared/chatTabPermissions';
import type { ChatTabSend } from '@shared/types/chatTab';

import { useDaemon, useReadOnlyHost } from '@/daemon';
import { useJourneyMark, useLiveMarks, useScreenJourney } from '@/features/perf/usePerfMarks';
import { useTheme } from '@/theme';
import { EmptyState, SkeletonSwap, Text } from '@/ui';

import { ComposerSheet } from '../composer/ComposerSheet';
import { ColumnActive } from '../controller/focusContext';
import { ListeningBar } from '../controller/ListeningBar';
import { rumbleOnConfirm } from '../controller/rumble';
import { useControllerActions } from '../controller/useControllerActions';
import { useVoiceDictation } from '../voice/useVoiceDictation';
import { VoiceAudio } from '../voice/VoiceAudio';
import { Dimmed } from '../hosts/ConnectionStatus';
import { useConnectionPresence } from '../hosts/useConnectionPresence';
import { ChatCommandList, type ChatMenuPick } from './ChatCommandList';
import { ChatTabComposer } from './ChatTabComposer';
import { ChatTabSettings } from './ChatTabSettings';
import { CLOSED_MENU, menuAfterCaret, menuAfterEdit, type ComposerMenuState } from './composerMenu';
import { ApprovalCard, DockButton, ProblemBanner, QuestionCard, QueueList } from './ChatTabDock';
import { ChatRowsSkeleton, ChatRowView, type ChatRowActions } from './ChatTabRows';
import { chatRows } from './chatRows';
import { chatImageAdapter, chatImageAttachment, chatSendFromComposer, chatThreadMessage, composedText, restorableAttachments } from './chatThread';
import { pickChatImages } from './pickChatImages';
import { onChatImageAdded, takeChatImages } from './chatAddedImages';
import { useChatAgents, useChatTab } from './useChatTab';
import { insertAtSelection } from '../composer/insertText';

function newOperationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ChatTabScreenProps {
  panelId: string;
  /** The Session orchestrator's chat (D-18): finished turns fold, only the current step shows. */
  workers?: ChatWorkerLine[];
  onOpenWorker?: (paneId: string) => void;
  onOpenDevice?: (panelId: string) => void;
  onViewDiff?: (path: string) => void;
  /** The Session orchestrator's chat, for its placeholder. */
  session?: boolean;
  /** A fixed placeholder (Autopilot's); without one, the box names what @, $ and / do. */
  placeholder?: string;
  /** Opens a file a sent message names, under the tab's folder; the reason it could not, for the chat to show. */
  onOpenFile?: (path: string) => Promise<string | undefined>;
  /** Fenced blocks this screen draws itself, by language (Autopilot's `autopilot-items` cards). */
  blocks?: Readonly<Record<string, (content: string) => ReactNode>>;
  /** A person's message shown as a short notice instead, '' to hide it, or undefined to keep it (Autopilot's control lines). */
  /** A queued message's label instead of its raw text (Autopilot's Pane lines), or undefined to keep it. */
  queuedLabel?: (text: string) => string | undefined;
  userNotice?: (text: string) => string | undefined;
  /** Shows the agent's settings control in the composer; Autopilot's chat has none to change. */
  settings?: boolean;
}

/**
 * A chat tab on the phone: the same host conversation the desktop shows. As on
 * desktop, an assistant-ui external-store runtime mirrors the host transcript and
 * owns the composer; Pane draws the rows (Legend List over chatRows), the dock
 * and the composer's parts.
 */
export function ChatTabScreen({ panelId, workers, onOpenWorker, onOpenDevice, onViewDiff, onOpenFile, session, placeholder, blocks, userNotice, queuedLabel, settings: showSettings = true }: ChatTabScreenProps) {
  const theme = useTheme();
  useScreenJourney('chat');
  const { chat, viewer, snapshot, whenConnected } = useChatTab(panelId);
  const { live } = useConnectionPresence();
  const { profile } = useDaemon();
  const readOnly = useReadOnlyHost();
  const catalog = useChatAgents();
  const view = snapshot.view;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** A message tapped while the connection comes back waits for it; nothing else goes out meanwhile. */
  const [awaitingConnection, setAwaitingConnection] = useState(false);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState<ComposerMenuState>(CLOSED_MENU);
  /** The picked references tinted in the box, for exactly this text; undefined until the draft is first edited or restored. */
  const [marked, setMarked] = useState<{ text: string; marks: readonly ComposerMark[] }>();
  const [caret, setCaret] = useState<number>();
  const working = view?.status === 'working' || view?.status === 'blocked';
  const messages = snapshot.transcript?.messages ?? [];
  const waiting = waitingToolIds(view?.permissions, view?.questions);
  const rows = chatRows(chatTurns(messages, { running: working }), { open, workers, waiting, blocks: new Set(Object.keys(blocks ?? {})), notice: userNotice });
  const commands = useMemo(() => view?.commands ?? [], [view?.commands]);
  // A view carries its whole command list each time; rows re-render only when a skill's name changes.
  const skillKey = [...skillNames(commands)].sort().join('\n');
  const skills = useMemo(() => new Set(skillKey ? skillKey.split('\n') : []), [skillKey]);
  const openFile = useMemo(() => onOpenFile && ((path: string) => { void onOpenFile(path).then(problem => viewer.setError(problem)); }), [onOpenFile, viewer]);
  // Stable across streamed events, so rows that kept their identity skip rendering.
  const rowActions = useMemo<ChatRowActions>(() => ({
    onToggleTurn: turnId => setOpen(current => { const next = new Set(current); if (next.has(turnId)) next.delete(turnId); else next.add(turnId); return next; }),
    onViewDiff, onOpenWorker, onOpenDevice, skills, onOpenFile: openFile,
    renderBlock: (language, content) => blocks?.[language]?.(content),
  }), [onViewDiff, onOpenWorker, onOpenDevice, skills, openFile, blocks]);
  const agent = view ? chatAgentLabel(catalog, view.agent) : 'the agent';
  const starting = view?.status === 'starting';
  // The computer starts no agent for a phone that only watches, so a chat nobody opened there has nothing to show.
  const notRunning = readOnly && !snapshot.transcript && (view?.status === 'idle' || view?.status === 'stopped');
  // Full strength and typing while the connection comes back; a send waits for it.
  const disabled = !live || !view || view.status === 'stopped';
  useJourneyMark('chat', 'messages', messages.length > 0);
  useJourneyMark('chat', 'live', !disabled);
  useLiveMarks('chat', !disabled);
  /** A restored draft has no picks of its own: its references are found as a sent message's are. */
  const marksOf = (text: string): readonly ComposerMark[] => marked ? (marked.text === text ? marked.marks : []) : messageReferences(text, skills);
  const pending = !!snapshot.pendingDelivery;

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); viewer.setError(undefined); }
    catch (error) { viewer.setError(errorText(error)); }
    finally { setBusy(false); }
  };
  /** One request per message; a lost answer is resolved by its receipt, never by sending again blind. */
  const deliver = async (request: ChatTabSend, retry: boolean) => {
    setAwaitingConnection(true);
    try {
      await whenConnected();
    } catch (error) {
      // A send that never left keeps its text; a delivery check only couldn't run, and the message may be on the host.
      viewer.setError(retry
        ? `${errorText(error)} Your message is still in the box.`
        : 'Delivery could not be checked: the connection is not back. The message is still unconfirmed; check again once it reconnects.');
      return;
    } finally {
      setAwaitingConnection(false);
    }
    viewer.setPendingDelivery(request);
    try {
      const receipt = retry ? await chat.send(panelId, request) : await chat.receipt(panelId, request.operationId);
      if (!receipt) { viewer.setError('The computer has no record of that message yet. Retry sends it once, with the same ID.'); return; }
      viewer.setPendingDelivery(undefined);
      viewer.setError(receipt.state === 'failed' ? receipt.error : undefined);
      if (receipt.state !== 'failed') {
        rumbleOnConfirm();
        viewer.setDraft('');
        runtime.thread.composer.setText('');
        void runtime.thread.composer.clearAttachments();
      }
    } catch (error) {
      viewer.setError(`${errorText(error)} Not sent, or not confirmed: check delivery before sending again.`);
    }
  };
  /** The composer's send. It detached the draft; put it back until the host confirms the message. */
  const send = async (composed: AppendMessage) => {
    // The box empties from code once the host has the message, which no edit reports: close the menu now.
    setMenu(CLOSED_MENU);
    const text = composedText(composed);
    viewer.setDraft(text);
    runtime.thread.composer.setText(text);
    for (const attachment of restorableAttachments(composed)) await runtime.thread.composer.addAttachment(attachment);
    let request: ChatTabSend | undefined;
    try { request = chatSendFromComposer(newOperationId(), composed); }
    catch (error) { viewer.setError(errorText(error)); return; }
    if (disabled || awaitingConnection || snapshot.pendingDelivery || !request) return;
    Keyboard.dismiss();
    // Typing while an approval waits tells the agent what to do instead.
    for (const permission of view?.permissions ?? []) {
      const reject = rejectOption(permission);
      if (reject) await chat.permission(panelId, permission.id, reject).catch(() => undefined);
    }
    await deliver(request, true);
  };

  const runtime = useExternalStoreRuntime({
    messages, convertMessage: chatThreadMessage,
    // The host queues a message sent while the agent works, so the composer never
    // locks for a running turn; Stop is Pane's own button.
    isRunning: false,
    isLoading: !snapshot.transcript && view?.status !== 'stopped',
    isSendDisabled: disabled || pending || awaitingConnection,
    hasEarlier: (snapshot.transcript?.start ?? 0) > 0,
    onLoadEarlier: () => viewer.loadEarlier(),
    unstable_persistsHistory: true, unstable_enableToolInvocations: false,
    adapters: view?.canAttachImages ? { attachments: chatImageAdapter } : undefined,
    onNew: send,
  });
  // The draft lives with the host's viewer (it survives leaving the tab); the composer starts from it.
  useEffect(() => { runtime.thread.composer.setText(viewer.snapshot().draft); }, [runtime, viewer]);
  // Images the device tab's Screenshot to chat added go into the composer, unsent.
  useEffect(() => {
    const take = () => { for (const image of takeChatImages(panelId)) void runtime.thread.composer.addAttachment(chatImageAttachment(image)).catch(() => undefined); };
    take();
    return onChatImageAdded(take);
  }, [runtime, panelId]);

  const draftChanged = (text: string) => {
    const previous = snapshot.draft;
    if (text === previous) return;
    setCaret(undefined);
    setMenu(state => menuAfterEdit(state, previous, text));
    setMarked({ text, marks: moveMarks(marksOf(previous), previous, text) });
    viewer.setDraft(text);
  };
  const caretMoved = (start: number, end: number) => {
    // Any selection event hands the caret back to the input: iOS reports none for the one a pick set,
    // so waiting for the pick's own position would pin the caret there.
    setCaret(undefined);
    setMenu(state => start === end ? menuAfterCaret(state, viewer.snapshot().draft, end) : CLOSED_MENU);
  };
  const pick = (picked: ChatMenuPick) => {
    if (!menu.open) return;
    const draft = snapshot.draft;
    const result = applyPick(draft, menu.open, 'file' in picked ? fileReference(picked.file) : commandText(picked.command));
    setMenu(CLOSED_MENU);
    // A plain command is the agent's own word; files and skills are marked.
    const added = 'file' in picked || picked.command.skill ? [result.mark] : [];
    setMarked({ text: result.text, marks: [...moveMarks(marksOf(draft), draft, result.text), ...added].sort((a, b) => a.start - b.start) });
    setCaret(result.cursor);
    viewer.setDraft(result.text);
    runtime.thread.composer.setText(result.text);
  };
  const attach = async () => {
    try {
      const picked = await pickChatImages();
      for (const image of picked.images) await runtime.thread.composer.addAttachment(chatImageAttachment(image));
      viewer.setError(picked.problem);
    } catch (error) {
      viewer.setError(`${errorText(error)} No image was attached: try again, or choose another image.`);
    }
  };

  // A controller: Y sends like Send, R2 dictates into the box (the words wait for Y), the right stick scrolls.
  const list = useRef<LegendListRef>(null);
  const voice = useVoiceDictation(text => {
    const next = insertAtSelection(viewer.snapshot().draft, null, text).text;
    viewer.setDraft(next);
    runtime.thread.composer.setText(next);
  });
  const scrollBy = (by: number) => {
    const current = list.current;
    if (current) void current.scrollToOffset({ offset: Math.max(0, current.getState().scroll + by), animated: false });
  };
  useControllerActions('tab', {
    'send-draft': () => (readOnly ? false : runtime.thread.composer.send()),
    'dictate-hold': event => {
      if (readOnly || !voice.available) return false;
      if (event.phase === 'start') voice.hold();
      else voice.release();
    },
    'scroll-focused-surface-up': () => scrollBy(-SCROLL_STEP),
    'scroll-focused-surface-down': () => scrollBy(SCROLL_STEP),
    'jump-to-bottom': () => void list.current?.scrollToEnd({ animated: true }),
  }, use(ColumnActive));

  const error = snapshot.error;
  const arranged = arrangeComposerControls(view?.controls ?? []);
  const labels = triggerLabels(arranged);
  // The never-asks marker: the agent's own bypass mode, or Pane's Full access answering approvals for it.
  const riskyMode = arranged.mode && isRiskyMode(arranged.mode) ? choiceName(arranged.mode) : paneFullAccessOn(view?.controls ?? [])?.name;
  const footer = snapshot.hasNewer
    ? <DockButton testID="chat-newer" title="Newer messages" busy={snapshot.loadingNewer} onPress={() => void viewer.loadNewer()} style={styles.newer} />
    : view?.notice ? <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>{view.notice}</Text> : null;
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root testID="chat-tab" style={[styles.fill, { backgroundColor: theme.chat.background }]}>
      {view?.problem && <View style={styles.pad}><ProblemBanner problem={view.problem} agent={agent} busy={busy || !live} readOnly={readOnly}
        onRestart={() => void act(() => chat.restart(panelId))} onSignIn={() => void act(() => chat.signIn(panelId))} /></View>}
      {error && <View accessibilityLiveRegion="polite" testID="chat-error" style={[styles.error, { backgroundColor: theme.chat.dangerSoft, borderColor: theme.chat.danger }]}>
        <Text selectable variant="subhead" style={{ color: theme.chat.danger }}>{error}</Text>
      </View>}
      <Dimmed dimmed={!live} style={styles.fill}>
        <SkeletonSwap loading={!snapshot.transcript && !view?.problem && !notRunning && !(readOnly && error)} style={styles.fill} skeleton={
          <View testID="chat-skeleton" accessible accessibilityLabel={starting ? `Starting ${agent}` : 'Loading conversation'} style={[styles.fill, styles.rows, styles.bones]}>
            <ChatRowsSkeleton />
            {/* The host is launching the agent and replaying its history: a real state, which can take seconds. */}
            {starting && <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>Starting {agent}…</Text>}
          </View>}>
          {notRunning ? <EmptyState testID="chat-not-running" title="Not running" message={`This chat isn’t running on ${profile.label}. Its messages show here once someone opens it there.`} /> : <LegendList ref={list} testID="chat-rows" data={rows} keyExtractor={row => row.key} estimatedItemSize={60} recycleItems={false}
            contentContainerStyle={styles.rows} keyboardShouldPersistTaps="handled" maintainVisibleContentPosition initialScrollAtEnd
            // A window that stops short of the newest message must not chase the end.
            maintainScrollAtEnd={snapshot.hasNewer ? false : { animated: false }} maintainScrollAtEndThreshold={0.05}
            ListHeaderComponent={(snapshot.transcript?.start ?? 0) > 0 ? <DockButton testID="chat-earlier" title={`Earlier messages (${snapshot.transcript?.start})`} busy={snapshot.loadingEarlier} onPress={() => void viewer.loadEarlier()} style={styles.earlier} /> : null}
            ListFooterComponent={footer}
            renderItem={({ item }) => <View style={styles.row}><ChatRowView row={item} actions={rowActions} /></View>} />}
        </SkeletonSwap>
      </Dimmed>
      {readOnly ? null : <View style={styles.dock}>
        {snapshot.pendingDelivery && <View style={styles.inline}>
          <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>Delivery is unconfirmed.</Text>
          <DockButton testID="chat-check-delivery" title="Check delivery" disabled={!live} onPress={() => void deliver(snapshot.pendingDelivery!, false)} />
          <DockButton testID="chat-retry-delivery" title="Retry same message" disabled={!live} onPress={() => void deliver(snapshot.pendingDelivery!, true)} />
        </View>}
        {view?.questions.map(question => <QuestionCard key={question.id} question={question} disabled={disabled || busy} onAnswer={answer => void act(() => chat.answer(panelId, question.id, answer))} />)}
        {view?.permissions.map(permission => <ApprovalCard key={permission.id} permission={permission} agent={agent} disabled={disabled || busy} onAnswer={optionId => void act(() => chat.permission(panelId, permission.id, optionId))} />)}
        {!!view?.queue.length && <QueueList queue={view.queue} label={queuedLabel} onRemove={operationId => void act(() => chat.unqueue(panelId, operationId))} />}
        {voice.audio ? <VoiceAudio {...voice.audio} /> : null}
        <ListeningBar phase={voice.phase} preview={voice.preview} />
        {voice.error ? <Text testID="chat-voice-error" variant="footnote" tone="danger" onPress={voice.clearError}>{voice.error}</Text> : null}
        <ChatCommandList chat={chat} panelId={panelId} trigger={pending ? null : menu.open} view={view} onPick={pick} />
        <ChatTabComposer agent={agent} placeholder={placeholder ?? composerPlaceholder(view?.mentions, { session, phone: true })}
          disabled={disabled} pending={pending} working={working} canStop={!busy && live} canAttach={!!view?.canAttachImages}
          model={labels.model} effort={labels.effort}
          riskyMode={riskyMode} canConfigure={!!view?.controls.length} settings={showSettings}
          marks={marksOf(snapshot.draft)} caret={caret}
          onDraft={draftChanged} onCaret={caretMoved} onAttach={() => void attach()} onSettings={() => setSettings(true)} onStop={() => void act(() => chat.cancel(panelId))} />
      </View>}
      <ComposerSheet visible={settings} onClose={() => setSettings(false)} testID="chat-settings-sheet">
        <ChatTabSettings arranged={arranged} disabled={disabled || busy || view?.status !== 'idle'} configure={(id, value) => void act(() => chat.configure(panelId, id, value))} />
      </ComposerSheet>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}

/** Points the right stick scrolls the conversation per step. */
const SCROLL_STEP = 40;

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  pad: { padding: 12 },
  rows: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  row: { paddingVertical: 4 },
  // The rows' 4 pt padding above and below each.
  bones: { gap: 8 },
  earlier: { alignSelf: 'center', marginBottom: 8 },
  newer: { alignSelf: 'center', marginTop: 8 },
  error: { marginHorizontal: 12, marginTop: 8, padding: 10, borderWidth: 1, borderRadius: 8 },
  dock: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
});
