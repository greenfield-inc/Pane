import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon } from '@/ui';

import type { useVoiceDictation } from '../voice/useVoiceDictation';

type Voice = ReturnType<typeof useVoiceDictation>;

export interface TerminalInputBarProps {
  draft: string;
  onChangeDraft: (text: string) => void;
  /** Sends the draft followed by Enter. */
  onSubmit: () => void;
  voice: Voice;
  disabled?: boolean;
}

/**
 * The web app's input: a multi-line box with the mic in its corner and a send
 * button beside it. Return adds a line; the send button sends. While dictating,
 * the words heard so far show in the box, dimmed and read-only.
 */
export function TerminalInputBar({ draft, onChangeDraft, onSubmit, voice, disabled = false }: TerminalInputBarProps) {
  const theme = useTheme();
  const { colors } = theme;
  const voiceBusy = voice.phase !== 'idle';
  const previewing = voiceBusy && voice.preview.length > 0;
  const shown = previewing ? (draft.trim() ? `${draft}${/\s$/.test(draft) ? '' : ' '}${voice.preview}` : voice.preview) : draft;
  const canSend = !disabled && !voiceBusy && draft.trim().length > 0;

  return (
    <View style={styles.row}>
      <View style={styles.box}>
        <TextInput
          testID="terminal-input"
          value={shown}
          onChangeText={text => !previewing && onChangeDraft(text)}
          editable={!disabled && !previewing}
          placeholder="Type command or prompt..."
          placeholderTextColor={colors.textMuted}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          keyboardAppearance={theme.scheme}
          textAlignVertical="top"
          style={[
            styles.input,
            {
              color: previewing ? colors.textMuted : colors.text,
              backgroundColor: colors.background,
              borderColor: colors.border,
              borderRadius: theme.radius.md,
              opacity: disabled ? 0.5 : 1,
            },
          ]}
        />
        <MicButton voice={voice} disabled={disabled} />
      </View>
      <Pressable
        testID="terminal-send"
        accessibilityRole="button"
        accessibilityLabel="Send input"
        accessibilityState={{ disabled: !canSend }}
        disabled={!canSend}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onSubmit();
        }}
        style={({ pressed }) => [
          styles.send,
          {
            borderRadius: theme.radius.md,
            backgroundColor: colors.accent,
            opacity: !canSend ? 0.5 : pressed ? 0.8 : 1,
          },
        ]}
      >
        <Icon ios="paperplane" android="send" size={16} color={colors.onAccent} />
      </Pressable>
    </View>
  );
}

function MicButton({ voice, disabled }: { voice: Voice; disabled: boolean }) {
  const theme = useTheme();
  const { colors } = theme;
  const listening = voice.phase === 'listening';
  const busy = voice.phase === 'starting' || voice.phase === 'transcribing';
  const off = !listening && (disabled || busy || !voice.available);

  return (
    <Pressable
      testID="terminal-mic"
      accessibilityRole="button"
      accessibilityLabel={listening ? 'Stop voice recording' : 'Start voice recording'}
      accessibilityState={{ busy, disabled: off }}
      disabled={off}
      hitSlop={4}
      onPress={() => {
        void Haptics.impactAsync(listening ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium);
        voice.toggle();
      }}
      style={({ pressed }) => [
        styles.mic,
        {
          borderRadius: theme.radius.md,
          borderColor: listening ? colors.danger : colors.border,
          backgroundColor: pressed ? colors.surfacePressed : colors.background,
          opacity: off && !busy ? 0.5 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : (
        <Icon
          ios={listening ? 'square' : 'mic'}
          android={listening ? 'stop' : 'mic'}
          size={16}
          color={listening ? colors.danger : colors.textSecondary}
        />
      )}
    </Pressable>
  );
}

const MIC = 36;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  box: { flex: 1, minWidth: 0 },
  input: {
    minHeight: 128,
    maxHeight: 224,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    // Room for the mic in the corner.
    paddingRight: 12 + MIC + 8,
    fontSize: 12,
    lineHeight: 16,
    borderWidth: 1,
  },
  mic: { position: 'absolute', top: 12, right: 12, width: MIC, height: MIC, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  send: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
});
