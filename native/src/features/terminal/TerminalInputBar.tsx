import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import type { useVoiceDictation } from '../voice/useVoiceDictation';

export interface TerminalInputBarProps {
  draft: string;
  onChangeDraft: (text: string) => void;
  /** Sends the draft followed by Enter. */
  onSubmit: () => void;
  voice: ReturnType<typeof useVoiceDictation>;
  disabled?: boolean;
}

export function TerminalInputBar({ draft, onChangeDraft, onSubmit, voice, disabled }: TerminalInputBarProps) {
  const theme = useTheme();
  const listening = voice.phase === 'listening';
  const canSend = draft.length > 0 && !disabled;

  return (
    <View style={[styles.container, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
      {voice.error ? (
        <Pressable testID="voice-error" onPress={voice.clearError} accessibilityHint="Dismiss">
          <Text variant="footnote" tone="danger" style={styles.note}>{voice.error}</Text>
        </Pressable>
      ) : listening || voice.phase === 'transcribing' ? (
        <Text testID="voice-preview" variant="footnote" tone="secondary" style={styles.note} numberOfLines={2}>
          {voice.phase === 'transcribing' ? 'Transcribing…' : voice.preview || 'Listening…'}
        </Text>
      ) : null}
      <View style={styles.row}>
        <TextInput
          testID="terminal-input"
          value={draft}
          onChangeText={onChangeDraft}
          placeholder="Type a command or prompt"
          placeholderTextColor={theme.colors.textMuted}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          keyboardAppearance={theme.scheme}
          submitBehavior="submit"
          returnKeyType="send"
          onSubmitEditing={() => canSend && onSubmit()}
          style={[
            styles.input,
            {
              color: theme.colors.text,
              backgroundColor: theme.colors.background,
              borderColor: theme.colors.border,
              borderRadius: theme.radius.lg,
            },
          ]}
        />
        {voice.available ? <MicButton voice={voice} /> : null}
        <Pressable
          testID="terminal-send"
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          hitSlop={6}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onSubmit();
          }}
          style={({ pressed }) => [
            styles.round,
            { backgroundColor: canSend ? theme.colors.accent : theme.colors.surfaceRaised, opacity: pressed ? 0.75 : 1 },
          ]}
        >
          <Icon ios="arrow.up" android="arrow_upward" size={17} color={canSend ? theme.colors.onAccent : theme.colors.textMuted} />
        </Pressable>
      </View>
    </View>
  );
}

function MicButton({ voice }: { voice: TerminalInputBarProps['voice'] }) {
  const theme = useTheme();
  const listening = voice.phase === 'listening';
  const busy = voice.phase === 'starting' || voice.phase === 'transcribing';
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (listening) pulse.value = withRepeat(withTiming(0.55, { duration: 700 }), -1, true);
    else {
      cancelAnimation(pulse);
      pulse.value = 1;
    }
  }, [listening, pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Pressable
      testID="terminal-mic"
      accessibilityRole="button"
      accessibilityLabel={listening ? 'Stop dictation' : 'Dictate'}
      accessibilityState={{ busy }}
      disabled={busy}
      hitSlop={6}
      onPress={() => {
        void Haptics.impactAsync(listening ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium);
        voice.toggle();
      }}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: listening ? theme.colors.danger : theme.colors.surfaceRaised, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
      ) : (
        <Animated.View style={pulseStyle}>
          <Icon
            ios={listening ? 'stop.fill' : 'mic.fill'}
            android={listening ? 'stop' : 'mic'}
            size={16}
            color={listening ? theme.colors.onAccent : theme.colors.textSecondary}
          />
        </Animated.View>
      )}
    </Pressable>
  );
}

const ROUND = 34;

const styles = StyleSheet.create({
  container: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, gap: 6 },
  note: { paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: ROUND,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    fontFamily: monoFontFamily,
    fontSize: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  round: { width: ROUND, height: ROUND, borderRadius: ROUND / 2, alignItems: 'center', justifyContent: 'center' },
});
