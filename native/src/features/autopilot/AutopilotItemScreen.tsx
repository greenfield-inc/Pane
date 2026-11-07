import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { decisionModel, type DecisionModel } from '@shared/autopilotDecision';
import type { NotifyItem } from '@shared/types/notify';

import { useDaemon } from '@/daemon';
import { ConnectedRow } from '@/features/approvals/ApprovalActions';
import { approvalOrder, connectedLink } from '@/features/approvals/approvals';
import { useApprovalSort } from '@/features/approvals/approvalSortPreference';
import { ConnectionBar } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { useNotifyShared } from '@/features/notify/hooks';
import { useTheme } from '@/theme';
import { Button, ErrorState, Icon, Text } from '@/ui';

import { answerBar, cardState, contextSource, itemPosition, relatedDocs, stackEntryFor, type CardState, type RelatedDoc, autopilotItems } from './autopilot';
import { DecisionCard, useDecisionAnswer } from './DecisionCard';
import { useAutopilot } from './hooks';

/** Back to the chat: the screen under this one, where the chat kept its place. */
function backToChat() {
  if (router.canGoBack()) router.back();
  else router.replace('/autopilot');
}

/** Opens a related document full screen above the approval. */
function openDoc(notifyId: string, doc: RelatedDoc) {
  router.push({ pathname: '/autopilot/doc', params: { notifyId, label: doc.label, ...(doc.kind === 'file' ? { path: doc.path } : { url: doc.url }) } });
}

/**
 * An approval full screen (D-76): "‹ Chat" and "n of N · Session", the decision, then "More
 * context" ("Why I'm asking" on Autopilot's own) and "Related docs" as rows that open and close,
 * and the answer buttons fixed at the bottom. Answering goes back to the chat where you were.
 */
