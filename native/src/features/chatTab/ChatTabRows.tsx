import { useEffect, useState, type ReactNode } from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import type { PlanEntry, StepGroup, WorkerNote } from '@shared/chatTabPresentation';
import { describeChatContent } from '@shared/agentChatPresentation';
import { imageOf, planEntryKeys } from '@shared/chatTabPresentation';
import { userMarkdown } from '@shared/chatTabMarkdown';

import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import type { ChatRow } from './chatRows';

export interface ChatRowActions {
  onToggleTurn: (turnId: string) => void;
  /** Opens the phone's Diff view; a diff never renders in the thread by itself. */
  onViewDiff?: (path: string) => void;
  onOpenWorker?: (paneId: string) => void;
  /** Draws a `block` row (a fenced block in a language the screen registered). */
  renderBlock?: (language: string, content: string) => ReactNode;
}

function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  const content = useMarkdown(text, { colorScheme: theme.scheme, styles: {
    text: { color: theme.chat.foreground, fontSize: 16, lineHeight: 24 },
    link: { color: theme.chat.foreground, textDecorationLine: 'underline' },
    codespan: { color: theme.chat.foreground, backgroundColor: theme.chat.muted, fontFamily: monoFontFamily },
    code: { backgroundColor: theme.chat.muted, borderRadius: 8, padding: 10 },
    codeText: { color: theme.chat.foreground, fontSize: 12, fontFamily: monoFontFamily },
    paragraph: { marginTop: 0, marginBottom: 10 },
  } });
  return <View>{content}</View>;
}

/** Copies a message as Markdown; the icon turns into a check for a moment (D-140). */
function CopyAction({ label, text, testID }: { label: string; text: string; testID: string }) {
  const theme = useTheme();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const done = state === 'copied';
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={done ? 'Copied' : undefined}
    onPress={() => { Clipboard.setStringAsync(text).then(() => setState('copied'), () => setState('failed')); }} hitSlop={6} style={styles.copy}>
    <Icon ios={done ? 'checkmark' : state === 'failed' ? 'xmark' : 'doc.on.doc'} android={done ? 'check' : state === 'failed' ? 'close' : 'content_copy'} size={15}
      color={done ? theme.colors.success : state === 'failed' ? theme.colors.danger : theme.chat.mutedForeground} />
  </Pressable>;
}

/** Rendered Markdown isn't selectable on the phone; a long press copies the text and says how it went, with when it was written (D-202). */
function LongPressCopy({ text, at }: { text: string; at?: string }) {
  const theme = useTheme();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  return <Pressable accessibilityHint="Long press to copy" delayLongPress={400}
    onLongPress={() => { Clipboard.setStringAsync(text).then(() => setState('copied'), () => setState('failed')); }}>
    <Markdown text={text} />
    {state !== 'idle' && <Text accessibilityLiveRegion="polite" variant="footnote" style={{ color: state === 'copied' ? theme.colors.success : theme.colors.danger }}>{[state === 'copied' ? 'Copied' : 'Could not copy', at].filter(Boolean).join(' · ')}</Text>}
  </Pressable>;
}

/** A long press on the person's message shows when it was sent (D-202); its Copy button copies it. */
function UserBubble({ children, at }: { children: ReactNode; at?: string }) {
  const theme = useTheme();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), 3000);
    return () => clearTimeout(timer);
  }, [shown]);
  return <Pressable testID="chat-user-message" accessibilityHint={at ? 'Long press to see when it was sent' : undefined} delayLongPress={400} onLongPress={() => setShown(!!at)}>
    <View style={[styles.user, { backgroundColor: theme.chat.muted }]}>{children}</View>
    {shown && <Text accessibilityLiveRegion="polite" variant="footnote" style={{ color: theme.chat.mutedForeground, textAlign: 'right' }}>{at}</Text>}
  </Pressable>;
}

const STEP_ICONS = {
  explore: { ios: 'eye', android: 'visibility' },
  edit: { ios: 'pencil', android: 'edit' },
  run: { ios: 'apple.terminal', android: 'terminal' },
  think: { ios: 'brain', android: 'psychology' },
  other: { ios: 'wrench.and.screwdriver', android: 'build' },
} as const;
const VERBS = { explore: ['Exploring', 'Explored'], edit: ['Edit', 'Edited'], run: ['Run', 'Ran'], think: ['Thinking', 'Thought'], other: ['Using', 'Used'] } as const;

