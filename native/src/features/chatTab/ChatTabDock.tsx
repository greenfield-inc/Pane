import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { permissionSummary } from '@shared/chatTabPermissions';
import { questionAnswer, questionFields, unshownRequiredFields } from '@shared/chatTabQuestions';
import type { AgentChatPermission } from '@shared/types/agentChat';
import type { ChatTabAnswer, ChatTabProblem, ChatTabQuestion, ChatTabQueuedPrompt } from '@shared/types/chatTab';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { queuedLabel } from './chatComposer';

/** A 44pt target in the chat palette. */
export function DockButton({ title, onPress, disabled, primary, testID, style }: { title: string; onPress: () => void; disabled?: boolean; primary?: boolean; testID: string; style?: StyleProp<ViewStyle> }) {
  const { chat } = useTheme();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    onPress={() => { void Haptics.selectionAsync(); onPress(); }}
    style={({ pressed }) => [styles.button, { backgroundColor: primary ? chat.primary : chat.muted, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 }, style]}>
    <Text variant="callout" style={{ color: primary ? chat.onPrimary : chat.foreground }}>{title}</Text>
  </Pressable>;
}

export function ProblemBanner({ problem, agent, busy, onRestart, onSignIn }: { problem: ChatTabProblem; agent: string; busy: boolean; onRestart: () => void; onSignIn: () => void }) {
  const theme = useTheme();
  return <View testID="chat-problem" accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: theme.chat.dangerSoft, borderColor: theme.chat.border }]}>
    <Text variant="headline" style={{ color: theme.chat.foreground }}>{problem.message}</Text>
    <Text variant="subhead" style={{ color: theme.chat.mutedForeground }}>{problem.next}</Text>
    <View style={styles.row}>
      {problem.action === 'sign-in' && <DockButton testID="chat-sign-in" title="Sign in on the computer" primary disabled={busy} onPress={onSignIn} />}
      {problem.action === 'install' && problem.url && <DockButton testID="chat-install" title={`Install ${agent}`} primary onPress={() => void Linking.openURL(problem.url!)} />}
      {problem.code !== 'unsupported-host' && <DockButton testID="chat-restart" title={problem.action === 'restart' ? 'Restart' : 'Retry'} primary={problem.action === 'restart'} disabled={busy} onPress={onRestart} />}
    </View>
  </View>;
}

function Plan({ text }: { text: string }) {
  const theme = useTheme();
  const content = useMarkdown(text, { colorScheme: theme.scheme, styles: { text: { color: theme.chat.foreground, fontSize: 14, lineHeight: 20 } } });
  return <View style={[styles.detail, { borderColor: theme.chat.border, backgroundColor: theme.chat.background }]}>{content}</View>;
}

/** An approval docked above the composer with exactly the adapter's choices (round 2 phone screen). */
export function ApprovalCard({ permission, agent, disabled, onAnswer }: { permission: AgentChatPermission; agent: string; disabled: boolean; onAnswer: (optionId: string) => void }) {
  const theme = useTheme();
  const summary = permissionSummary(permission, agent);
  return <View testID="chat-approval" style={[styles.card, { borderColor: theme.colors.warning, backgroundColor: theme.chat.card }]}>
    <View style={styles.row}><Icon ios="exclamationmark.shield" android="shield" size={16} color={theme.colors.warning} /><Text variant="headline" style={{ color: theme.chat.foreground, flexShrink: 1 }}>{summary.heading}</Text></View>
    {summary.plan ? <Plan text={summary.plan} /> : summary.detail ? <Text selectable numberOfLines={6} variant="footnote" style={[styles.detail, { color: theme.chat.foreground, borderColor: theme.chat.border, fontFamily: monoFontFamily }]}>{summary.detail}</Text> : null}
    <View style={styles.choices}>{permission.options.map((option, index) => <DockButton key={option.optionId} testID={`chat-approval-${index}`} title={option.name} primary={index === 0} disabled={disabled} onPress={() => onAnswer(option.optionId)} />)}</View>
    <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>or type to tell {agent} what to do instead</Text>
  </View>;
}

