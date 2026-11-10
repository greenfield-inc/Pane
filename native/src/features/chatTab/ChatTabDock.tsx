import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { permissionSummary } from '@shared/chatTabPermissions';
import { questionAnswer, questionFields, questionSteps, steppedAnswer, stepSummary, unshownRequiredFields, type QuestionField } from '@shared/chatTabQuestions';
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

/** One field of a question: its choices as buttons, or a text box. */
function QuestionInput({ field, value, disabled, heading, onChange }: { field: QuestionField; value: JsonValue | undefined; disabled: boolean; heading: boolean; onChange: (value: JsonValue) => void }) {
  const theme = useTheme();
  return <View style={styles.field}>
    {!!field.title && <Text variant={heading ? 'headline' : 'subhead'} style={{ color: heading ? theme.chat.foreground : theme.chat.mutedForeground }}>{field.title}</Text>}
    {heading && !!field.description && <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>{field.description}</Text>}
    {field.kind === 'single' || field.kind === 'multiple'
      ? <View style={styles.choices}>{field.choices.map(choice => {
        const chosen = field.kind === 'single' ? value === choice.value : Array.isArray(value) && value.includes(choice.value);
        return <DockButton key={choice.value} testID={`chat-choice-${choice.value}`} title={choice.title} primary={chosen} disabled={disabled} onPress={() => {
          if (field.kind === 'single') onChange(choice.value);
          else { const list = Array.isArray(value) ? value : []; onChange(chosen ? list.filter(entry => entry !== choice.value) : [...list, choice.value]); }
        }} />;
      })}</View>
      : <TextInput testID={`chat-field-${field.key}`} accessibilityLabel={field.title} placeholder={field.required ? 'Your answer' : 'Your own answer (optional)'} placeholderTextColor={theme.chat.mutedForeground} editable={!disabled}
        value={typeof value === 'string' ? value : ''} onChangeText={onChange} style={[styles.input, { color: theme.chat.foreground, borderColor: theme.chat.border }]} />}
  </View>;
}

/**
 * An agent's question (ACP form elicitation) as a docked form. Several questions are taken
 * one at a time (D-230): "1 of 2", Next and Back, Skip passes over one, and the last step
 * reviews the answers beside Answer.
 */
export function QuestionCard({ question, disabled, onAnswer }: { question: ChatTabQuestion; disabled: boolean; onAnswer: (answer: ChatTabAnswer) => void }) {
  const theme = useTheme();
  const fields = questionFields(question.schema);
  const steps = questionSteps(fields);
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [index, setIndex] = useState(0);
  const set = (key: string, value: JsonValue) => setValues(current => ({ ...current, [key]: value }));
  const unshown = unshownRequiredFields(question.schema);
  const stepped = steps.length > 1 && !unshown.length;
  const answerFor = (given: Readonly<Record<string, JsonValue>>) => unshown.length ? undefined : stepped ? steppedAnswer(steps, given) : questionAnswer(fields, given);
  const content = answerFor(values);
  const answer = () => { if (content) onAnswer({ action: 'accept', content }); };
  if (!stepped) {
    return <View testID="chat-question" style={[styles.card, { borderColor: theme.chat.border, backgroundColor: theme.chat.card }]}>
      <Text variant="headline" style={{ color: theme.chat.foreground }}>{question.message}</Text>
      {fields.map(field => <QuestionInput key={field.key} field={field.title === question.message ? { ...field, title: '' } : field} heading={false} value={values[field.key]} disabled={disabled} onChange={value => set(field.key, value)} />)}
      {unshown.length > 0 && <Text variant="footnote" style={{ color: theme.chat.mutedForeground }}>Pane can't show {unshown.join(', ')}, so you can only skip this question.</Text>}
      <View style={styles.row}>
        <DockButton testID="chat-question-answer" title="Answer" primary disabled={disabled || !content} onPress={answer} />
        <DockButton testID="chat-question-skip" title="Skip" disabled={disabled} onPress={() => onAnswer({ action: 'decline' })} />
      </View>
    </View>;
  }
  const step = steps[index] ?? [];
  const last = index === steps.length - 1;
  const skip = () => {
    const cleared = { ...values };
    for (const field of step) delete cleared[field.key];
    setValues(cleared);
    if (!last) { setIndex(index + 1); return; }
    const rest = answerFor(cleared);
    onAnswer(rest ? { action: 'accept', content: rest } : { action: 'decline' });
  };
  return <View testID="chat-question" style={[styles.card, { borderColor: theme.chat.border, backgroundColor: theme.chat.card }]}>
    <View style={styles.head}>
      <Text variant="subhead" style={{ color: theme.chat.mutedForeground, flex: 1 }}>{question.message}</Text>
      <Text testID="chat-question-count" variant="footnote" style={{ color: theme.chat.mutedForeground }}>{index + 1} of {steps.length}</Text>
    </View>
    {step.map((field, position) => <QuestionInput key={field.key} field={field} heading={position === 0} value={values[field.key]} disabled={disabled} onChange={value => set(field.key, value)} />)}
    {last && <View style={[styles.review, { borderColor: theme.chat.border }]}>
      {steps.slice(0, -1).map((earlier, position) => <Pressable key={position} testID={`chat-question-review-${position}`} accessibilityRole="button" accessibilityLabel={`Change: ${earlier[0]?.title ?? ''}`} onPress={() => setIndex(position)} style={styles.reviewRow}>
        <Text variant="footnote" numberOfLines={1} style={{ color: theme.chat.mutedForeground, maxWidth: '40%' }}>{earlier[0]?.title}</Text>
        <Text variant="footnote" numberOfLines={1} style={{ color: theme.chat.foreground, flex: 1 }}>{stepSummary(earlier, values) ?? 'Skipped'}</Text>
      </Pressable>)}
    </View>}
    <View style={styles.row}>
      {last
        ? <DockButton testID="chat-question-answer" title="Answer" primary disabled={disabled || !content} onPress={answer} />
        : <DockButton testID="chat-question-next" title="Next" primary disabled={disabled || !stepSummary(step, values)} onPress={() => setIndex(index + 1)} />}
      <DockButton testID="chat-question-skip" title="Skip" disabled={disabled} onPress={skip} />
      {index > 0 && <DockButton testID="chat-question-back" title="Back" disabled={disabled} onPress={() => setIndex(index - 1)} />}
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
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  review: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6, gap: 2 },
  reviewRow: { flexDirection: 'row', gap: 12, minHeight: 32, alignItems: 'center' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, minHeight: 44, paddingHorizontal: 10, fontSize: 16 },
  queue: { gap: 6 },
  queued: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed', borderRadius: 12, paddingLeft: 12 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
