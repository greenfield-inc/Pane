import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { nextOrchestrationSessionName } from '@shared/types/orchestrationSession';
import { DEFAULT_PANE_CHAT_AGENT, PANE_CHAT_AGENT_LABELS, type PaneChatAgent } from '@shared/types/paneChat';
import { RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { RemotePwaAffordances, RemotePwaSessionAgents } from '@shared/types/remoteDaemon';

import { useInvokeQuery } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { DialogSection, DialogSheet, Notice, SheetButton } from '../panes/PaneKit';
import { useCreateSession, useSessions } from './hooks';

/** Older hosts do not report their agents; the host still rejects one it cannot run. */
const ALL_AGENTS: RemotePwaSessionAgents = { agents: ['claude', 'codex', 'cursor'], defaultAgent: DEFAULT_PANE_CHAT_AGENT };

/** Desktop's Create Session dialog: an optional name and the agent, then the new Session's chat opens. */
export function CreateSessionSheet() {
  const theme = useTheme();
  const sessions = useSessions();
  const affordances = useInvokeQuery<RemotePwaAffordances>('remote:pwa-affordances', [], { staleTime: 5 * 60_000 });
  const { create, isPending } = useCreateSession();
  const [name, setName] = useState('');
  // Follows the host default, which can arrive after the sheet opens, until the person picks one.
  const [pickedAgent, setPickedAgent] = useState<PaneChatAgent>();
  const [error, setError] = useState<string>();
  const sessionAgents = affordances.data?.sessionAgents ?? ALL_AGENTS;
  const agent = pickedAgent ?? sessionAgents.defaultAgent;
  const defaultName = nextOrchestrationSessionName(sessions.data?.sessions ?? []);

  const submit = async () => {
    if (isPending) return;
    setError(undefined);
    try {
      const view = await create({ name: name.trim() || defaultName, agent });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
      router.push({ pathname: '/session/[sessionId]', params: { sessionId: view.session.id } });
    } catch (createError) {
      setError(createError instanceof RemoteUnconfirmedResultError
        ? 'The connection dropped before the host answered. Check the Sessions list before trying again: the Session may already exist.'
        : (createError as Error).message);
    }
  };

  return (
    <DialogSheet
      testID="new-session-sheet"
      title="Create Session"
      onClose={() => router.back()}
      closeDisabled={isPending}
      footer={
        <>
          <SheetButton testID="new-session-cancel" title="Cancel" disabled={isPending} onPress={() => router.back()} />
          <SheetButton
            testID="new-session-create"
            variant="primary"
            title={isPending ? 'Creating…' : 'Create Session'}
            disabled={isPending}
            onPress={() => void submit()}
            style={styles.create}
          />
        </>
      }
    >
      <DialogSection>
        <Text variant="callout" style={styles.bold}>Name your chat (optional)</Text>
        <TextInput
          testID="new-session-name"
          accessibilityLabel="Name your chat (optional)"
          value={name}
          placeholder={defaultName}
          placeholderTextColor={theme.colors.textMuted}
          selectionColor={theme.colors.accent}
          returnKeyType="done"
          onChangeText={setName}
          onSubmitEditing={() => void submit()}
          style={[theme.typography.body, styles.field, {
            color: theme.colors.text,
            borderRadius: theme.radius.md,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surfaceRaised,
          }]}
        />
      </DialogSection>

      <DialogSection divided={Boolean(error)}>
        <Text variant="callout" style={styles.bold}>Choose an agent</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Session agent" style={styles.agents}>
          {sessionAgents.agents.map(option => {
            const selected = option === agent;
            return (
              <Pressable
                key={option}
                testID={`new-session-agent-${option}`}
                accessibilityRole="radio"
                accessibilityLabel={PANE_CHAT_AGENT_LABELS[option]}
                accessibilityState={{ selected }}
                onPress={() => setPickedAgent(option)}
                style={({ pressed }) => [styles.agent, {
                  borderRadius: theme.radius.md,
                  borderColor: selected ? theme.colors.accent : theme.colors.border,
                  backgroundColor: selected ? theme.colors.selected : pressed ? theme.colors.surfacePressed : theme.colors.surface,
                }]}
              >
                <Icon ios="bubble.left" android="chat_bubble" size={16} />
                <Text variant="callout" tone={selected ? 'primary' : 'secondary'} style={styles.fill}>{PANE_CHAT_AGENT_LABELS[option]}</Text>
                {option === sessionAgents.defaultAgent ? <Text variant="footnote" tone="muted">Default</Text> : null}
              </Pressable>
            );
          })}
        </View>
      </DialogSection>

      {error ? <View style={styles.error}><Notice testID="new-session-error" danger message={error} /></View> : null}
    </DialogSheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bold: { fontWeight: '600' },
  // h-12 rounded-md border bg-surface-secondary px-3.
  field: { height: 48, paddingHorizontal: 12, borderWidth: 1 },
  agents: { gap: 8 },
  agent: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 12, borderWidth: 1 },
  error: { paddingHorizontal: 20, paddingBottom: 20 },
  create: { paddingHorizontal: 20 },
});
