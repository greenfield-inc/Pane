import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { NotifyAnswer, NotifyItem } from '@shared/types/notify';

import { DialogSection, DialogSheet, Notice, SheetButton } from '@/features/panes/PaneKit';
import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text, TextField } from '@/ui';

import { useNotifyCommand, useNotifyShared } from './hooks';
import { NOTIFY_KIND_LABEL, notifySheetState } from './notifyQuestions';

/** The desktop's Undo hold: the host passes the answer on after this. */
const UNDO_MS = 3_000;

/** Opens a question's sheet: under its Pane, or on its own for a question from outside any Pane. */
export function openNotifySheet(notifyId: string, paneId?: string) {
  if (paneId) router.push({ pathname: '/pane/[paneId]/notify', params: { paneId, notifyId } });
  else router.push({ pathname: '/notify/[notifyId]', params: { notifyId } });
}

/** One Notify question, drawn like the desktop card (frontend/src/components/notify/NotifyCard.tsx) in the app's sheet chrome. */
export function NotifySheet({ notifyId }: { notifyId: string }) {
  const shared = useNotifyShared();
  const command = useNotifyCommand();
  // Set once this phone's answer is in: the agent's name for "Sent to <agent>".
  const [sentTo, setSentTo] = useState<string | null>(null);
  const close = () => router.back();

  useEffect(() => {
    if (!sentTo) return;
    const timer = setTimeout(() => router.back(), UNDO_MS);
    return () => clearTimeout(timer);
  }, [sentTo]);

  if (sentTo) {
    return (
      <DialogSheet
        testID="notify-sheet"
        title={`Sent to ${sentTo}`}
        onClose={close}
        footer={<SheetButton testID="notify-undo" title="Undo" loading={command.isPending} onPress={() => command.mutate([{ type: 'undo', id: notifyId }], { onSuccess: () => setSentTo(null) })} />}
      >
        <DialogSection divided={false}>
          <SentLine summary={shared.data?.items.find(item => item.id === notifyId)?.answerSummary} />
          {command.isError ? <Notice testID="notify-error" danger message={command.error.message} /> : null}
        </DialogSection>
      </DialogSheet>
    );
  }

  const state = shared.data ? notifySheetState(shared.data.items.find(item => item.id === notifyId)) : null;
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

  const answer = (value: NotifyAnswer) => {
    command.mutate([{ type: 'answer', id: notifyId, answer: value }], {
      onSuccess: () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setSentTo(state.item.source.agent);
      },
    });
  };
  return <QuestionSheet item={state.item} answer={answer} busy={command.isPending} error={command.isError ? command.error.message : null} onClose={close} />;
}

function QuestionSheet({ item, answer, busy, error, onClose }: {
  item: NotifyItem;
  answer: (value: NotifyAnswer) => void;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const trimmedNote = note.trim();
  const withNote = <T extends object>(value: T) => (trimmedNote ? { ...value, note: trimmedNote } : value);
  const block = { borderRadius: theme.radius.lg, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised };

  let footer = <SheetButton title="Close" onPress={onClose} disabled={busy} />;
  if (item.ui === 'approve') {
    footer = (
      <>
        <SheetButton testID="notify-deny" variant="danger" title="Deny" disabled={busy} onPress={() => answer(withNote({ approved: false }))} style={styles.answer} />
        <SheetButton testID="notify-approve" variant="primary" title="Approve" disabled={busy} onPress={() => answer(withNote({ approved: true }))} style={styles.answer} />
      </>
    );
  } else if (item.ui === 'ask') {
    footer = <SheetButton testID="notify-send" variant="primary" title={`Send to ${item.source.agent}`} loading={busy} disabled={!text.trim()} onPress={() => answer({ text: text.trim() })} style={styles.answer} />;
  }

  return (
    <DialogSheet testID="notify-sheet" title={NOTIFY_KIND_LABEL[item.ui]} onClose={onClose} closeDisabled={busy} footer={footer}>
      <DialogSection divided={false}>
        <Text variant="footnote" tone="muted" numberOfLines={1}>{[item.machine, item.source.name, item.source.agent].filter(Boolean).join(' · ')}</Text>
        <Text testID="notify-title" variant="headline" selectable>{item.title}</Text>
        {item.context ? <Text variant="subhead" tone="secondary" selectable>{item.context}</Text> : null}

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

        {item.ui === 'ask' ? (
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
        ) : (
          <TextField
            testID="notify-note"
            placeholder={item.ui === 'approve' ? `Reason or note for ${item.source.agent} (optional)` : `Add a note for ${item.source.agent} (optional)`}
            value={note}
            onChangeText={setNote}
            editable={!busy}
          />
        )}
        {error ? <Notice testID="notify-error" danger message={error} /> : null}
      </DialogSection>
    </DialogSheet>
  );
}

/** The desktop's sent line: a check and what was sent, held for Undo. */
function SentLine({ summary }: { summary?: string }) {
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
