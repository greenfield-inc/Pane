import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { COMPOSER_MENU_TEXT, commandLabel, commandRows, matchedParts, type ComposerTrigger } from '@shared/composerMentions';
import type { ChatTabClient, ChatTabCommand, ChatTabFile, ChatTabView } from '@shared/types/chatTab';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { useFileRows } from './useFileRows';

export type ChatMenuPick = { file: ChatTabFile } | { command: ChatTabCommand };

const ICONS = {
  file: { ios: 'doc', android: 'draft' },
  folder: { ios: 'folder', android: 'folder' },
  skill: { ios: 'sparkle', android: 'auto_awesome' },
  command: { ios: 'terminal', android: 'terminal' },
} as const;

function Matched({ text, query }: { text: string; query: string }) {
  const { chat } = useTheme();
  return <Text variant="subhead" numberOfLines={1} style={[styles.name, { color: chat.foreground }]}>
    {matchedParts(text, query).map((part, index) => part.matched ? <Text key={index} variant="subhead" style={{ color: chat.foreground, fontWeight: '700' }}>{part.text}</Text> : part.text)}
  </Text>;
}

function Row({ testID, label, icon, onPress, children }: { testID: string; label: string; icon: keyof typeof ICONS; onPress: () => void; children: ReactNode }) {
  const { chat } = useTheme();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: chat.muted }]}>
    <View style={styles.icon}><Icon {...ICONS[icon]} size={16} color={chat.mutedForeground} /></View>
    {children}
  </Pressable>;
}

function FileRow({ file, query, onPick }: { file: ChatTabFile; query: string; onPick: (pick: ChatMenuPick) => void }) {
  const { chat } = useTheme();
  const parts = file.path.split('/');
  const name = `${parts.pop() ?? file.path}${file.isDirectory ? '/' : ''}`;
  const parent = parts.join('/');
  return <Row testID={`chat-file-${file.path}`} label={[name, parent, file.changed && 'Changed'].filter(Boolean).join(', ')} icon={file.isDirectory ? 'folder' : 'file'} onPress={() => onPick({ file })}>
    <Matched text={name} query={query} />
    <Text variant="footnote" numberOfLines={1} style={[styles.detail, { color: chat.mutedForeground }]}>{parent}</Text>
    {file.changed && <Text variant="footnote" style={{ color: chat.mutedForeground }}>Changed</Text>}
  </Row>;
}

function CommandRow({ command, trigger, onPick }: { command: ChatTabCommand; trigger: ComposerTrigger; onPick: (pick: ChatMenuPick) => void }) {
  const { chat } = useTheme();
  const label = commandLabel(trigger, command);
  return <Row testID={`chat-command-${label.slice(1)}`} label={command.description ? `${label}, ${command.description}` : label} icon={command.skill ? 'skill' : 'command'} onPress={() => onPick({ command })}>
    <Matched text={label} query={trigger.query} />
    <Text variant="footnote" numberOfLines={1} style={[styles.detail, { color: chat.mutedForeground }]}>{command.description ?? ''}</Text>
  </Row>;
}

/** The menu above the message box: the tab's files and folders for @, the agent's skills and commands for $ and /. */
export function ChatCommandList({ chat, panelId, trigger, view, onPick }: {
  chat: ChatTabClient;
  panelId: string;
  trigger: ComposerTrigger | null;
  view: ChatTabView | undefined;
  onPick: (pick: ChatMenuPick) => void;
}) {
  const theme = useTheme();
  const files = useFileRows(chat, panelId, view?.mentions?.files ? trigger : null);
  if (!trigger || !view) return null;
  let rows: ReactNode[] = [];
  let note: string | undefined;
  if (trigger.kind === 'file') {
    if (!view.mentions?.files) return null;
    if (files.state === 'ready') rows = files.files.map(file => <FileRow key={`${file.path}:${file.isDirectory}`} file={file} query={trigger.query} onPick={onPick} />);
    if (!rows.length) note = files.state === 'searching' ? COMPOSER_MENU_TEXT.searchingFiles : files.state === 'failed' ? COMPOSER_MENU_TEXT.filesFailed : COMPOSER_MENU_TEXT.noFiles;
  } else {
    const commands = commandRows(trigger, view.commands, view.mentions);
    if (!commands) return null;
    rows = commands.map(command => <CommandRow key={command.name} command={command} trigger={trigger} onPick={onPick} />);
    if (!rows.length) note = view.status === 'starting' && !view.commands.length ? COMPOSER_MENU_TEXT.loadingSkills : COMPOSER_MENU_TEXT.noSkills;
  }
  return <ScrollView testID="chat-commands" accessibilityLabel={trigger.kind === 'file' ? 'Files and folders' : trigger.kind === 'skill' ? 'Skills' : 'Agent commands'} keyboardShouldPersistTaps="always"
    style={[styles.list, { backgroundColor: theme.chat.card, borderColor: theme.chat.border }]}>
    {note ? <Text testID="chat-menu-note" accessibilityLiveRegion="polite" variant="subhead" style={[styles.note, { color: theme.chat.mutedForeground }]}>{note}</Text> : rows}
  </ScrollView>;
}

const styles = StyleSheet.create({
  list: { maxHeight: 264, flexGrow: 0, borderWidth: 1, borderRadius: 12, paddingVertical: 4 },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6 },
  icon: { width: 20, alignItems: 'center' },
  name: { flexShrink: 0, maxWidth: '65%' },
  detail: { flex: 1, minWidth: 0 },
  note: { minHeight: 44, lineHeight: 20, paddingHorizontal: 12, paddingVertical: 12 },
});
