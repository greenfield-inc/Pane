import * as Haptics from 'expo-haptics';
import { StyleSheet, View } from 'react-native';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { Button, Text } from '@/ui';

import { useMachineNotifyCommand, useNotifyCommand } from './hooks';
import type { AgentPromptItem } from './notifyQuestions';

/**
 * Yes and No under a "Waiting on you" row for an agent's terminal prompt; its other choices are
 * in the question's sheet. `machine` is another saved machine the prompt is on, answered there
 * without switching. An offline machine or a prompt only its terminal can answer now gets a line
 * saying so instead of buttons.
 */
export function AgentPromptActions({ item, machine, offline, inset = 36 }: {
  item: AgentPromptItem;
  /** Lines the buttons up with the row's title, past its status dot. */
  inset?: number;
  machine?: RemotePaneConnectionProfile | null;
  /** The name of the prompt's machine while the phone can't reach it. */
  offline?: string;
}) {
  const onAccepted = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  const live = useNotifyCommand(onAccepted);
  const remote = useMachineNotifyCommand(machine ?? null, onAccepted);
  const command = machine ? remote : live;
  const agent = item.source.agent;

  if (offline) {
    return <Line inset={inset} testID={`agent-prompt-offline-${item.id}`} text={`${offline} is offline. ${agent} is still waiting there; answer when it's back or in the terminal.`} />;
  }
  if (item.agentPrompt.inTerminal) {
    return <Line inset={inset} testID={`agent-prompt-in-terminal-${item.id}`} text={`${agent} is asking in the terminal now. Open the Pane to answer.`} />;
  }
  const answer = (choice: string) => command.mutate([{ type: 'answer', id: item.id, answer: { choice } }]);
  const sending = command.isPending ? command.variables[0] : undefined;
  const sendingChoice = sending?.type === 'answer' && 'choice' in sending.answer ? sending.answer.choice : undefined;
  return (
    <View style={[styles.actions, { paddingLeft: inset }]}>
      <View style={styles.buttons}>
        <View style={styles.button}>
          <Button testID={`agent-prompt-yes-${item.id}`} title="Yes" loading={sendingChoice === item.agentPrompt.yes} disabled={command.isPending} onPress={() => answer(item.agentPrompt.yes)} />
        </View>
        <View style={styles.button}>
          <Button testID={`agent-prompt-no-${item.id}`} title="No" variant="secondary" loading={sendingChoice === item.agentPrompt.no} disabled={command.isPending} onPress={() => answer(item.agentPrompt.no)} />
        </View>
      </View>
      {command.isError ? <Text testID={`agent-prompt-error-${item.id}`} variant="footnote" tone="danger">{command.error.message}</Text> : null}
    </View>
  );
}

function Line({ text, testID, inset }: { text: string; testID: string; inset: number }) {
  return (
    <View style={[styles.actions, { paddingLeft: inset }]}>
      <Text testID={testID} variant="subhead" tone="secondary">{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 6, paddingRight: 12, paddingBottom: 12 },
  buttons: { flexDirection: 'row', gap: 10 },
  button: { flex: 1, maxWidth: 160 },
});
