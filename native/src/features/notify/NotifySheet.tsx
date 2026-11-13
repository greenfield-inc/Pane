import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { originLine } from '@shared/approvalReceipts';
import type { NotifyAnswer, NotifyChoice, NotifyItem, NotifyRemoteCommand } from '@shared/types/notify';

import { useHostsStore } from '@/auth/hostsStore';
import { useDaemon } from '@/daemon';

import { DialogSection, DialogSheet, Notice, SheetButton } from '@/features/panes/PaneKit';
import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text, TextField } from '@/ui';

import { useMachineNotifyCommand, useMachineNotifyShared, useNotifyCommand, useNotifyShared } from './hooks';
import { type AnsweredHere, initialPicks, isReply, NOTIFY_KIND_LABEL, notifySheetState, optionsAnswer, replyStatus, revisionNote, type ReplyTone } from './notifyQuestions';

/**
 * One Notify question, drawn like the desktop card (frontend/src/components/notify/NotifyCard.tsx) in the app's sheet chrome.
 * `host` names another saved machine whose question this is.
 */
export function NotifySheet({ notifyId, host }: { notifyId: string; host?: string }) {
  const { profile } = useDaemon();
  const other = useHostsStore(state => (host && host !== profile.id ? state.profiles.find(candidate => candidate.id === host) ?? null : null));
  const live = useNotifyShared();
  const remote = useMachineNotifyShared(other);
  const shared = other ? remote : live;
  // Set when the host accepts this phone's answer, so the sheet reads "Sent to" before the snapshot catches up.
  const [answeredHere, setAnsweredHere] = useState<AnsweredHere | null>(null);
  const onAccepted = (sent: NotifyRemoteCommand) => {
    // A reply isn't held for Undo: the snapshot shows it being read.
    if (sent.type !== 'answer' || isReply(sent.answer) || !shared.data) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAnsweredHere({ epoch: shared.data.epoch, revision: shared.data.revision });
  };
  const liveCommand = useNotifyCommand(onAccepted);
  const remoteCommand = useMachineNotifyCommand(other, onAccepted);
  const command = other ? remoteCommand : liveCommand;
  const close = () => router.back();
  const state = shared.data ? notifySheetState(shared.data, notifyId, answeredHere) : null;
  // Undone on some screen: the question is open again, and a later answer from elsewhere reads "Answered on".
  if (answeredHere && state?.kind === 'question') setAnsweredHere(null);
  const undoing = command.isPending && command.variables[0].type === 'undo';
  const error = command.isError ? command.error.message : null;
  const done = state?.kind === 'done' && !undoing && !error;

  useEffect(() => {
    if (done) router.back();
  }, [done]);

  if (state?.kind === 'held' || state?.kind === 'done') {
    const footer = state.kind === 'held' || undoing
      ? <SheetButton testID="notify-undo" title="Undo" loading={undoing} onPress={() => command.mutate([{ type: 'undo', id: notifyId }])} />
      : <SheetButton title="Close" onPress={close} />;
    return (
      <DialogSheet testID="notify-sheet" title={state.title} onClose={close} footer={footer}>
        <DialogSection divided={false}>
          <SentLine summary={state.summary} />
          {error ? <Notice testID="notify-error" danger message={error} /> : null}
        </DialogSection>
      </DialogSheet>
    );
  }

  if (!state || state.kind === 'closed') {
    const message = shared.isPending ? 'Loading…' : shared.isError ? shared.error.message : state?.message ?? '';
    return (
      <DialogSheet testID="notify-sheet" title="Question" onClose={close} footer={<SheetButton title="Close" onPress={close} />}>
        <DialogSection divided={false}>
          <Text testID="notify-closed" variant="subhead" tone={shared.isError ? 'danger' : 'secondary'}>{message}</Text>
        </DialogSection>
      </DialogSheet>
    );
  }

  const answer = (value: NotifyAnswer) => command.mutate([{ type: 'answer', id: notifyId, answer: value }]);
  return <QuestionSheet item={state.item} machine={other?.label ?? profile.label} answer={answer} busy={command.isPending} error={error} onClose={close} />;
}

