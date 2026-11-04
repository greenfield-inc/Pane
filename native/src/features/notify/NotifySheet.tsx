import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { NotifyAnswer, NotifyItem } from '@shared/types/notify';

import { useHostsStore } from '@/auth/hostsStore';
import { useDaemon } from '@/daemon';

import { DialogSection, DialogSheet, Notice, SheetButton } from '@/features/panes/PaneKit';
import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text, TextField } from '@/ui';

import { useMachineNotifyCommand, useMachineNotifyShared, useNotifyCommand, useNotifyShared } from './hooks';
import { type AnsweredHere, NOTIFY_KIND_LABEL, notifySheetState } from './notifyQuestions';

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
  const onAccepted = (sent: { type: string }) => {
    if (sent.type !== 'answer' || !shared.data) return;
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
  return <QuestionSheet item={state.item} machine={other?.label} answer={answer} busy={command.isPending} error={error} onClose={close} />;
}

function QuestionSheet({ item, machine, answer, busy, error, onClose }: {
  item: NotifyItem;
  /** The machine that asked, when it isn't the one the phone is on. */
  machine?: string;
  answer: (value: NotifyAnswer) => void;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <QuestionForm item={item} answer={answer} busy={busy}>
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
            <Text variant="footnote" tone="muted" numberOfLines={1}>{[item.machine ?? machine, item.source.name, item.source.agent].filter(Boolean).join(' · ')}</Text>
            <Text testID="notify-title" variant="headline" selectable>{item.title}</Text>
            {item.context ? <Text variant="subhead" tone="secondary" selectable>{item.context}</Text> : null}
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
  const trimmedNote = note.trim();
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
  } else if (item.ui === 'ask') {
    actions = [{ testID: 'notify-send', variant: 'primary', title: `Send to ${item.source.agent}`, loading: busy, disabled: !text.trim(), onPress: () => answer({ text: text.trim() }) }];
  }

  const fields = (
    <>
      {item.ui === 'options' ? (
        <View style={styles.choices}>
          {(item.choices ?? []).map((choice, index) => (
            <Pressable
              key={choice.label}
              testID={`notify-choice-${index}`}
              accessibilityRole="button"
              accessibilityLabel={choice.recommended ? `${choice.label}, recommended` : choice.label}
              disabled={busy}
              onPress={() => answer(withNote({ choice: choice.label }))}
              style={({ pressed }) => [styles.choice, block, {
                backgroundColor: pressed ? theme.colors.surfacePressed : choice.recommended ? theme.colors.selected : theme.colors.surfaceRaised,
              }]}
            >
              <View style={styles.fill}>
                <Text variant="callout" style={choice.recommended ? styles.bold : undefined}>{choice.label}</Text>
                {choice.detail ? <Text variant="footnote" tone="muted">{choice.detail}</Text> : null}
              </View>
              {choice.recommended ? <Text variant="caption" tone="muted">Recommended</Text> : null}
            </Pressable>
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
          placeholder={item.ui === 'approve' ? `Reason or note for ${item.source.agent} (optional)` : `Add a note for ${item.source.agent} (optional)`}
          value={note}
          onChangeText={setNote}
          editable={!busy}
        />
      )}
    </>
  );
  return children({ fields, actions });
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
  check: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