export function AutopilotItemScreen({ notifyId }: { notifyId: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const { profile } = useDaemon();
  const notify = useNotifyShared();
  const autopilot = useAutopilot();
  const item = autopilotItems(autopilot.data, notify.data?.items).find(candidate => candidate.id === notifyId);
  const answer = useDecisionAnswer(notifyId, backToChat);
  const model = item ? decisionModel(item) : undefined;
  const sort = useApprovalSort(state => state.sort);
  const position = itemPosition(autopilot.data, notifyId, approvalOrder(notify.data, sort));
  const entry = stackEntryFor(autopilot.data, notifyId);

  let body: ReactNode;
  if (notify.isError) body = <ErrorState title="Couldn’t read the question" error={notify.error} onRetry={() => void notify.refetch()} />;
  else if (!notify.data) body = <View style={styles.center}><ActivityIndicator /></View>;
  else {
    body = (
      <ScrollView testID="autopilot-item-scroll" style={styles.fill} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <DecisionCard notifyId={notifyId} item={item} variant="full" answer={answer} />
        {item && model ? (
          <>
            <ConnectedRow link={connectedLink(item, profile.label)} />
            <Section testID="autopilot-item-context" title={model.contextLabel} right={contextSource(model)}>
              <ContextBody item={item} model={model} note={entry?.note} />
            </Section>
            <DocsSection item={item} docs={relatedDocs(item, entry)} />
          </>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView testID="autopilot-item-screen" behavior="padding" style={[styles.fill, { backgroundColor: colors.surface }]}>
      <View style={{ paddingTop: insets.top, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }}>
        <View style={styles.bar}>
          <Pressable testID="autopilot-item-back" accessibilityRole="button" accessibilityLabel="Back to the chat" hitSlop={6} onPress={backToChat} style={styles.back}>
            <Icon ios="chevron.left" android="arrow_back" size={18} color={colors.text} />
            <Text variant="headline">Chat</Text>
          </Pressable>
          <Text testID="autopilot-item-position" variant="subhead" tone="muted" numberOfLines={1} style={styles.position}>
            {[position, model?.session ?? (model?.byAutopilot ? 'Autopilot' : undefined)].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </View>
      <PresenceBar />
      <View style={styles.fill}>{body}</View>
      {model ? <AnswerBar model={model} state={cardState(item)} answer={answer} bottom={insets.bottom} /> : null}
    </KeyboardAvoidingView>
  );
}

function PresenceBar() {
  const { notice, retry } = useConnectionPresence();
  return <ConnectionBar notice={notice} onRetry={retry} />;
}

/** A row that opens and closes what it holds: its title, a label on the right, and a chevron. */
function Section({ title, right, children, testID }: { title: string; right: string; children: ReactNode; testID: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const [open, setOpen] = useState(false);
  return (
    <View testID={testID} style={[styles.section, { borderColor: colors.border }]}>
      <Pressable testID={`${testID}-toggle`} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title}
        onPress={() => setOpen(!open)} style={({ pressed }) => [styles.sectionHead, pressed && { backgroundColor: colors.surfacePressed }]}>
        <View style={styles.chevronBox}><Icon ios={open ? 'chevron.down' : 'chevron.right'} android={open ? 'expand_more' : 'chevron_right'} size={14} color={colors.text} /></View>
        <Text variant="headline" style={styles.fill}>{title}</Text>
        <Text variant="subhead" tone="muted">{right}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/** The whole context, the asker's details, and Autopilot's note on the stack entry. */
function ContextBody({ item, model, note }: { item: NotifyItem; model: DecisionModel; note?: string }) {
  const { colors } = useTheme();
  const nothing = !item.context && !item.detail && !note;
  return (
    <View style={[styles.sectionBody, { borderTopColor: colors.border }]}>
      {item.context ? <Text variant="body" tone="secondary" selectable>{item.context}</Text> : null}
      {item.detail ? <Text variant="subhead" tone="secondary" selectable>{item.detail}</Text> : null}
      {note ? (
        <Text variant="body" tone="secondary" selectable>
          <Text variant="body" style={styles.bold}>{model.byAutopilot ? 'Autopilot: ' : `${model.session ?? 'Autopilot'} says: `}</Text>
          {note}
        </Text>
      ) : null}
      {nothing ? <Text variant="subhead" tone="muted">{model.who} gave no more context.</Text> : null}
    </View>
  );
}

const DOC_ICON = {
  file: { ios: 'doc.text', android: 'description' },
  image: { ios: 'photo', android: 'image' },
  globe: { ios: 'globe', android: 'language' },
} as const;

function DocsSection({ item, docs }: { item: NotifyItem; docs: RelatedDoc[] }) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Section testID="autopilot-item-docs" title="Related docs" right={String(docs.length)}>
      {docs.length === 0 ? (
        <View style={[styles.sectionBody, { borderTopColor: colors.border }]}><Text variant="subhead" tone="muted">None attached.</Text></View>
      ) : docs.map((doc, index) => (
        <Pressable key={doc.key} testID={`autopilot-doc-${index}`} accessibilityRole="link" accessibilityLabel={`Open ${doc.label}`} onPress={() => openDoc(item.id, doc)}
          style={({ pressed }) => [styles.docRow, { borderTopColor: colors.border, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}>
          <Icon {...DOC_ICON[doc.icon]} size={17} color={colors.textSecondary} />
          <Text variant="body" numberOfLines={1} style={styles.fill}>{doc.label}</Text>
          <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.docDetail}>{doc.detail}</Text>
          <Icon ios="chevron.right" android="chevron_right" size={13} color={colors.textMuted} />
        </Pressable>
      ))}
    </Section>
  );
}

/** Fixed at the bottom: the options as buttons, "Pick one above", a text field, or the answer and back. */
function AnswerBar({ model, state, answer, bottom }: { model: DecisionModel; state: CardState; answer: ReturnType<typeof useDecisionAnswer>; bottom: number }) {
  const theme = useTheme();
  const { colors } = theme;
  const [text, setText] = useState('');
  const kind = answerBar(model, state);
  let content: ReactNode;
  if (kind === 'buttons') {
    content = model.options.map((option, index) => (
      <View key={option.key} style={styles.fill}>
        <Button testID={`autopilot-answer-${option.key}`} title={option.label} variant={index === 0 ? 'primary' : 'secondary'}
          loading={answer.busy && JSON.stringify(answer.sending) === JSON.stringify(option.answer)} disabled={answer.busy} onPress={() => answer.answer(option.answer)} />
      </View>
    ));
  } else if (kind === 'pick') {
    content = <Text testID="autopilot-answer-pick" variant="subhead" tone="muted" style={styles.pick}>Pick one above</Text>;
  } else if (kind === 'text') {
    content = (
      <>
        <TextInput testID="autopilot-answer-text" accessibilityLabel="Your answer" placeholder="Type your answer" placeholderTextColor={colors.textMuted}
          value={text} onChangeText={setText} multiline style={[styles.input, styles.fill, { color: colors.text, borderColor: colors.border, borderRadius: theme.radius.md }]} />
        <Button testID="autopilot-answer-send" title="Send" loading={answer.busy} disabled={!text.trim()} onPress={() => answer.answer({ text: text.trim() })} />
      </>
    );
  } else {
    const summary = state.kind === 'held' || state.kind === 'answered' ? `Answered: ${state.answer} · back to chat` : 'Back to chat';
    content = <View style={styles.fill}><Button testID="autopilot-answer-back" title={summary} variant="secondary" onPress={backToChat} /></View>;
  }
  return (
    <View testID="autopilot-answer-bar" style={[styles.answerBar, { paddingBottom: bottom + 10, borderTopColor: colors.border, backgroundColor: colors.surface }]}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  bold: { fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bar: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingRight: 8 },
  position: { flex: 1, textAlign: 'right' },
  content: { padding: 14, gap: 12 },
  section: { borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 14 },
  chevronBox: { width: 16, alignItems: 'center' },
  sectionBody: { gap: 10, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14, borderTopWidth: StyleSheet.hairlineWidth },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 14, borderTopWidth: StyleSheet.hairlineWidth },
  docDetail: { maxWidth: '40%' },
  answerBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  pick: { flex: 1, textAlign: 'center', paddingVertical: 12 },
  input: { minHeight: 44, maxHeight: 120, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});
