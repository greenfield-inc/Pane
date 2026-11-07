import * as Haptics from 'expo-haptics';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { originLine } from '@shared/approvalReceipts';
import { decisionModel, type DecisionModel, type DecisionOption } from '@shared/autopilotDecision';
import type { NotifyAnswer, NotifyItem } from '@shared/types/notify';

import { useDaemon } from '@/daemon';
import { sinceLabel } from '@/features/allMachines/allMachinesList';
import { ApprovalActions } from '@/features/approvals/ApprovalActions';
import { receiptLines } from '@/features/approvals/approvals';
import { useNotifyCommand } from '@/features/notify/hooks';
import { useTheme, withAlpha } from '@/theme';
import { Icon, Text } from '@/ui';

import { answerBar, cardState, type CardState } from './autopilot';

type Glyph = { ios: SFSymbol; android: AndroidSymbol };

const KIND_ICON: Record<DecisionModel['kind'], Glyph> = {
  Approval: { ios: 'checkmark.circle', android: 'check_circle' },
  Question: { ios: 'questionmark.circle', android: 'help' },
  Permission: { ios: 'exclamationmark.shield', android: 'gpp_maybe' },
  Autopilot: { ios: 'location', android: 'near_me' },
};

/** The card's top line after its kind: Q-n, and "its own" on Autopilot's. Who asked is the origin line below. */
function decisionMeta(model: DecisionModel): string {
  return [model.qn, model.byAutopilot ? 'its own' : undefined].filter(Boolean).join(' · ');
}

/**
 * Sends a card's answer through Approvals' path (`notify:remote-command`), so the desktop and every
 * other screen see it at once. `onAccepted` runs when the computer took it (held for Undo there).
 */
export function useDecisionAnswer(notifyId: string, onAccepted?: () => void) {
  const command = useNotifyCommand(sent => {
    if (sent.type !== 'answer') return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onAccepted?.();
  });
  const sending = command.isPending && command.variables[0].type === 'answer' ? command.variables[0].answer : undefined;
  return {
    answer: (answer: NotifyAnswer) => command.mutate([{ type: 'answer', id: notifyId, answer }]),
    undo: () => command.mutate([{ type: 'undo', id: notifyId }]),
    busy: command.isPending,
    sending,
    error: command.isError ? command.error.message : null,
  };
}

function sameAnswer(a: NotifyAnswer | undefined, b: NotifyAnswer): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Autopilot's decision card (D-77): kind · Q-n and its age, the origin line, the question, a
 * one-line why, then the options with the recommended one marked, its receipts, and Close, Override
 * or Reopen. In the chat (`chat`) an option
 * answers at once and the footer opens the approval full screen; on that screen (`full`) the
 * options answer only when there are more than two (two or fewer are the buttons at the bottom).
 * Autopilot's own items are violet. An answered card collapses to its answer.
 */
export function DecisionCard({ notifyId, item, variant, onOpen, answer }: {
  notifyId: string;
  item: NotifyItem | undefined;
  variant: 'chat' | 'full';
  onOpen?: () => void;
  answer: ReturnType<typeof useDecisionAnswer>;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const state = cardState(item);
  if (!item) {
    return (
      <View testID={`decision-gone-${notifyId}`} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <View style={styles.head}><Text variant="subhead" tone="muted">An earlier item. It is no longer waiting.</Text></View>
      </View>
    );
  }
  const model = decisionModel(item);
  const tint = model.byAutopilot ? colors.autopilot : colors.warning;
  const open = state.kind === 'open';
  const border = open ? (model.byAutopilot ? withAlpha(colors.autopilot, 0.7) : withAlpha(colors.warning, 0.75)) : colors.border;
  const pickable = open && model.answerable && (variant === 'chat' || answerBar(model, state) === 'pick');

  return (
    <View testID={`decision-card-${notifyId}`} accessibilityLabel={`${model.kind}: ${model.title}`} style={[styles.card, { borderColor: border, backgroundColor: colors.surface }]}>
      <View style={styles.head}>
        <View style={styles.metaRow}>
          <Icon {...(open ? KIND_ICON[model.kind] : { ios: 'checkmark.circle', android: 'check_circle' })} size={16} color={open ? tint : state.kind === 'closed' ? colors.textMuted : colors.success} />
          <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.fill}>
            <Text variant="footnote" style={[styles.bold, { color: model.byAutopilot ? colors.autopilotText : colors.textSecondary }]}>{model.kind}</Text>
            {decisionMeta(model) ? ` · ${decisionMeta(model)}` : ''}
          </Text>
          {open ? <Text variant="footnote" tone="muted">{sinceLabel(model.createdAt, Date.now())}</Text> : null}
        </View>
        <Text testID="decision-origin" variant="footnote" tone="muted" numberOfLines={1}>{originLine(item, profile.label)}</Text>
        <Text testID="decision-title" variant="headline" selectable style={[styles.title, !open && { color: colors.textSecondary }]}>{model.title}</Text>
        {open && model.why ? <Text variant="subhead" tone="secondary" numberOfLines={variant === 'chat' ? 2 : undefined}>{model.why}</Text> : null}
        {open ? receiptLines(item).map(line => <Text key={line} testID="decision-receipt" variant="footnote" tone="secondary">{line}</Text>) : null}
      </View>
      {open ? (
        <>
          {model.options.map(option => (
            <OptionRow key={option.key} testID={`decision-option-${notifyId}-${option.key}`} option={option} divider={colors.border} pickable={pickable && !answer.busy}
              sending={sameAnswer(answer.sending, option.answer)} onPick={() => answer.answer(option.answer)} />
          ))}
          {variant === 'chat' && model.freeText && model.options.length === 0 ? (
            <FooterLink testID={`decision-type-${notifyId}`} glyph={{ ios: 'square.and.pencil', android: 'edit' }} label="Type your answer" onPress={onOpen} />
          ) : null}
        </>
      ) : <Outcome state={state} undo={answer.undo} busy={answer.busy} />}
      <ApprovalActions item={item} style={styles.itemActions} />
      {answer.error ? <Text testID="decision-error" variant="footnote" tone="danger" style={styles.error}>{answer.error} Nothing else changed; check the card before answering again.</Text> : null}
      {/* An answered card collapses to its answer (round 4, screen 5). */}
      {variant === 'chat' && onOpen && open ? (
        <FooterLink testID={`decision-open-${notifyId}`} glyph={{ ios: 'square.stack.3d.up', android: 'layers' }} label="More context and related docs" onPress={onOpen} />
      ) : null}
    </View>
  );
}

