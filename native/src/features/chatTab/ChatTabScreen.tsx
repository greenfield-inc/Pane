import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage } from '@assistant-ui/react-native';
import { LegendList } from '@legendapp/list/react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, StyleSheet, View } from 'react-native';

import { arrangeComposerControls, choiceName, isRiskyMode, triggerLabels } from '@shared/chatComposerControls';
import { chatTurns, type ChatWorkerLine } from '@shared/chatTabPresentation';
import { rejectOption } from '@shared/chatTabPermissions';
import type { ChatTabCommand, ChatTabSend } from '@shared/types/chatTab';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

import { ComposerSheet } from '../composer/ComposerSheet';
import { Dimmed } from '../hosts/ConnectionStatus';
import { ChatCommandList } from './ChatCommandList';
import { ChatTabComposer } from './ChatTabComposer';
import { ChatTabSettings } from './ChatTabSettings';
import { matchingCommands } from './chatComposer';
import { ApprovalCard, DockButton, ProblemBanner, QuestionCard, QueueList } from './ChatTabDock';
import { ChatRowView } from './ChatTabRows';
import { chatRows } from './chatRows';
import { chatImageAdapter, chatImageAttachment, chatSendFromComposer, chatThreadMessage, composedText, restorableAttachments } from './chatThread';
import { pickChatImages } from './pickChatImages';
import { useChatTab } from './useChatTab';

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

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
  onViewDiff?: (path: string) => void;
  placeholder?: string;
}

/**
 * A chat tab on the phone: the same host conversation the desktop shows. As on
 * desktop, an assistant-ui external-store runtime mirrors the host transcript and
 * owns the composer; Pane draws the rows (Legend List over chatRows), the dock
 * and the composer's parts.
 */
