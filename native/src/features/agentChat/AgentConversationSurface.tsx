import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import type { TerminalPanelState, ToolPanel } from '@shared/types/panels';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

import { AgentChatPanel } from './AgentChatPanel';
import { AgentModeBar } from './AgentModeBar';
import { useAgentChat } from './useAgentChat';

/** Mount exactly one input surface for the owner reported by the host. */
export function AgentConversationSurface({ panel, draft, onChangeDraft, confirmDraft, children }: { panel: ToolPanel; draft: string; onChangeDraft: (text: string) => void; confirmDraft: () => void; children: ReactNode }) {
  const chat = useAgentChat(panel.id);
  const theme = useTheme();
  // The panel snapshot prevents a terminal attach while Chat history is loading.
  const state = panel.state.customState as TerminalPanelState | undefined;
  const conversation = chat.view?.conversation ?? state?.agentChat?.conversation;
  const showChat = conversation && conversation.active !== 'terminal';
  return <View style={styles.fill}>
    {(conversation || chat.view?.available || chat.view?.identificationRequired) && <AgentModeBar chat={chat} />}
    {showChat ? <AgentChatPanel chat={chat} draft={draft} onChangeDraft={onChangeDraft} confirmDraft={confirmDraft} /> : <View style={styles.fill}>
      {children}
      {chat.error && <Text testID="chat-switch-error" variant="footnote" tone="danger" style={styles.error}>{chat.error}</Text>}
      {conversation?.transition && <View testID="chat-switching" style={[StyleSheet.absoluteFill, styles.transition, { backgroundColor: theme.colors.background }]}><ActivityIndicator color={theme.colors.textMuted} /><Text tone="secondary">Switching interface…</Text></View>}
    </View>}
  </View>;
}
const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 }, transition: { alignItems: 'center', justifyContent: 'center', gap: 12 }, error: { padding: 12 } });
