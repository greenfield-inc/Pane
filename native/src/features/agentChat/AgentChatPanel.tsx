import { AssistantRuntimeProvider, ThreadPrimitive, generateId, useAuiState, useExternalStoreRuntime, type ThreadState } from '@assistant-ui/react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { permissionToolId, toAssistantMessage } from '@shared/agentChatPresentation';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { ComposerSheet } from '../composer/ComposerSheet';
import { ChatButton } from './ChatButton';
import { ChatMessage, NativePermissionContext, PermissionChoices } from './ChatMessage';
import { pickChatImage } from './pickChatImage';
import { captureReadingPosition, resolveReadingPosition, MESSAGE_TOP_PADDING } from './readingPosition';
import type { useAgentChat } from './useAgentChat';

type Chat = ReturnType<typeof useAgentChat>;

const MESSAGE_COMPONENTS = { Message: ChatMessage };

function ConversationList({ chat, approvalScroll }: { chat: Chat; approvalScroll: RefObject<(() => void) | null> }) {
  const messages = useAuiState(state => state.thread.messages);
  // Wait for assistant-ui's actual message data before freezing restoration.
  return messages.length ? <MessageList chat={chat} approvalScroll={approvalScroll} messages={messages} /> : <View style={styles.fill} />;
}

function MessageList({ chat, approvalScroll, messages }: { chat: Chat; approvalScroll: RefObject<(() => void) | null>; messages: ThreadState['messages'] }) {
  const conversationId = chat.view?.conversation?.nativeSessionId ?? '';
  const [initialPosition] = useState(() => resolveReadingPosition(chat.readingPosition, conversationId, messages));
  // An oversized anchor must be measured even when its estimated height
  // would put the requested within-row offset beyond the virtualized window.
  const [pinnedAnchor, setPinnedAnchor] = useState(() => initialPosition.index ? { keys: [messages[initialPosition.index.index].id] } : undefined);
  const list = useRef<LegendListRef>(null);
  const ready = useRef(false);
  const { chat: colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const [atBottom, setAtBottom] = useState(initialPosition.atBottom);
  const savePosition = () => {
    const state = list.current?.getState();
    const position = state && captureReadingPosition(conversationId, state, ready.current);
    if (position) { chat.saveReadingPosition(position); setAtBottom(position.atBottom); }
  };
  useEffect(() => {
    approvalScroll.current = () => {
      const ids = new Set(chat.view?.permissions.map(permissionToolId));
      const index = messages.findIndex(message => message.parts.some(part => part.type === 'tool-call' && ids.has(part.toolCallId)));
      if (index >= 0) void list.current?.scrollToIndex({ index, animated: !reducedMotion });
      else void list.current?.scrollToEnd({ animated: !reducedMotion });
    };
    return () => { approvalScroll.current = null; };
  }, [approvalScroll, chat.view?.permissions, messages, reducedMotion]);
  return <View style={styles.fill}>
    <LegendList ref={list} testID="chat-messages" data={messages} keyExtractor={message => message.id} recycleItems={false} estimatedItemSize={120} contentContainerStyle={styles.messages} keyboardShouldPersistTaps="handled" maintainVisibleContentPosition maintainScrollAtEnd={{ animated: false }} maintainScrollAtEndThreshold={0.04} initialScrollAtEnd={initialPosition.atBottom} initialScrollIndex={initialPosition.index} alwaysRender={pinnedAnchor} onLoad={() => {
      ready.current = true;
      setPinnedAnchor(undefined);
      const target = initialPosition.index;
      const size = target && list.current?.getState().sizeAtIndex(target.index);
      // A row may shrink while this surface is detached. Keep its bookmark
      // inside the now-measured row rather than scrolling beyond its content.
      if (target && size && -target.viewOffset >= size) void list.current?.scrollToIndex({ ...target, viewOffset: 1 - size, animated: false });
    }} onScroll={savePosition} onMomentumScrollEnd={savePosition} onScrollEndDrag={savePosition} renderItem={({ item }) => <ThreadPrimitive.Unstable_MessageById messageId={item.id} components={MESSAGE_COMPONENTS} />} />
    {!atBottom && <Pressable testID="chat-latest" accessibilityRole="button" accessibilityLabel="Scroll to latest message" onPress={() => void list.current?.scrollToEnd({ animated: !reducedMotion })} style={[styles.latest, { backgroundColor: colors.background, borderColor: colors.border }]}><Icon ios="arrow.down" android="arrow_downward" size={18} color={colors.foreground} /></Pressable>}
  </View>;
}

function ChatSettings({ chat, visible, onClose }: { chat: Chat; visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const controls = chat.view?.controls ?? [];
  const disabled = !chat.connected || !!chat.view?.running || !!chat.view?.permissions.length || !!chat.view?.conversation?.transition;
  return <ComposerSheet visible={visible} onClose={onClose} testID="chat-settings-sheet">
    <LegendList style={{ height: 400 }} data={controls} keyExtractor={control => control.id} estimatedItemSize={160} contentContainerStyle={styles.settings} renderItem={({ item: control }) => <View style={styles.choices}>
      <Text variant="headline">{control.name}</Text>
      {control.options.map(option => <ChatButton key={option.value} testID={`chat-config-${control.id}-${option.value}`} title={option.name} disabled={disabled} primary={option.value === control.currentValue} onPress={() => void chat.configure(control.id, option.value)} icon={option.value === control.currentValue ? <Icon ios="checkmark" android="check" size={16} color={theme.chat.onPrimary} /> : undefined} />)}
    </View>} />
  </ComposerSheet>;
}

export function AgentChatPanel({ chat, draft, onChangeDraft, confirmDraft }: { chat: Chat; draft: string; onChangeDraft: (text: string) => void; confirmDraft: () => void }) {
  const theme = useTheme();
  const { view } = chat;
  const image = chat.attachment;
  const setImage = chat.setAttachment;
  const [settings, setSettings] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [checking, setChecking] = useState(false);
  const approvalScroll = useRef<(() => void) | null>(null);
  const disabled = !chat.connected || view?.conversation?.active !== 'chat' || !!view.conversation.transition;
  const sendDisabled = disabled || !!chat.pendingDelivery || !!view?.running || !!view?.permissions.length;
  const messages = (view?.transcript?.messages ?? []).filter(message => !message.id.startsWith('update:'));
  const send = async () => {
    if (sendDisabled || (!draft.trim() && !image)) return;
    await chat.send({ operationId: generateId(), generation: view?.conversation?.generation ?? 0, text: draft, images: image ? [image] : undefined }, confirmDraft);
  };
  const runtime = useExternalStoreRuntime({ messages, convertMessage: toAssistantMessage, isRunning: view?.running ?? false, isLoading: !view, isSendDisabled: sendDisabled, unstable_persistsHistory: true, unstable_enableToolInvocations: false, onNew: send, onCancel: chat.cancel });
  const check = async (retry: boolean) => {
    setChecking(true);
    try {
      await chat.checkDelivery(retry);
    } finally { setChecking(false); }
  };
  const toolIds = new Set(messages.flatMap(message => message.parts.flatMap(part => part.type === 'tool' ? [part.id] : [])));
  const unmatchedPermissions = (view?.permissions ?? []).filter(permission => !toolIds.has(permissionToolId(permission) ?? ''));
  const error = chat.error ?? view?.error;
  const configLabel = view?.controls?.map(control => control.options.find(option => option.value === control.currentValue)?.name).filter(Boolean).join(' · ');
  return <AssistantRuntimeProvider runtime={runtime}>
    <NativePermissionContext.Provider value={{ permissions: view?.permissions ?? [], disabled, answer: chat.permission }}>
    <ThreadPrimitive.Root testID="agent-chat-panel" style={[styles.fill, { backgroundColor: theme.chat.background }]}>
      {error && <View accessibilityLiveRegion="polite" testID="chat-error" style={[styles.error, { backgroundColor: theme.chat.dangerSoft, borderColor: theme.chat.danger }]}><Text selectable variant="subhead" style={{ color: theme.chat.danger }}>{error}</Text><ChatButton testID="chat-refresh" title="Refresh" onPress={() => void chat.refresh()} /></View>}
      {chat.pendingDelivery && <View style={styles.delivery}><Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>{chat.delivering ? 'Confirming delivery…' : 'Delivery is unconfirmed.'}</Text><ChatButton testID="chat-check-delivery" title="Check delivery" disabled={!chat.connected || checking || chat.delivering} onPress={() => void check(false)} /><ChatButton testID="chat-retry-delivery" title="Retry same delivery" disabled={!chat.connected || checking || chat.delivering} onPress={() => void check(true)} /></View>}
      {view?.conversation?.active === 'stopped' ? <View style={styles.recovery}>
        <Text style={{ color: theme.chat.foreground }}>{view.conversation.recovery ?? 'This conversation is stopped.'}</Text>
        <Text selectable variant="footnote" style={{ color: theme.chat.mutedForeground }}>Conversation {view.conversation.nativeSessionId}</Text>
        <Text variant="subhead" style={{ color: theme.chat.mutedForeground }}>Recovery opens Terminal to restore this conversation’s launch environment.</Text>
        <ChatButton testID="chat-recover" title={recovering ? 'Recovering…' : 'Recover exact conversation'} disabled={!chat.connected || recovering} onPress={() => { setRecovering(true); void chat.recover().finally(() => setRecovering(false)); }} />
      </View> : !view?.transcript ? <View style={styles.loading}><ActivityIndicator color={theme.chat.mutedForeground} /><Text style={{ color: theme.chat.mutedForeground }}>Loading conversation…</Text></View> : <ConversationList key={view.conversation?.nativeSessionId} chat={chat} approvalScroll={approvalScroll} />}
      <View style={styles.composerArea}>
        {/* A phone must keep an approval reachable even while its tool row is offscreen. */}
        {!!view?.permissions.length && unmatchedPermissions.length === 0 && <ChatButton testID="chat-approval-needed" title="Approval needed" onPress={() => approvalScroll.current?.()} />}
        {!!unmatchedPermissions.length && <PermissionChoices permissions={unmatchedPermissions} />}
        <View style={[styles.composer, { backgroundColor: theme.chat.card, borderColor: theme.chat.border }]}>
          {image && <View style={styles.attachment}><Image accessibilityLabel="Attached image" source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={styles.thumbnail} /><ChatButton testID="chat-remove-image" title="Remove image" disabled={!!chat.pendingDelivery} onPress={() => setImage(undefined)} /></View>}
          <TextInput testID="chat-input" accessibilityLabel="Message agent" placeholder="Send a message..." placeholderTextColor={theme.chat.mutedForeground} value={draft} onChangeText={onChangeDraft} editable={!chat.pendingDelivery} multiline style={[styles.input, { color: theme.chat.foreground }]} />
          <View style={styles.composerActions}>
            {view?.canAttachImages && <Pressable testID="chat-attach" accessibilityRole="button" accessibilityLabel="Attach image" disabled={sendDisabled} onPress={() => { void pickChatImage().then(picked => { if (picked) setImage(picked); }).catch(reason => chat.setError(reason instanceof Error ? reason.message : String(reason))); }} style={styles.target}><Icon ios="plus" android="add" size={20} color={theme.chat.mutedForeground} /></Pressable>}
            <Pressable testID="chat-settings" accessibilityRole="button" accessibilityLabel="Agent settings" disabled={!view?.controls?.length || disabled} onPress={() => setSettings(true)} style={styles.config}><Text numberOfLines={1} variant="footnote" style={{ color: theme.chat.foreground }}>{configLabel || 'Agent settings'}</Text><Icon ios="chevron.down" android="expand_more" size={14} color={theme.chat.mutedForeground} /></Pressable>
            <Pressable testID={view?.running ? 'chat-stop' : 'chat-send'} accessibilityRole="button" accessibilityLabel={view?.running ? 'Cancel agent turn' : 'Send message'} disabled={view?.running ? disabled || canceling : sendDisabled || (!draft.trim() && !image)} onPress={() => {
              if (view?.running) { setCanceling(true); void chat.cancel().finally(() => setCanceling(false)); }
              else void send();
            }} style={[styles.target, { opacity: (view?.running ? disabled || canceling : sendDisabled || (!draft.trim() && !image)) ? 0.5 : 1 }]}><View style={[styles.send, { backgroundColor: theme.chat.primary }]}><Icon ios={view?.running ? 'stop.fill' : 'arrow.up'} android={view?.running ? 'stop' : 'arrow_upward'} size={16} color={theme.chat.onPrimary} /></View></Pressable>
          </View>
        </View>
      </View>
      <ChatSettings chat={chat} visible={settings} onClose={() => setSettings(false)} />
    </ThreadPrimitive.Root>
    </NativePermissionContext.Provider>
  </AssistantRuntimeProvider>;
}
const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }, messages: { paddingHorizontal: 16, paddingTop: MESSAGE_TOP_PADDING, paddingBottom: 32 },
  latest: { position: 'absolute', bottom: 12, alignSelf: 'center', width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  composerArea: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 8 }, composer: { borderWidth: 1, borderRadius: 24, padding: 8, gap: 8 }, input: { minHeight: 40, maxHeight: 192, paddingHorizontal: 10, paddingVertical: 4, fontSize: 16, lineHeight: 24, textAlignVertical: 'top' },
  composerActions: { flexDirection: 'row', alignItems: 'center' }, target: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, send: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, config: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, minHeight: 44, paddingHorizontal: 6 },
  error: { margin: 16, padding: 12, borderWidth: 1, borderRadius: 8, gap: 8 }, delivery: { paddingHorizontal: 16, gap: 8 }, recovery: { flex: 1, padding: 16, gap: 12, justifyContent: 'center' }, settings: { padding: 16, gap: 24 }, choices: { gap: 8 }, attachment: { flexDirection: 'row', gap: 8, alignItems: 'center' }, thumbnail: { width: 48, height: 48, borderRadius: 8 },
});
