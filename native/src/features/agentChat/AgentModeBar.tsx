import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { AgentInterface } from '@shared/types/agentChat';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { ComposerSheet } from '../composer/ComposerSheet';
import { ChatButton } from './ChatButton';
import type { useAgentChat } from './useAgentChat';

export function AgentModeBar({ chat }: { chat: ReturnType<typeof useAgentChat> }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [nativeId, setNativeId] = useState('');
  const [socketPath, setSocketPath] = useState('');
  const conversation = chat.view?.conversation;
  const transitioning = !!conversation?.transition && conversation.active !== 'stopped';
  const change = async (mode: AgentInterface) => {
    setBusy(true);
    try { await chat.switch(mode); }
    finally { setBusy(false); }
  };
  const status = !chat.connected ? 'Reconnecting…' : transitioning ? 'Switching interface…' : conversation?.pendingSwitch ? `Switch to ${conversation.pendingSwitch.target === 'chat' ? 'Chat' : 'Terminal'} after this turn` : conversation?.active === 'stopped' ? 'Conversation stopped' : chat.view?.permissions.length ? 'Waiting for you' : chat.view?.running ? 'Agent is working' : '';
  return <View testID="chat-mode-bar" style={[styles.root, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
    {chat.view?.available && <View style={styles.row}>
      <Text accessibilityLiveRegion="polite" variant="subhead" tone="secondary" style={styles.status}>{status}</Text>
      <View accessibilityRole="radiogroup" style={[styles.switch, { backgroundColor: theme.colors.surfacePressed }]}>
        {(['chat', 'terminal'] as const).map(mode => <Pressable key={mode} testID={`chat-mode-${mode}`} accessibilityRole="radio" accessibilityLabel={mode === 'chat' ? 'Chat' : 'Terminal'} accessibilityState={{ checked: conversation?.active === mode, disabled: busy || !chat.connected || transitioning || !chat.view?.available || conversation?.active === 'stopped' }} disabled={busy || !chat.connected || transitioning || !chat.view?.available || conversation?.active === 'stopped'} onPress={() => { void Haptics.selectionAsync(); void change(mode); }} style={({ pressed }) => [styles.segment, { backgroundColor: conversation?.active === mode ? theme.colors.background : 'transparent', opacity: pressed ? 0.7 : 1 }]}>
          <Icon ios={mode === 'chat' ? 'bubble.left' : 'apple.terminal'} android={mode === 'chat' ? 'chat_bubble_outline' : 'terminal'} size={16} color={conversation?.active === mode ? theme.colors.text : theme.colors.textSecondary} />
          <Text variant="callout" tone={conversation?.active === mode ? 'primary' : 'secondary'}>{mode === 'chat' ? 'Chat' : 'Terminal'}</Text>
        </Pressable>)}
      </View>
    </View>}
    {chat.view?.identificationRequired && <ChatButton testID="chat-identify-open" title="Connect Chat to this conversation" onPress={() => setIdentifying(true)} />}
    <ComposerSheet visible={identifying && !!chat.view?.identificationRequired} onClose={() => setIdentifying(false)} testID="chat-identification">
      <View style={styles.identification}><Text>Run /status in this tab when its composer is ready. Enter its Session ID and server socket once.</Text>
      <TextInput accessibilityLabel="Codex Session ID" placeholder="Session ID" placeholderTextColor={theme.colors.textSecondary} style={{ color: theme.colors.text }} value={nativeId} onChangeText={setNativeId} autoCapitalize="none" autoCorrect={false} editable={!busy} />
      <TextInput accessibilityLabel="Codex server socket" placeholder="Server socket" placeholderTextColor={theme.colors.textSecondary} style={{ color: theme.colors.text }} value={socketPath} onChangeText={setSocketPath} autoCapitalize="none" autoCorrect={false} editable={!busy} />
      <ChatButton testID="chat-identify-submit" title="Connect conversation" disabled={busy || !chat.connected || !nativeId.trim() || !socketPath.trim()} onPress={() => { setBusy(true); void chat.identify(nativeId, socketPath).finally(() => setBusy(false)); }} />
      {chat.error && <Text tone="danger">{chat.error}</Text>}</View>
    </ComposerSheet>
    {conversation?.pendingSwitch && <ChatButton testID="chat-cancel-switch" title="Cancel pending switch" disabled={busy || !chat.connected} onPress={() => void change(conversation.active === 'chat' ? 'chat' : 'terminal')} />}
    {busy && <Text accessibilityLiveRegion="polite" variant="footnote" tone="secondary">Preparing conversation…</Text>}
    {conversation?.transferNotice && <Text accessibilityLiveRegion="polite" variant="footnote" tone="secondary">{conversation.transferNotice}</Text>}
  </View>;
}
const styles = StyleSheet.create({ identification: { padding: 16, gap: 16 }, root: { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, gap: 6 }, row: { flexDirection: 'row', alignItems: 'center', gap: 8 }, status: { flex: 1 }, switch: { flexDirection: 'row', padding: 2, gap: 2, borderRadius: 10 }, segment: { minHeight: 44, minWidth: 44, paddingHorizontal: 14, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 } });