function OptionRow({ option, divider, pickable, sending, onPick, testID }: { option: DecisionOption; divider: string; pickable: boolean; sending: boolean; onPick: () => void; testID: string }) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={pickable ? 'button' : 'text'}
      accessibilityLabel={option.recommended ? `${option.label}, recommended` : option.label}
      accessibilityHint={pickable ? 'Answers with this option' : undefined}
      disabled={!pickable}
      onPress={onPick}
      style={({ pressed }) => [styles.option, { borderTopColor: divider, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
    >
      {/* Fixed box: the radio and the sending spinner swap without moving the label. */}
      <View style={styles.radioBox}>
        {sending ? <ActivityIndicator size="small" color={colors.textSecondary} /> : (
          <View style={[styles.radio, { borderColor: option.recommended ? colors.text : colors.border }]}>
            {option.recommended ? <View style={[styles.dot, { backgroundColor: colors.text }]} /> : null}
          </View>
        )}
      </View>
      <View style={styles.fill}>
        <View style={styles.optionLabel}>
          <Text variant="body" style={styles.shrink}>{option.label}</Text>
          {option.recommended ? (
            <View style={[styles.pill, { backgroundColor: withAlpha(colors.success, 0.14) }]}>
              <Text variant="caption" style={{ color: colors.success }}>Recommended</Text>
            </View>
          ) : null}
        </View>
        {option.detail ? <Text variant="subhead" tone="muted">{option.detail}</Text> : null}
      </View>
    </Pressable>
  );
}

function Outcome({ state, undo, busy }: { state: CardState; undo: () => void; busy: boolean }) {
  const theme = useTheme();
  const { colors } = theme;
  if (state.kind === 'open') return null;
  if (state.kind === 'closed') {
    return <View style={[styles.option, { borderTopColor: colors.border }]}><Text testID="decision-closed" variant="subhead" tone="secondary" style={styles.fill}>{state.message}</Text></View>;
  }
  return (
    <View testID={`decision-${state.kind}`} style={[styles.option, { borderTopColor: colors.border }]}>
      <View style={styles.radioBox}><Icon ios="checkmark.circle" android="check_circle" size={18} color={colors.success} /></View>
      <View style={styles.fill}>
        <Text variant="body" tone="secondary">{state.answer}</Text>
        <Text variant="subhead" tone="muted">{state.kind === 'answered' ? state.recorded : 'by you · sending, you can still undo it'}</Text>
      </View>
      {state.kind === 'held' ? (
        <Pressable testID="decision-undo" accessibilityRole="button" accessibilityLabel="Undo" disabled={busy} hitSlop={8} onPress={undo} style={styles.undo}>
          <Text variant="callout" tone="accent">Undo</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function FooterLink({ label, glyph, onPress, testID }: { label: string; glyph: Glyph; onPress?: () => void; testID: string }) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Pressable testID={testID} accessibilityRole="link" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.footer, { borderTopColor: colors.border, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}>
      <Icon {...glyph} size={17} color={colors.accentText} />
      <Text variant="body" tone="accent" style={styles.fill}>{label}</Text>
      <Icon ios="chevron.right" android="chevron_right" size={14} color={colors.accentText} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  bold: { fontWeight: '600' },
  card: { borderWidth: 1.5, borderRadius: 16, overflow: 'hidden' },
  head: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, gap: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 17, lineHeight: 23 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, minHeight: 52 },
  radioBox: { width: 22, height: 24, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  optionLabel: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
  undo: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth },
  error: { paddingHorizontal: 14, paddingBottom: 10 },
  itemActions: { paddingHorizontal: 14, paddingBottom: 12 },
});
