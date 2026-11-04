import { LegendList } from '@legendapp/list/react-native';
import { useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { chatTurns, type ChatWorkerLine } from '@shared/chatTabPresentation';
import { rejectOption } from '@shared/chatTabPermissions';
import type { ChatTabSend } from '@shared/types/chatTab';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { ComposerSheet } from '../composer/ComposerSheet';
import { Dimmed } from '../hosts/ConnectionStatus';
import { ApprovalCard, DockButton, ProblemBanner, QuestionCard, QueueList } from './ChatTabDock';
import { ChatRowView } from './ChatTabRows';
import { chatRows } from './chatRows';
import { useChatTab } from './useChatTab';

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

function newOperationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface ChatTabScreenProps {
  panelId: string;
  /** The Session orchestrator's chat (D-18): finished turns fold, only the current step shows. */
  quiet?: boolean;
  workers?: ChatWorkerLine[];
  onOpenWorker?: (paneId: string) => void;
  onViewDiff?: (path: string) => void;
  placeholder?: string;
}

/** A chat tab on the phone: the same host conversation the desktop shows. */
export function ChatTabScreen({ panelId, quiet = false, workers, onOpenWorker, onViewDiff, placeholder }: ChatTabScreenProps) {
  const theme = useTheme();
  const { chat, viewer, snapshot, connected } = useChatTab(panelId);
  const view = snapshot.view;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const working = view?.status === 'working' || view?.status === 'blocked';
  const rows = chatRows(chatTurns(snapshot.transcript?.messages ?? [], { running: working }), { quiet, open, workers });
  const agent = view ? AGENT_NAMES[view.agent] : 'the agent';
  const disabled = !connected || !view || view.status === 'stopped';
  const draft = snapshot.draft;

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); viewer.setError(undefined); }
    catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
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
      if (receipt.state !== 'failed') viewer.setDraft('');
    } catch (error) {
      viewer.setError(`${error instanceof Error ? error.message : String(error)} Not sent, or not confirmed: check delivery before sending again.`);
    }
  };
  const send = async () => {
    if (disabled || snapshot.pendingDelivery || !draft.trim()) return;
    Keyboard.dismiss();
    // Typing while an approval waits tells the agent what to do instead.
    for (const permission of view?.permissions ?? []) {
      const reject = rejectOption(permission);
      if (reject) await chat.permission(panelId, permission.id, reject).catch(() => undefined);
    }
    await deliver({ operationId: newOperationId(), text: draft }, true);
  };

  const error = snapshot.error;
  const configLabel = view?.controls.map(control => control.options.find(option => option.value === control.currentValue)?.name).filter(Boolean).join(' · ');
  return <View testID="chat-tab" style={[styles.fill, { backgroundColor: theme.chat.background }]}>
    {view?.problem && <View style={styles.pad}><ProblemBanner problem={view.problem} agent={agent} busy={busy || !connected}
      onRestart={() => void act(() => chat.restart(panelId))} onSignIn={() => void act(() => chat.signIn(panelId))} /></View>}
    {error && <View accessibilityLiveRegion="polite" testID="chat-error" style={[styles.error, { backgroundColor: theme.chat.dangerSoft, borderColor: theme.chat.danger }]}>
      <Text selectable variant="subhead" style={{ color: theme.chat.danger }}>{error}</Text>
    </View>}
    <Dimmed dimmed={!connected} style={styles.fill}>
      {!snapshot.transcript && !view?.problem
        ? <View style={styles.loading}><ActivityIndicator color={theme.chat.mutedForeground} /><Text style={{ color: theme.chat.mutedForeground }}>{view?.status === 'starting' || !view ? `Starting ${agent}…` : 'Loading conversation…'}</Text></View>
        : <LegendList testID="chat-rows" data={rows} keyExtractor={row => row.key} estimatedItemSize={60} recycleItems={false}
          contentContainerStyle={styles.rows} keyboardShouldPersistTaps="handled" maintainVisibleContentPosition maintainScrollAtEnd={{ animated: false }} maintainScrollAtEndThreshold={0.05} initialScrollAtEnd
          ListHeaderComponent={(snapshot.transcript?.start ?? 0) > 0 ? <DockButton testID="chat-earlier" title={snapshot.loadingEarlier ? 'Loading…' : `Earlier messages (${snapshot.transcript?.start})`} disabled={snapshot.loadingEarlier} onPress={() => void viewer.loadEarlier()} style={styles.earlier} /> : null}
          ListFooterComponent={view?.notice ? <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>{view.notice}</Text> : null}
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
      <View style={[styles.composer, { backgroundColor: theme.chat.card, borderColor: theme.chat.border }]}>
        <TextInput testID="chat-input" accessibilityLabel={`Message ${agent}`} placeholder={placeholder ?? `Message ${agent}`} placeholderTextColor={theme.chat.mutedForeground}
          value={draft} onChangeText={text => viewer.setDraft(text)} editable={!snapshot.pendingDelivery} multiline style={[styles.input, { color: theme.chat.foreground }]} />
        <View style={styles.actions}>
          <Pressable testID="chat-settings" accessibilityRole="button" accessibilityLabel="Agent settings" disabled={!view?.controls.length || disabled} onPress={() => setSettings(true)} style={styles.config}>
            <Text numberOfLines={1} variant="footnote" style={{ color: theme.chat.foreground }}>{configLabel || 'Agent settings'}</Text>
            <Icon ios="chevron.down" android="expand_more" size={14} color={theme.chat.mutedForeground} />
          </Pressable>
          {working && <Pressable testID="chat-stop" accessibilityRole="button" accessibilityLabel="Stop" disabled={busy || !connected} onPress={() => void act(() => chat.cancel(panelId))} style={styles.target}>
            <View style={[styles.send, { backgroundColor: theme.chat.primary }]}><Icon ios="stop.fill" android="stop" size={14} color={theme.chat.onPrimary} /></View>
          </Pressable>}
          <Pressable testID="chat-send" accessibilityRole="button" accessibilityLabel={working ? 'Queue message' : 'Send message'} disabled={disabled || !!snapshot.pendingDelivery || !draft.trim()} onPress={() => void send()}
            style={[styles.target, { opacity: disabled || !!snapshot.pendingDelivery || !draft.trim() ? 0.5 : 1 }]}>
            <View style={[styles.send, { backgroundColor: working ? theme.chat.muted : theme.chat.primary }]}><Icon ios="arrow.up" android="arrow_upward" size={16} color={working ? theme.chat.foreground : theme.chat.onPrimary} /></View>
          </Pressable>
        </View>
      </View>
    </View>
    <ComposerSheet visible={settings} onClose={() => setSettings(false)} testID="chat-settings-sheet">
      <View style={styles.settings}>{(view?.controls ?? []).map(control => <View key={control.id} style={styles.choices}>
        <Text variant="headline">{control.name}</Text>
        {control.options.map(option => <DockButton key={option.value} testID={`chat-config-${control.id}-${option.value}`} title={option.name} primary={option.value === control.currentValue}
          disabled={disabled || busy || view?.status !== 'idle'} onPress={() => void act(() => chat.configure(panelId, control.id, option.value))} />)}
      </View>)}</View>
    </ComposerSheet>
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  pad: { padding: 12 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  rows: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  row: { paddingVertical: 4 },
  earlier: { alignSelf: 'center', marginBottom: 8 },
  error: { marginHorizontal: 12, marginTop: 8, padding: 10, borderWidth: 1, borderRadius: 8 },
  dock: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  composer: { borderWidth: 1, borderRadius: 24, padding: 8, gap: 4 },
  input: { minHeight: 40, maxHeight: 160, paddingHorizontal: 10, paddingVertical: 4, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  config: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 6 },
  target: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  send: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  settings: { padding: 16, gap: 24 },
  choices: { gap: 8 },
});