/** An agent's question (ACP form elicitation) as a docked form. */
export function QuestionCard({ question, disabled, onAnswer }: { question: ChatTabQuestion; disabled: boolean; onAnswer: (answer: ChatTabAnswer) => void }) {
  const theme = useTheme();
  const fields = questionFields(question.schema);
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const set = (key: string, value: JsonValue) => setValues(current => ({ ...current, [key]: value }));
  const unshown = unshownRequiredFields(question.schema);
  const content = unshown.length ? undefined : questionAnswer(fields, values);
  return <View testID="chat-question" style={[styles.card, { borderColor: theme.chat.border, backgroundColor: theme.chat.card }]}>
    <Text variant="headline" style={{ color: theme.chat.foreground }}>{question.message}</Text>
    {fields.map(field => <View key={field.key} style={styles.field}>
      {field.title !== question.message && <Text variant="subhead" style={{ color: theme.chat.mutedForeground }}>{field.title}</Text>}
      {field.kind === 'single' || field.kind === 'multiple'
        ? <View style={styles.choices}>{field.choices.map(choice => {
          const current = values[field.key];
          const chosen = field.kind === 'single' ? current === choice.value : Array.isArray(current) && current.includes(choice.value);
          return <DockButton key={choice.value} testID={`chat-choice-${choice.value}`} title={choice.title} primary={chosen} disabled={disabled} onPress={() => {
            if (field.kind === 'single') set(field.key, choice.value);
            else { const list = Array.isArray(current) ? current : []; set(field.key, chosen ? list.filter(entry => entry !== choice.value) : [...list, choice.value]); }
          }} />;
        })}</View>
        : <TextInput testID={`chat-field-${field.key}`} accessibilityLabel={field.title} placeholder={field.required ? 'Your answer' : 'Your own answer (optional)'} placeholderTextColor={theme.chat.mutedForeground} editable={!disabled}
          value={typeof values[field.key] === 'string' ? String(values[field.key]) : ''} onChangeText={text => set(field.key, text)} style={[styles.input, { color: theme.chat.foreground, borderColor: theme.chat.border }]} />}
    </View>)}
    {unshown.length > 0 && <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>Pane can't show {unshown.join(', ')}, so this question can only be skipped here.</Text>}
    <View style={styles.row}>
      <DockButton testID="chat-question-answer" title="Answer" primary disabled={disabled || !content} onPress={() => { if (content) onAnswer({ action: 'accept', content }); }} />
      <DockButton testID="chat-question-skip" title="Skip" disabled={disabled} onPress={() => onAnswer({ action: 'decline' })} />
    </View>
  </View>;
}

export function QueueList({ queue, onRemove, label }: { queue: ChatTabQueuedPrompt[]; onRemove: (operationId: string) => void; label?: (text: string) => string | undefined }) {
  const theme = useTheme();
  return <View style={styles.queue}>{queue.map((item, index) => <View key={item.operationId} testID="chat-queued" style={[styles.queued, { borderColor: theme.chat.border }]}>
    <Text variant="subhead" numberOfLines={1} style={{ color: theme.chat.foreground, flex: 1 }}>{label?.(item.text) ?? queuedLabel(item)}</Text>
    <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>{index === 0 ? 'Sends next' : 'Queued'}</Text>
    <Pressable testID="chat-unqueue" accessibilityRole="button" accessibilityLabel="Remove from queue" onPress={() => onRemove(item.operationId)} style={styles.icon}><Icon ios="xmark" android="close" size={14} color={theme.chat.mutedForeground} /></Pressable>
  </View>)}</View>;
}

const styles = StyleSheet.create({
  button: { minHeight: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14 },
  card: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  choices: { gap: 8 },
  detail: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8, maxHeight: 220, overflow: 'hidden' },
  field: { gap: 6 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, minHeight: 44, paddingHorizontal: 10, fontSize: 16 },
  queue: { gap: 6 },
  queued: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed', borderRadius: 12, paddingLeft: 12 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