function QuestionSheet({ item, machine, answer, busy, error, onClose }: {
  item: NotifyItem;
  /** The saved name of the machine that asked. */
  machine: string;
  answer: (value: NotifyAnswer) => void;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <QuestionForm key={questionFormKey(item)} item={item} answer={answer} busy={busy}>
      {({ fields, actions }) => (
        <DialogSheet
          testID="notify-sheet"
          title={NOTIFY_KIND_LABEL[item.ui]}
          onClose={onClose}
          closeDisabled={busy}
          footer={actions.length > 0
            ? actions.map(action => <SheetButton key={action.testID} {...action} style={styles.answer} />)
            : <SheetButton title="Close" onPress={onClose} disabled={busy} />}
        >
          <DialogSection divided={false}>
            <Text variant="footnote" tone="muted" numberOfLines={1}>{originLine(item, machine)}</Text>
            <Text testID="notify-title" variant="headline" selectable>{item.title}</Text>
            {item.context ? <Text variant="subhead" tone="secondary" selectable>{item.context}</Text> : null}
            <RevisionLines item={item} />
            <ReplyStatusLines item={item} />
            {fields}
            {error ? <Notice testID="notify-error" danger message={error} /> : null}
          </DialogSection>
        </DialogSheet>
      )}
    </QuestionForm>
  );
}

/** One answer button: Deny, Approve or Send. */
export interface QuestionAction {
  testID: string;
  title: string;
  variant?: 'primary' | 'danger';
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * A question's answer controls, shared by the sheet and the approval card: `fields` (choices,
 * the detail disclosure, suggestions, the answer or note field) and `actions` (Approve and Deny,
 * or Send; none for a choice, which answers when tapped).
 */