function StepLine({ group, actions }: { group: StepGroup; actions: ChatRowActions }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const running = group.steps.some(step => step.status === 'pending' || step.status === 'in_progress');
  const failed = group.steps.some(step => step.status === 'failed');
  const single = group.steps.length === 1 ? group.steps[0] : undefined;
  const label = group.kind === 'run' && single ? single.command ?? group.label : group.label;
  const output = single?.output;
  const icon = STEP_ICONS[group.kind];
  return <View testID={`chat-step-${group.kind}`}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${VERBS[group.kind][running ? 0 : 1]} ${label}`} accessibilityState={{ expanded: open }} disabled={!output && group.steps.length < 2} onPress={() => setOpen(!open)} style={styles.stepLine}>
      <View style={styles.stepIcon}><Icon ios={failed ? 'xmark.circle' : icon.ios} android={failed ? 'cancel' : icon.android} size={15} color={failed ? theme.colors.danger : theme.chat.mutedForeground} /></View>
      <Text variant="subhead" style={[styles.verb, { color: theme.chat.foreground }]}>{VERBS[group.kind][running ? 0 : 1]}</Text>
      <Text variant="subhead" numberOfLines={1} style={[styles.stepLabel, { color: theme.chat.mutedForeground, fontFamily: group.kind === 'run' || group.kind === 'edit' ? monoFontFamily : undefined }]}>{label}</Text>
      {group.kind === 'edit' && (group.added > 0 || group.removed > 0) && <Text variant="footnote" style={{ color: theme.colors.success }}>+{group.added} <Text variant="footnote" style={{ color: theme.colors.danger }}>−{group.removed}</Text></Text>}
      {group.kind === 'edit' && group.steps[0].path && actions.onViewDiff && <Pressable testID="chat-view-diff" accessibilityRole="button" onPress={() => actions.onViewDiff!(group.steps[0].path!)} hitSlop={10}><Text variant="footnote" style={{ color: theme.colors.accentText }}>View diff</Text></Pressable>}
    </Pressable>
    {(running && output) || open ? <View style={styles.details}>
      {group.steps.length > 1 && group.steps.map(step => <Text key={step.id} variant="footnote" numberOfLines={1} style={{ color: theme.chat.mutedForeground, fontFamily: monoFontFamily }}>{step.kind === 'run' ? step.command : step.path ?? step.title}</Text>)}
      {output ? <Text selectable variant="caption" style={[styles.output, { color: theme.chat.foreground, backgroundColor: theme.chat.muted, fontFamily: monoFontFamily }]}>{running ? output.split('\n').slice(-8).join('\n') : output.slice(0, 8000)}</Text> : null}
    </View> : null}
  </View>;
}

function Todo({ entries }: { entries: PlanEntry[] }) {
  const theme = useTheme();
  const keys = planEntryKeys(entries);
  return <View testID="chat-todo" style={[styles.card, { borderColor: theme.chat.border }]}>
    <Text variant="subhead" style={{ color: theme.chat.foreground, fontWeight: '600' }}>To-do · {entries.filter(entry => entry.status === 'completed').length} of {entries.length} done</Text>
    {entries.map((entry, position) => <View key={keys[position]} style={styles.todoRow}>
      <Icon ios={entry.status === 'completed' ? 'checkmark.circle' : 'circle'} android={entry.status === 'completed' ? 'check_circle' : 'radio_button_unchecked'} size={16} color={theme.chat.mutedForeground} />
      <Text variant="subhead" style={{ color: entry.status === 'completed' ? theme.chat.mutedForeground : theme.chat.foreground, textDecorationLine: entry.status === 'completed' ? 'line-through' : 'none', flex: 1 }}>{entry.content}</Text>
    </View>)}
  </View>;
}

/** A worker the latest turn has news of, as one compact line with Open (D-201). */
function WorkerNoteRow({ note, onOpen }: { note: WorkerNote; onOpen?: (paneId: string) => void }) {
  const theme = useTheme();
  const { worker } = note;
  return <View testID={`chat-worker-${worker.paneId}`} style={styles.stepLine}>
    <Text variant="subhead" numberOfLines={1} style={{ color: worker.state === 'waiting' ? theme.colors.warning : theme.chat.mutedForeground, flexShrink: 1 }}>{note.text}</Text>
    {onOpen && worker.state !== 'missing' && <Pressable testID={`chat-worker-open-${worker.paneId}`} accessibilityRole="button" accessibilityLabel={`Open ${worker.name}`} onPress={() => onOpen(worker.paneId)} hitSlop={10}><Text variant="subhead" style={{ color: theme.colors.accentText }}>Open</Text></Pressable>}
  </View>;
}

export function ChatRowView({ row, actions }: { row: ChatRow; actions: ChatRowActions }) {
  const theme = useTheme();
  switch (row.kind) {
    case 'user': {
      const copy = userMarkdown({ id: row.key, user: row.message, items: [], running: false });
      return <View style={styles.userRow}>
        <UserBubble at={row.at}>{row.message.parts.map((part, index) => {
          if (part.type === 'text') return <Text key={index} style={{ color: theme.chat.foreground }}>{part.text}</Text>;
          const picture = part.type === 'content' ? imageOf(part.content) : undefined;
          return picture ? <Image key={index} accessibilityLabel="Attached image" source={{ uri: `data:${picture.mimeType};base64,${picture.data}` }} style={styles.image} /> : null;
        })}</UserBubble>
        {copy ? <CopyAction testID="chat-copy-message" label="Copy message" text={copy} /> : null}
      </View>;
    }
    case 'text': return <LongPressCopy text={row.text} at={row.at} />;
    case 'time': return <Text testID="chat-turn-time" accessibilityLabel={row.full} variant="footnote" style={{ color: theme.chat.mutedForeground }}>{row.short}</Text>;
    case 'copy': return <CopyAction testID="chat-copy-response" label="Copy response" text={row.text} />;
    case 'thought': return <Text variant="footnote" style={{ color: theme.chat.mutedForeground }} numberOfLines={3}>Thinking: {row.text}</Text>;
    case 'image': return <Image accessibilityLabel="Image from the agent" source={{ uri: `data:${row.mimeType};base64,${row.data}` }} style={styles.image} />;
    case 'steps': return <StepLine group={row.group} actions={actions} />;
    case 'fold': return <Pressable testID="chat-fold" accessibilityRole="button" accessibilityState={{ expanded: row.open }} disabled={!row.expandable} onPress={() => actions.onToggleTurn(row.turnId)} style={styles.stepLine}>
      {/* The icon box stays after the turn ends, so the summary never shifts. */}
      <View style={styles.stepIcon}>{row.waiting
        ? <Icon ios="exclamationmark.shield" android="shield" size={15} color={theme.colors.warning} />
        : row.running ? <ActivityIndicator size="small" color={theme.chat.mutedForeground} /> : null}</View>
      <Text variant="subhead" numberOfLines={1} style={{ color: theme.chat.mutedForeground, flexShrink: 1 }}>{row.summary}</Text>
      {row.expandable && <Icon ios={row.open ? 'chevron.down' : 'chevron.right'} android={row.open ? 'expand_more' : 'chevron_right'} size={13} color={theme.chat.mutedForeground} />}
    </Pressable>;
    case 'plan': return <Todo entries={row.entries} />;
    case 'stopped': return <Text variant="footnote" style={{ color: theme.chat.mutedForeground, fontStyle: 'italic' }}>{row.text}</Text>;
    case 'worker': return <WorkerNoteRow note={row.note} onOpen={actions.onOpenWorker} />;
    case 'block': return actions.renderBlock?.(row.language, row.content) ?? <Markdown text={`\`\`\`${row.language}\n${row.content}\`\`\``} />;
    case 'notice': return <Text testID="chat-notice" variant="footnote" style={[styles.notice, { color: theme.chat.mutedForeground }]}>{row.text}</Text>;
    case 'content': return <Text variant="footnote" numberOfLines={2} style={{ color: theme.chat.mutedForeground }}>{describeChatContent(row.content).label}</Text>;
  }
}

const styles = StyleSheet.create({
  userRow: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '88%', gap: 2 },
  user: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, gap: 6 },
  copy: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  image: { width: 220, height: 160, borderRadius: 10, resizeMode: 'cover' },
  stepLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  stepIcon: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  verb: { fontWeight: '600' },
  stepLabel: { flexShrink: 1 },
  details: { marginLeft: 26, gap: 4, paddingBottom: 6 },
  output: { padding: 8, borderRadius: 8, overflow: 'hidden' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6 },
  todoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  notice: { alignSelf: 'center', textAlign: 'center', paddingVertical: 2 },
});
