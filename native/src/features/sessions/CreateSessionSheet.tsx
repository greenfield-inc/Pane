import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import {
  nextOrchestrationSessionName,
  type OrchestrationSessionCreateInput,
  type OrchestrationSessionListResult,
  type OrchestrationSessionView,
} from '@shared/types/orchestrationSession';
import { DEFAULT_PANE_CHAT_AGENT, PANE_CHAT_AGENT_LABELS, type PaneChatAgent } from '@shared/types/paneChat';
import type { RemotePaneConnectionProfile, RemotePwaAffordances, RemotePwaSessionAgents } from '@shared/types/remoteDaemon';

import { useDaemon } from '@/daemon';
import { CREATE_ON_MACHINE, CREATE_TIMEOUT_MS, useMachineCommand, useMachineQuery } from '@/daemon/machines';
import { Notice } from '@/features/panes/PaneKit';
import { useTheme } from '@/theme';
import { Button, Icon, Text } from '@/ui';

import { sessionsUnavailable } from './hooks';

/** Older hosts do not report their agents; the host still rejects one it cannot run. */
const ALL_AGENTS: RemotePwaSessionAgents = { agents: ['claude', 'codex', 'cursor'], defaultAgent: DEFAULT_PANE_CHAT_AGENT };

/**
 * Desktop's Create Session dialog for any saved machine: an optional name and that machine's
 * agents. Create goes to that machine.
 */
export function CreateSessionForm({ machine, onCreated }: { machine: RemotePaneConnectionProfile; onCreated: (sessionId: string) => void }) {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { profile: current } = useDaemon();
  const sessions = useMachineQuery<OrchestrationSessionListResult>(machine, 'orchestration-sessions:list', [], { retry: false });
  const affordances = useMachineQuery<RemotePwaAffordances>(machine, 'remote:pwa-affordances', [], { staleTime: 5 * 60_000 });
  const send = useMachineCommand();
  const create = useMutation({
    mutationKey: CREATE_ON_MACHINE,
    mutationFn: (input: OrchestrationSessionCreateInput) => send<OrchestrationSessionView<{ id: string; name: string }>>(
      machine,
      'orchestration-sessions:create',
      [input],
      `The connection dropped before ${machine.label} answered. Check its Sessions before trying again: the Session may already exist.`,
      CREATE_TIMEOUT_MS,
    ),
    onSuccess: view => {
      // The Session opens without another fetch on the machine the phone is on.
      if (machine.id === current.id) queryClient.setQueryData([machine.id, 'orchestration-sessions:get', { sessionId: view.session.id }], view);
      onCreated(view.session.id);
    },
    // Created, refused or unconfirmed: read that machine again, so its lists show whether the Session exists.
    onSettled: () => queryClient.invalidateQueries({ queryKey: [machine.id] }),
  });
  const [name, setName] = useState('');
  // Follows the host default, which can arrive after the sheet opens, until the person picks one.
  const [pickedAgent, setPickedAgent] = useState<PaneChatAgent>();
  const sessionAgents = affordances.data?.sessionAgents ?? ALL_AGENTS;
  const agent = pickedAgent ?? sessionAgents.defaultAgent;
  const defaultName = nextOrchestrationSessionName(sessions.data?.sessions ?? []);

  const submit = () => {
    if (create.isPending) return;
    create.mutate({ name: name.trim() || defaultName, agent });
  };

  if (sessionsUnavailable(sessions.error)) {
    return <Notice testID="new-session-unavailable" message={`${machine.label} runs an older Pane without Sessions. Update Pane there, or start a Pane instead.`} />;
  }

  return (
    <View testID="new-session-sheet" style={styles.form}>
      <View style={styles.section}>
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
          onSubmitEditing={submit}
          style={[theme.typography.body, styles.field, {
            color: theme.colors.text,
            borderRadius: theme.radius.md,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surfaceRaised,
          }]}
        />
      </View>

      <View style={styles.section}>
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
      </View>

      {/* An unconfirmed create says to check the list before trying again. */}
      {create.isError ? <Notice testID="new-session-error" danger message={create.error.message} /> : null}
      <Button
        testID="new-session-create"
        title={create.isPending ? 'Starting…' : `Start Session on ${machine.label}`}
        loading={create.isPending}
        onPress={submit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bold: { fontWeight: '600' },
  form: { gap: 20 },
  section: { gap: 8 },
  // h-12 rounded-md border bg-surface-secondary px-3.
  field: { height: 48, paddingHorizontal: 12, borderWidth: 1 },
  agents: { gap: 8 },
  agent: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 12, borderWidth: 1 },
});
