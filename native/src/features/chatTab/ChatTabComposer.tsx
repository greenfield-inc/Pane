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
  /** The model and its effort, shown as plain text that opens the settings sheet (D-118). */
  model?: string;
  effort?: string;
  /** The permission mode's name when it never asks (Bypass): a small marker stays on the row. */
  riskyMode?: string;
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
export function ChatTabComposer({ agent, placeholder, disabled, pending, working, canStop, canAttach, model, effort, riskyMode, canConfigure, onDraft, onAttach, onSettings, onStop }: ChatTabComposerProps) {
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
        <Icon ios="plus" android="add" size={22} color={theme.chat.foreground} />
      </ComposerPrimitive.AddAttachment>}
      {riskyMode && <View testID="chat-risky-mode" accessible accessibilityRole="image" accessibilityLabel={`Permissions: ${riskyMode}`} style={styles.marker}>
        <Icon ios="shield.slash" android="remove_moderator" size={15} color={theme.colors.warning} />
      </View>}
      <View style={styles.spacer} />
      <Pressable testID="chat-settings" accessibilityRole="button" accessibilityLabel={`Model and options: ${[model, effort].filter(Boolean).join(' · ') || 'Agent settings'}`}
        disabled={!canConfigure || disabled} onPress={onSettings} style={({ pressed }) => [styles.model, { backgroundColor: pressed ? theme.chat.muted : 'transparent', opacity: !canConfigure || disabled ? 0.5 : 1 }]}>
        {model || effort
          ? <>{model && <Text numberOfLines={1} style={[styles.modelText, { color: theme.chat.foreground }]}>{model}</Text>}
            {effort && <Text numberOfLines={1} style={[styles.modelText, { color: theme.chat.mutedForeground }]}>{effort}</Text>}</>
          : <Text numberOfLines={1} style={[styles.modelText, { color: theme.chat.foreground }]}>Agent settings</Text>}
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
  spacer: { flex: 1 },
  marker: { width: 28, height: 44, alignItems: 'center', justifyContent: 'center' },
  model: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 8, borderRadius: 12 },
  modelText: { fontSize: 16, flexShrink: 1 },
  target: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  thumbs: { gap: 8, paddingHorizontal: 4, paddingTop: 4 },
  thumb: { width: 64, height: 64 },
  thumbImage: { width: 56, height: 56, borderRadius: 8, marginTop: 8 },
  thumbRemove: { position: 'absolute', top: -4, right: -6, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  thumbBadge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
