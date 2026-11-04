import { AttachmentPrimitive, ComposerPrimitive, useAuiState } from '@assistant-ui/react-native';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { attachmentPreview } from './chatThread';

/** One attached image in the composer, in assistant-ui's attachment scope. */
function ChatAttachment({ locked }: { locked: boolean }) {
  const theme = useTheme();
  const preview = useAuiState(state => attachmentPreview(state.attachment));
  const number = useAuiState(state => state.composer.attachments.findIndex(attachment => attachment.id === state.attachment.id)) + 1;
  return <AttachmentPrimitive.Root style={styles.thumb}>
    <Image accessibilityLabel={`Attached image ${number}`} source={preview ? { uri: preview } : undefined} style={[styles.thumbImage, { backgroundColor: theme.chat.muted }]} />
    <AttachmentPrimitive.Remove testID="chat-image-remove" accessibilityLabel={`Remove image ${number}`} disabled={locked} style={styles.thumbRemove}>
      <View style={[styles.thumbBadge, { backgroundColor: theme.chat.primary }]}><Icon ios="xmark" android="close" size={10} color={theme.chat.onPrimary} /></View>
    </AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>;
}

export interface ChatTabComposerProps {
  agent: string;
  placeholder: string;
  /** No connection, no agent yet, or the agent stopped: nothing can be sent. */
  disabled: boolean;
  /** A send awaits its receipt: the draft is frozen until it is checked or retried. */
  pending: boolean;
  working: boolean;
  canStop: boolean;
  canAttach: boolean;
  configLabel?: string;
  canConfigure: boolean;
  onDraft: (text: string) => void;
  onAttach: () => void;
  onSettings: () => void;
  onStop: () => void;
}

/**
 * The phone's composer on assistant-ui's primitives: the runtime holds the text and
 * the attached images and hands a send to the screen's onNew. Pane draws it.
 */
export function ChatTabComposer({ agent, placeholder, disabled, pending, working, canStop, canAttach, configLabel, canConfigure, onDraft, onAttach, onSettings, onStop }: ChatTabComposerProps) {
  const theme = useTheme();
  const empty = useAuiState(state => state.composer.isEmpty);
  const attached = useAuiState(state => state.composer.attachments.length > 0);
  const sendDisabled = disabled || pending || empty;
  return <ComposerPrimitive.Root style={[styles.composer, { backgroundColor: theme.chat.card, borderColor: theme.chat.border }]}>
    {attached && <ScrollView horizontal testID="chat-images" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.thumbs}>
      <ComposerPrimitive.Attachments>{() => <ChatAttachment locked={pending} />}</ComposerPrimitive.Attachments>
    </ScrollView>}
    <ComposerPrimitive.Input testID="chat-input" accessibilityLabel={`Message ${agent}`} placeholder={placeholder} placeholderTextColor={theme.chat.mutedForeground}
      onChange={event => onDraft(event.nativeEvent.text)} editable={!pending} multiline style={[styles.input, { color: theme.chat.foreground }]} />
    <View style={styles.actions}>
      {canAttach && <ComposerPrimitive.AddAttachment testID="chat-attach" accessibilityLabel="Attach image" disabled={disabled || pending} onPress={onAttach}
        style={[styles.target, { opacity: disabled || pending ? 0.5 : 1 }]}>
        <Icon ios="plus" android="add" size={18} color={theme.chat.foreground} />
      </ComposerPrimitive.AddAttachment>}
      <Pressable testID="chat-settings" accessibilityRole="button" accessibilityLabel="Agent settings" disabled={!canConfigure || disabled} onPress={onSettings} style={styles.config}>
        <Text numberOfLines={1} variant="footnote" style={{ color: theme.chat.foreground }}>{configLabel || 'Agent settings'}</Text>
        <Icon ios="chevron.down" android="expand_more" size={14} color={theme.chat.mutedForeground} />
      </Pressable>
      {/* Stop cancels the host's turn; the runtime never runs, since the host queues a message sent meanwhile. */}
      {working && <Pressable testID="chat-stop" accessibilityRole="button" accessibilityLabel="Stop" disabled={!canStop} onPress={onStop} style={styles.target}>
        <View style={[styles.send, { backgroundColor: theme.chat.primary }]}><Icon ios="stop.fill" android="stop" size={14} color={theme.chat.onPrimary} /></View>
      </Pressable>}
      <ComposerPrimitive.Send testID="chat-send" accessibilityLabel={working ? 'Queue message' : 'Send message'} disabled={sendDisabled}
        style={[styles.target, { opacity: sendDisabled ? 0.5 : 1 }]}>
        <View style={[styles.send, { backgroundColor: working ? theme.chat.muted : theme.chat.primary }]}><Icon ios="arrow.up" android="arrow_upward" size={16} color={working ? theme.chat.foreground : theme.chat.onPrimary} /></View>
      </ComposerPrimitive.Send>
    </View>
  </ComposerPrimitive.Root>;
}

const styles = StyleSheet.create({
  composer: { borderWidth: 1, borderRadius: 24, padding: 8, gap: 4 },
  input: { minHeight: 40, maxHeight: 160, paddingHorizontal: 10, paddingVertical: 4, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  config: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 6 },
  target: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  send: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  thumbs: { gap: 8, paddingHorizontal: 4, paddingTop: 4 },
  thumb: { width: 64, height: 64 },
  thumbImage: { width: 56, height: 56, borderRadius: 8, marginTop: 8 },
  thumbRemove: { position: 'absolute', top: -4, right: -6, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  thumbBadge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
