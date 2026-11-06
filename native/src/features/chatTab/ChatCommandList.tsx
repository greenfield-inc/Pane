import { Pressable, ScrollView, StyleSheet } from 'react-native';

import type { ChatTabCommand } from '@shared/types/chatTab';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

/** The agent's own commands and skills matching the draft, from its available_commands update. */
export function ChatCommandList({ commands, onPick }: { commands: readonly ChatTabCommand[]; onPick: (command: ChatTabCommand) => void }) {
  const theme = useTheme();
  if (!commands.length) return null;
  return <ScrollView testID="chat-commands" accessibilityLabel="Agent commands" keyboardShouldPersistTaps="handled"
    style={[styles.list, { backgroundColor: theme.chat.card, borderColor: theme.chat.border }]}>
    {commands.map(command => <Pressable key={command.name} testID={`chat-command-${command.name}`} accessibilityRole="button"
      accessibilityLabel={command.description ? `/${command.name}, ${command.description}` : `/${command.name}`}
      onPress={() => onPick(command)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.chat.muted }]}>
      <Text variant="subhead" style={{ color: theme.chat.foreground }}>/{command.name}</Text>
      {command.description && <Text numberOfLines={2} variant="footnote" style={{ color: theme.chat.mutedForeground }}>{command.description}</Text>}
    </Pressable>)}
  </ScrollView>;
}

const styles = StyleSheet.create({
  list: { maxHeight: 240, borderWidth: 1, borderRadius: 12 },
  row: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 6 },
});