export function ChatTabScreen({ panelId, workers, onOpenWorker, onViewDiff, placeholder }: ChatTabScreenProps) {
  const theme = useTheme();
  const { chat, viewer, snapshot, connected } = useChatTab(panelId);
  const view = snapshot.view;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const working = view?.status === 'working' || view?.status === 'blocked';
  const messages = snapshot.transcript?.messages ?? [];
  const rows = chatRows(chatTurns(messages, { running: working }), { open, workers });
  const agent = view ? AGENT_NAMES[view.agent] : 'the agent';
  const disabled = !connected || !view || view.status === 'stopped';
  const commands = matchingCommands(snapshot.draft, view?.commands ?? []);
  const pending = !!snapshot.pendingDelivery;

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); viewer.setError(undefined); }
    catch (error) { viewer.setError(errorText(error)); }
    finally { setBusy(false); }
  };
  /** One request per message; a lost answer is resolved by its receipt, never by sending again blind. */
  const deliver = async (request: ChatTabSend, retry: boolean) => {
    viewer.setPendingDelivery(request);
    try {
      const receipt = retry ? await chat.send(panelId, request) : await chat.receipt(panelId, request.operationId);
      if (!receipt) { viewer.setError('The computer has no record of that message yet. Retry sends it once, with the same ID.'); return; }
      viewer.setPendingDelivery(undefined);
      viewer.setError(receipt.state === 'failed' ? receipt.error : undefined);
      if (receipt.state !== 'failed') {
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
    const text = composedText(composed);
    viewer.setDraft(text);
    runtime.thread.composer.setText(text);
    for (const attachment of restorableAttachments(composed)) await runtime.thread.composer.addAttachment(attachment);
    let request: ChatTabSend | undefined;
    try { request = chatSendFromComposer(newOperationId(), composed); }
    catch (error) { viewer.setError(errorText(error)); return; }
    if (disabled || snapshot.pendingDelivery || !request) return;
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
    isSendDisabled: disabled || pending,
    hasEarlier: (snapshot.transcript?.start ?? 0) > 0,
    onLoadEarlier: () => viewer.loadEarlier(),
    unstable_persistsHistory: true, unstable_enableToolInvocations: false,
    adapters: view?.canAttachImages ? { attachments: chatImageAdapter } : undefined,
    onNew: send,
  });
  // The draft lives with the host's viewer (it survives leaving the tab); the composer starts from it.
  useEffect(() => { runtime.thread.composer.setText(viewer.snapshot().draft); }, [runtime, viewer]);

  const pickCommand = (command: ChatTabCommand) => {
    const text = `/${command.name} `;
    viewer.setDraft(text);
    runtime.thread.composer.setText(text);
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

  const error = snapshot.error;
  const arranged = arrangeComposerControls(view?.controls ?? []);
  const labels = triggerLabels(arranged);
  const footer = snapshot.hasNewer
    ? <DockButton testID="chat-newer" title={snapshot.loadingNewer ? 'Loading…' : 'Newer messages'} disabled={snapshot.loadingNewer} onPress={() => void viewer.loadNewer()} style={styles.newer} />
    : view?.notice ? <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>{view.notice}</Text> : null;
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root testID="chat-tab" style={[styles.fill, { backgroundColor: theme.chat.background }]}>
      {view?.problem && <View style={styles.pad}><ProblemBanner problem={view.problem} agent={agent} busy={busy || !connected}
        onRestart={() => void act(() => chat.restart(panelId))} onSignIn={() => void act(() => chat.signIn(panelId))} /></View>}
      {error && <View accessibilityLiveRegion="polite" testID="chat-error" style={[styles.error, { backgroundColor: theme.chat.dangerSoft, borderColor: theme.chat.danger }]}>
        <Text selectable variant="subhead" style={{ color: theme.chat.danger }}>{error}</Text>
      </View>}
      <Dimmed dimmed={!connected} style={styles.fill}>
        {!snapshot.transcript && !view?.problem
          ? <View style={styles.loading}><ActivityIndicator color={theme.chat.mutedForeground} /><Text style={{ color: theme.chat.mutedForeground }}>{view?.status === 'starting' || !view ? `Starting ${agent}…` : 'Loading conversation…'}</Text></View>
          : <LegendList testID="chat-rows" data={rows} keyExtractor={row => row.key} estimatedItemSize={60} recycleItems={false}
            contentContainerStyle={styles.rows} keyboardShouldPersistTaps="handled" maintainVisibleContentPosition initialScrollAtEnd
            // A window that stops short of the newest message must not chase the end.
            maintainScrollAtEnd={snapshot.hasNewer ? false : { animated: false }} maintainScrollAtEndThreshold={0.05}
            ListHeaderComponent={(snapshot.transcript?.start ?? 0) > 0 ? <DockButton testID="chat-earlier" title={snapshot.loadingEarlier ? 'Loading…' : `Earlier messages (${snapshot.transcript?.start})`} disabled={snapshot.loadingEarlier} onPress={() => void viewer.loadEarlier()} style={styles.earlier} /> : null}
            ListFooterComponent={footer}
            renderItem={({ item }) => <View style={styles.row}><ChatRowView row={item} actions={{
              onToggleTurn: turnId => setOpen(current => { const next = new Set(current); if (next.has(turnId)) next.delete(turnId); else next.add(turnId); return next; }),
              onViewDiff, onOpenWorker,
            }} /></View>} />}
      </Dimmed>
      <View style={styles.dock}>
        {snapshot.pendingDelivery && <View style={styles.inline}>
          <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>Delivery is unconfirmed.</Text>
          <DockButton testID="chat-check-delivery" title="Check delivery" disabled={!connected} onPress={() => void deliver(snapshot.pendingDelivery!, false)} />
          <DockButton testID="chat-retry-delivery" title="Retry same message" disabled={!connected} onPress={() => void deliver(snapshot.pendingDelivery!, true)} />
        </View>}
        {view?.questions.map(question => <QuestionCard key={question.id} question={question} disabled={disabled || busy} onAnswer={answer => void act(() => chat.answer(panelId, question.id, answer))} />)}
        {view?.permissions.map(permission => <ApprovalCard key={permission.id} permission={permission} agent={agent} disabled={disabled || busy} onAnswer={optionId => void act(() => chat.permission(panelId, permission.id, optionId))} />)}
        {!!view?.queue.length && <QueueList queue={view.queue} onRemove={operationId => void act(() => chat.unqueue(panelId, operationId))} />}
        <ChatCommandList commands={commands} onPick={pickCommand} />
        <ChatTabComposer agent={agent} placeholder={placeholder ?? 'Ask anything'}
          disabled={disabled} pending={pending} working={working} canStop={!busy && connected} canAttach={!!view?.canAttachImages}
          model={labels.model} effort={labels.effort}
          riskyMode={arranged.mode && isRiskyMode(arranged.mode) ? choiceName(arranged.mode) : undefined} canConfigure={!!view?.controls.length}
          onDraft={text => viewer.setDraft(text)} onAttach={() => void attach()} onSettings={() => setSettings(true)} onStop={() => void act(() => chat.cancel(panelId))} />
      </View>
      <ComposerSheet visible={settings} onClose={() => setSettings(false)} testID="chat-settings-sheet">
        <ChatTabSettings arranged={arranged} disabled={disabled || busy || view?.status !== 'idle'} configure={(id, value) => void act(() => chat.configure(panelId, id, value))} />
      </ComposerSheet>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  pad: { padding: 12 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  rows: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  row: { paddingVertical: 4 },
  earlier: { alignSelf: 'center', marginBottom: 8 },
  newer: { alignSelf: 'center', marginTop: 8 },
  error: { marginHorizontal: 12, marginTop: 8, padding: 10, borderWidth: 1, borderRadius: 8 },
  dock: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
});