export function QuestionForm({ item, answer, busy, children }: {
  item: NotifyItem;
  answer: (value: NotifyAnswer) => void;
  busy: boolean;
  children: (parts: { fields: ReactNode; actions: QuestionAction[] }) => ReactNode;
}) {
  const theme = useTheme();
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  // Several questions: one pick each, sent together with Send. Each starts on its recommended choice (J1).
  const [picks, setPicks] = useState<string[]>(() => initialPicks(item));
  const trimmedNote = note.trim();
  // A permission prompt stays options only: its note rides on the choice, never as a reply.
  // A permission prompt and a choice-only chat question take only their options (F-10).
  const replies = item.ui === 'options' && !item.agentPrompt && !item.optionsOnly;
  const choose = (label: string) => {
    if (!replies) return answer(withNote({ choice: label }));
    const value = optionsAnswer(item, [label], note);
    if (value) answer(value);
  };
  const several = replies ? optionsAnswer(item, picks, note) : null;
  const withNote = <T extends object>(value: T) => (trimmedNote ? { ...value, note: trimmedNote } : value);
  const block = { borderRadius: theme.radius.lg, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised };

  let actions: QuestionAction[] = [];
  if (item.ui === 'approve') {
    actions = [
      { testID: 'notify-deny', variant: 'danger', title: 'Deny', disabled: busy, onPress: () => answer(withNote({ approved: false })) },
      { testID: 'notify-approve', variant: 'primary', title: 'Approve', disabled: busy, onPress: () => answer(withNote({ approved: true })) },
    ];
  } else if (item.ui === 'secret') {
    actions = [
      { testID: 'notify-decline', title: 'Decline', disabled: busy, onPress: () => { setText(''); answer({ approved: false }); } },
      // Sent as typed, then dropped from this sheet's state.
      { testID: 'notify-save-secret', variant: 'primary', title: 'Save securely', loading: busy, disabled: !text, onPress: () => { answer({ text }); setText(''); } },
    ];
  } else if (replies && (item.questions || trimmedNote)) {
    // Typed text with no pick goes as a reply; several questions send their picks together.
    const reply = item.questions ? several : optionsAnswer(item, [], note);
    actions = [{ testID: 'notify-send-reply', variant: 'primary', title: `Send to ${item.source.agent}`, loading: busy, disabled: busy || !reply, onPress: () => { if (reply) answer(reply); } }];
  } else if (item.ui === 'ask') {
    // A typed answer is a reply its asker reads as an answer or a question (J19).
    actions = [{ testID: 'notify-send', variant: 'primary', title: `Send to ${item.source.agent}`, loading: busy, disabled: !text.trim(), onPress: () => answer({ picks: [], text: text.trim() }) }];
  }

  const fields = (
    <>
      {item.ui === 'options' && item.questions ? (
        item.questions.map((question, questionIndex) => (
          <View key={`${questionIndex}:${question.title}`} testID={`notify-question-${questionIndex}`} style={styles.choices}>
            <Text variant="footnote" tone="muted">{`Question ${questionIndex + 1} of ${item.questions?.length ?? 0}`}</Text>
            <Text variant="callout" style={styles.bold} selectable>{question.title}</Text>
            {question.why?.trim() ? <Text testID={`notify-question-why-${questionIndex}`} variant="footnote" tone="secondary" selectable>{question.why.trim()}</Text> : null}
            {question.choices.map((choice, index) => (
              <ChoiceRow
                key={choice.label}
                testID={`notify-choice-${questionIndex}-${index}`}
                choice={choice}
                selected={picks[questionIndex] === choice.label}
                disabled={busy}
                onPress={() => setPicks(current => {
                  const next = [...current];
                  next[questionIndex] = current[questionIndex] === choice.label ? '' : choice.label;
                  return next;
                })}
              />
            ))}
          </View>
        ))
      ) : item.ui === 'options' ? (
        <View style={styles.choices}>
          {(item.choices ?? []).map((choice, index) => (
            <ChoiceRow key={choice.label} testID={`notify-choice-${index}`} choice={choice} disabled={busy} onPress={() => choose(choice.label)} />
          ))}
        </View>
      ) : null}

      {item.ui === 'approve' && item.detail ? (
        showDetail ? (
          <View style={[styles.block, block]}>
            <Text selectable variant="footnote" tone="secondary" style={{ fontFamily: monoFontFamily }}>{item.detail}</Text>
          </View>
        ) : (
          <Pressable testID="notify-show-detail" accessibilityRole="button" hitSlop={8} onPress={() => setShowDetail(true)}>
            <Text variant="footnote" tone="accent">{item.detailLabel?.trim() || 'Show details'}</Text>
          </Pressable>
        )
      ) : null}

      {item.ui === 'secret' ? (
        <>
          <TextField
            testID="notify-secret"
            placeholder="Type the secret"
            value={text}
            onChangeText={setText}
            secureTextEntry
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            textContentType="none"
            importantForAutofill="no"
            editable={!busy}
            mono
          />
          {/* A failed save swaps in for the destination line, in the same two-line box. */}
          {item.secretError ? (
            <Text testID="notify-secret-error" variant="footnote" tone="danger" numberOfLines={2} style={styles.secretLine} accessibilityLiveRegion="polite">
              {item.secretError}
            </Text>
          ) : item.secret ? (
            <Text testID="notify-secret-target" variant="footnote" tone="muted" numberOfLines={2} style={styles.secretLine}>
              {`Saves as Pane secret ${item.secret.project}/${item.secret.name}${item.secret.replaces ? ' · replaces the saved value' : ''}`}
            </Text>
          ) : null}
          <Text variant="footnote" tone="muted">Kept out of chat. Any agent on your machines can use it with runpane secrets exec.</Text>
          {/* A secure field on the phone is one line, so a pasted value loses its line breaks. */}
          <Text testID="notify-secret-one-line" variant="footnote" tone="muted">Takes one line. Answer a multi-line value, such as a PEM key, on your computer.</Text>
        </>
      ) : item.ui === 'ask' ? (
        <>
          {(item.suggestions ?? []).length > 0 ? (
            <View style={styles.chips}>
              {(item.suggestions ?? []).map((suggestion, index) => (
                <Pressable
                  key={suggestion}
                  testID={`notify-suggestion-${index}`}
                  accessibilityRole="button"
                  // A suggestion is a starting point: it fills the field, and Send answers.
                  onPress={() => setText(suggestion)}
                  style={({ pressed }) => [styles.chip, block, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                >
                  <Text variant="subhead">{suggestion}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <TextField testID="notify-text" placeholder="Type your answer" value={text} onChangeText={setText} multiline editable={!busy} />
        </>
      ) : item.ui === 'info' ? null : (
        <TextField
          testID="notify-note"
          placeholder={item.ui === 'approve' ? `Reason or note for ${item.source.agent} (optional)` : replies ? `Reply or ask ${item.source.agent} (optional)` : `Add a note for ${item.source.agent} (optional)`}
          value={note}
          onChangeText={setNote}
          editable={!busy}
        />
      )}
    </>
  );
  return children({ fields, actions });
}

/** One choice: tapped to answer (one question) or to pick (several). A reworded one says what it was. */
function ChoiceRow({ choice, testID, selected, disabled, onPress }: { choice: NotifyChoice; testID: string; selected?: boolean; disabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  const highlighted = selected || choice.recommended;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={choice.recommended ? `${choice.label}, recommended` : choice.label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, {
        borderRadius: theme.radius.lg,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: pressed ? theme.colors.surfacePressed : highlighted ? theme.colors.selected : theme.colors.surfaceRaised,
      }]}
    >
      <View style={styles.fill}>
        <Text variant="callout" style={choice.recommended || selected ? styles.bold : undefined}>{choice.label}</Text>
        {choice.detail ? <Text variant="footnote" tone="muted">{choice.detail}</Text> : null}
        {choice.was !== undefined ? <Text variant="footnote" tone="muted">{choice.was === choice.label ? 'Reworded' : `Reworded, was “${choice.was}”`}</Text> : null}
      </View>
      {selected ? <Icon ios="checkmark" android="check" size={14} color={theme.colors.accentText} /> : choice.recommended ? <Text variant="caption" tone="muted">Recommended</Text> : null}
    </Pressable>
  );
}

/**
 * A fresh form for each reply and version: a reply the host has taken clears the field, and a
 * new version's choices start unpicked. A failed send keeps what was typed.
 */
export function questionFormKey(item: NotifyItem): string {
  return `${item.version ?? 1}:${item.reply?.id ?? ''}`;
}

/**
 * How the person's reply was taken, or that the approval came back updated, as text (the phone
 * keeps its own screen). `onFix` sends the one-tap correction; without it none is offered.
 */
export function ReplyStatusLines({ item, onFix, fixing }: { item: NotifyItem; onFix?: (as: 'answer' | 'question') => void; fixing?: boolean }) {
  const theme = useTheme();
  const status = replyStatus(item);
  if (!status) return null;
  const color: Record<ReplyTone, string> = { success: theme.colors.success, warning: theme.colors.warning, accent: theme.colors.accentText, muted: theme.colors.textSecondary };
  return (
    <View testID="notify-reply-status" style={styles.replyStatus} accessibilityLiveRegion="polite">
      <Text testID="notify-reply-state" variant="subhead" style={[styles.bold, { color: color[status.tone] }]}>{status.text}</Text>
      {status.detail ? <Text testID="notify-reply-detail" variant="footnote" tone="secondary" selectable numberOfLines={3}>{status.detail}</Text> : null}
      {status.fix && onFix ? (
        <Pressable testID="notify-reply-fix" accessibilityRole="button" hitSlop={8} disabled={fixing} onPress={() => { if (status.fix) onFix(status.fix.as); }}>
          <Text variant="footnote" tone="accent">{status.fix.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A revised approval's What changed: the person's question and the asker's lines, as text. */
export function RevisionLines({ item }: { item: NotifyItem }) {
  const theme = useTheme();
  const note = revisionNote(item);
  if (!note) return null;
  return (
    <View testID="notify-revision" style={[styles.block, styles.revision, { borderRadius: theme.radius.lg, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised }]}>
      <Text variant="caption" tone="muted">{`v${note.version} · What changed · ${note.by}`}</Text>
      <Text testID="notify-revision-asked" variant="footnote" tone="secondary" selectable>{`You asked: “${note.asked}”`}</Text>
      {note.whatChanged.map((line, index) => (
        <Text key={`${index}:${line}`} testID="notify-revision-line" variant="footnote" selectable>{`• ${line}`}</Text>
      ))}
    </View>
  );
}

/** The desktop's held line: a check and what was sent. */
export function SentLine({ summary }: { summary?: string }) {
  const theme = useTheme();
  return (
    <View testID="notify-sent" style={styles.sent}>
      <View style={[styles.check, { backgroundColor: theme.colors.success }]}>
        <Icon ios="checkmark" android="check" size={12} color={theme.colors.onAccent} />
      </View>
      <Text variant="subhead" tone="secondary" numberOfLines={2} style={styles.fill}>{summary ?? 'Your answer'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Two footnote lines (16 pt each), so the destination and an error take the same room.
  secretLine: { height: 32 },
  bold: { fontWeight: '600' },
  answer: { flex: 1 },
  choices: { gap: 8, marginTop: 4 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1 },
  block: { padding: 12, borderWidth: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1 },
  sent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  replyStatus: { gap: 2 },
  revision: { gap: 4 },
  check: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
