import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import type { ChatStep, ChatWorkerLine, PlanEntry, StepGroup } from '@shared/chatTabPresentation';
import { describeChatContent } from '@shared/agentChatPresentation';
import { imageOf } from '@shared/chatTabPresentation';

import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import type { ChatRow } from './chatRows';

export interface ChatRowActions {
  onToggleTurn: (turnId: string) => void;
  /** Opens the phone's Diff view; a diff never renders in the thread by itself. */
  onViewDiff?: (path: string) => void;
  onOpenWorker?: (paneId: string) => void;
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

function CurrentStep({ step }: { step: ChatStep }) {
  const group: StepGroup = { id: step.id, kind: step.kind, label: step.path?.split(/[\\/]/).pop() ?? step.title, added: step.added ?? 0, removed: step.removed ?? 0, steps: [step] };
  return <StepLine group={group} actions={{ onToggleTurn: () => undefined }} />;
}

function Todo({ entries }: { entries: PlanEntry[] }) {
  const theme = useTheme();
  return <View testID="chat-todo" style={[styles.card, { borderColor: theme.chat.border }]}>
    <Text variant="subhead" style={{ color: theme.chat.foreground, fontWeight: '600' }}>To-do · {entries.filter(entry => entry.status === 'completed').length} of {entries.length} done</Text>
    {entries.map((entry, index) => <View key={index} style={styles.todoRow}>
      <Icon ios={entry.status === 'completed' ? 'checkmark.circle' : 'circle'} android={entry.status === 'completed' ? 'check_circle' : 'radio_button_unchecked'} size={16} color={theme.chat.mutedForeground} />
      <Text variant="subhead" style={{ color: entry.status === 'completed' ? theme.chat.mutedForeground : theme.chat.foreground, textDecorationLine: entry.status === 'completed' ? 'line-through' : 'none', flex: 1 }}>{entry.content}</Text>
    </View>)}
  </View>;
}

const WORKER_COLORS = { running: 'accentText', waiting: 'warning', done: 'success', failed: 'danger', missing: 'danger', idle: 'textSecondary' } as const;

/** A Session worker as one line: state, PR or what it does, and Open (round 3 · A). */
function WorkerRow({ worker, onOpen }: { worker: ChatWorkerLine; onOpen?: (paneId: string) => void }) {
  const theme = useTheme();
  const color = theme.colors[WORKER_COLORS[worker.state]];
  return <View testID={`chat-worker-${worker.paneId}`} style={[styles.worker, { borderColor: theme.chat.border }]}>
    <Icon ios="apple.terminal" android="terminal" size={15} color={theme.chat.mutedForeground} />
    <View style={styles.workerText}>
      <Text variant="subhead" numberOfLines={1} style={{ color: theme.chat.foreground, fontWeight: '600' }}>{worker.name}</Text>
      <Text variant="footnote" numberOfLines={1} style={{ color: theme.chat.mutedForeground }}><Text variant="footnote" style={{ color }}>{worker.label}</Text>{[worker.pr && ` · PR #${worker.pr}`, worker.detail && ` · ${worker.detail}`].filter(Boolean).join('')}</Text>
    </View>
    {onOpen && worker.state !== 'missing' && <Pressable testID={`chat-worker-open-${worker.paneId}`} accessibilityRole="button" accessibilityLabel={`Open ${worker.name}`} onPress={() => onOpen(worker.paneId)} style={styles.workerOpen}><Text variant="subhead" style={{ color: theme.colors.accentText }}>Open</Text></Pressable>}
  </View>;
}

export function ChatRowView({ row, actions }: { row: ChatRow; actions: ChatRowActions }) {
  const theme = useTheme();
  switch (row.kind) {
    case 'user':
      return <View style={[styles.user, { backgroundColor: theme.chat.muted }]}>{row.message.parts.map((part, index) => {
        if (part.type === 'text') return <Text key={index} selectable style={{ color: theme.chat.foreground }}>{part.text}</Text>;
        const picture = part.type === 'content' ? imageOf(part.content) : undefined;
        return picture ? <Image key={index} accessibilityLabel="Attached image" source={{ uri: `data:${picture.mimeType};base64,${picture.data}` }} style={styles.image} /> : null;
      })}</View>;
    case 'text': return <Markdown text={row.text} />;
    case 'thought': return <Text variant="footnote" style={{ color: theme.chat.mutedForeground }} numberOfLines={3}>Thinking: {row.text}</Text>;
    case 'image': return <Image accessibilityLabel="Image from the agent" source={{ uri: `data:${row.mimeType};base64,${row.data}` }} style={styles.image} />;
    case 'steps': return <StepLine group={row.group} actions={actions} />;
    case 'current': return <CurrentStep step={row.step} />;
    case 'fold': return <Pressable testID="chat-fold" accessibilityRole="button" accessibilityState={{ expanded: row.open }} onPress={() => actions.onToggleTurn(row.turnId)} style={styles.stepLine}>
      <View style={styles.stepIcon}><Icon ios="checkmark.circle" android="check_circle" size={15} color={theme.chat.mutedForeground} /></View>
      <Text variant="subhead" numberOfLines={1} style={{ color: theme.chat.mutedForeground, flexShrink: 1 }}>{row.summary}</Text>
      <Icon ios={row.open ? 'chevron.down' : 'chevron.right'} android={row.open ? 'expand_more' : 'chevron_right'} size={13} color={theme.chat.mutedForeground} />
    </Pressable>;
    case 'plan': return <Todo entries={row.entries} />;
    case 'stopped': return <Text variant="footnote" style={{ color: theme.chat.mutedForeground, fontStyle: 'italic' }}>{row.text}</Text>;
    case 'worker': return <WorkerRow worker={row.worker} onOpen={actions.onOpenWorker} />;
    case 'content': return <Text variant="footnote" numberOfLines={2} style={{ color: theme.chat.mutedForeground }}>{describeChatContent(row.content).label}</Text>;
  }
}

const styles = StyleSheet.create({
  user: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, gap: 6 },
  image: { width: 220, height: 160, borderRadius: 10, resizeMode: 'cover' },
  stepLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  stepIcon: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  verb: { fontWeight: '600' },
  stepLabel: { flexShrink: 1 },
  details: { marginLeft: 26, gap: 4, paddingBottom: 6 },
  output: { padding: 8, borderRadius: 8, overflow: 'hidden' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6 },
  todoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  worker: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, minHeight: 52 },
  workerText: { flex: 1, minWidth: 0 },
  workerOpen: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
