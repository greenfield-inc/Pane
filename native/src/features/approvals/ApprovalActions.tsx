import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { canClose, canOverride, canReopen } from '@shared/approvalReceipts';
import type { NotifyItem } from '@shared/types/notify';

import { useNotifyCommand } from '@/features/notify/hooks';
import { QuestionForm, type QuestionAction } from '@/features/notify/NotifySheet';
import { Notice } from '@/features/panes/PaneKit';
import { useTheme } from '@/theme';
import { Button, Icon, Text, TextField } from '@/ui';

import type { ConnectedLink, ConnectedTarget } from './approvals';

/** A question's Approve and Deny, or Send, as the approval card draws them. */
export function QuestionActions({ actions }: { actions: readonly QuestionAction[] }) {
  if (actions.length === 0) return null;
  return (
    <View style={styles.actions}>
      {actions.map(action => (
        <View key={action.testID} style={styles.action}>
          <Button
            testID={action.testID}
            title={action.title}
            variant={action.variant === 'danger' ? 'destructive' : 'primary'}
            loading={action.loading}
            disabled={action.disabled}
            onPress={action.onPress}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * Close, Override and Reopen on a card, whichever the item takes, sent to the machine holding it
 * the way an answer is. Override asks again with the question's own controls; the answer goes to
 * the asker as a correction. Never resent here: a lost reply shows the host's message.
 */
export function ApprovalActions({ item, style }: { item: NotifyItem; style?: StyleProp<ViewStyle> }) {
  const [overriding, setOverriding] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const command = useNotifyCommand(sent => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (sent.type === 'override') setOverriding(false);
  });
  const closable = canClose(item);
  const overridable = canOverride(item);
  const reopenable = canReopen(item);
  if (!closable && !overridable && !reopenable) return null;
  const pending = command.isPending ? command.variables[0].type : null;

  // Reopen needs the tab that asked (canReopen); a question asked from a plain shell has none.
  const closeNote = `${item.source.agent} is told you closed it${item.source.panelId ? '. You can reopen it from Answered.' : ', with your reason if you give one.'}`;
  const close = () => {
    const trimmed = reason.trim();
    command.mutate([trimmed ? { type: 'close', id: item.id, reason: trimmed } : { type: 'close', id: item.id }]);
    setClosing(false);
    setReason('');
  };

  return (
    <View style={[styles.stack, style]}>
      {overriding ? (
        <QuestionForm item={item} answer={answer => command.mutate([{ type: 'override', id: item.id, answer }])} busy={command.isPending}>
          {({ fields, actions }) => (
            <>
              {fields}
              <QuestionActions actions={actions} />
            </>
          )}
        </QuestionForm>
      ) : null}
      {closing ? (
        <View style={styles.stack} testID="approval-close-form">
          <TextField testID="approval-close-reason" placeholder="Reason (optional)" value={reason} onChangeText={setReason} autoFocus returnKeyType="done" onSubmitEditing={close} />
          <Text variant="footnote" tone="secondary">{closeNote}</Text>
          <View style={styles.actions}>
            <View style={styles.action}><Button testID="approval-close-cancel" title="Cancel" variant="secondary" onPress={() => { setClosing(false); setReason(''); }} /></View>
            <View style={styles.action}><Button testID="approval-close-confirm" title="Close it" variant="destructive" onPress={close} /></View>
          </View>
        </View>
      ) : null}
      <View style={styles.actions}>
        {closable && !closing ? <View style={styles.action}><Button testID="approval-close" title="Close" variant="secondary" loading={pending === 'close'} disabled={command.isPending} onPress={() => setClosing(true)} /></View> : null}
        {overridable ? <View style={styles.action}><Button testID="approval-override" title={overriding ? 'Cancel' : 'Override'} variant="secondary" disabled={command.isPending} onPress={() => setOverriding(!overriding)} /></View> : null}
        {reopenable ? <View style={styles.action}><Button testID="approval-reopen" title="Reopen" variant="secondary" loading={pending === 'reopen'} disabled={command.isPending} onPress={() => command.mutate([{ type: 'reopen', id: item.id }])} /></View> : null}
      </View>
      {command.isError ? <Notice testID="approval-action-error" danger message={command.error.message} /> : null}
    </View>
  );
}

function openConnected(target: ConnectedTarget) {
  if (target.kind === 'session') router.push({ pathname: '/session/[sessionId]', params: { sessionId: target.sessionId } });
  else if (target.kind === 'pane') router.push({ pathname: '/pane/[paneId]', params: { paneId: target.paneId } });
  // Back to the chat when it's underneath, as it is under its own approval screen.
  else router.dismissTo('/autopilot');
}

const CONNECTED_ICON = {
  session: { ios: 'bubble.left', android: 'chat_bubble' },
  pane: { ios: 'square.stack.3d.up', android: 'layers' },
  autopilot: { ios: 'location', android: 'near_me' },
  machine: { ios: 'desktopcomputer', android: 'desktop_windows' },
} as const;

/** What an opened item is connected to (J32): its Session, Pane, Autopilot or machine, and it opens when the phone can. */
export function ConnectedRow({ link }: { link: ConnectedLink }) {
  const theme = useTheme();
  const { target } = link;
  return (
    <Pressable
      testID={`approval-connected-${link.kind}`}
      accessibilityRole={target ? 'link' : 'text'}
      accessibilityLabel={target ? `Open ${link.text}` : link.text}
      disabled={!target}
      onPress={() => {
        if (target) openConnected(target);
      }}
      style={({ pressed }) => [styles.connected, { borderRadius: theme.radius.md, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised }]}
    >
      <Icon {...CONNECTED_ICON[link.kind]} size={14} color={theme.colors.textSecondary} />
      <Text variant="subhead" numberOfLines={1} style={styles.connectedText}>{link.text}</Text>
      {target ? <Icon ios="chevron.right" android="chevron_right" size={13} color={theme.colors.textMuted} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  action: { flex: 1, maxWidth: 200 },
  connected: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 10 },
  connectedText: { flex: 1, minWidth: 0 },
});
