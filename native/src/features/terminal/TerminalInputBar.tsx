import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { recordingClock } from '../voice/recordingLimits';
import type { useVoiceDictation } from '../voice/useVoiceDictation';

type Voice = ReturnType<typeof useVoiceDictation>;

export interface TerminalInputBarProps {
  draft: string;
  onChangeDraft: (text: string) => void;
  /** Sends the draft followed by Enter, or a bare Enter when the draft is empty. */
  onSubmit: () => void;
  voice: Voice;
  /** Opens Photos, Camera and Files. */
  onAttach: () => void;
  /** Pastes the phone clipboard at the cursor. */
  onPaste: () => void;
  onShortcuts: () => void;
  /** Opens the terminal's recent output as selectable text. */
  onCopy: () => void;
  /** The mic, when the host lacks a voice key: asks for it, then records. */
  onSetupVoice: () => void;
  /** Whether the floating D-pad and joystick show, and the button that shows or hides them. */
  controllerShown: boolean;
  onToggleController: () => void;
  /** Where the cursor is, so inserts land there. */
  onSelectionChange: (selection: { start: number; end: number }) => void;
  /** Moves the cursor after an insert; undefined leaves it to the user. */
  selection?: { start: number; end: number };
  disabled?: boolean;
}

/**
 * One box holds every composer action: the draft on top, then Attach, Paste,
 * Shortcuts and Copy on the left and the mic and Send/Enter on the right.
 * Return adds a line; the button sends. While dictating, the words heard so
 * far show in the box, dimmed and read-only.
 */
export function TerminalInputBar({
  draft, onChangeDraft, onSubmit, voice, onAttach, onPaste, onShortcuts, onCopy, onSetupVoice, controllerShown, onToggleController, onSelectionChange, selection, disabled = false,
}: TerminalInputBarProps) {
  const theme = useTheme();
  const { colors } = theme;
  const voiceBusy = voice.phase !== 'idle';
  const previewing = voiceBusy && voice.preview.length > 0;
  const shown = previewing ? (draft.trim() ? `${draft}${/\s$/.test(draft) ? '' : ' '}${voice.preview}` : voice.preview) : draft;

  return (
    <View style={[styles.box, { borderRadius: theme.radius.lg, borderColor: colors.border, backgroundColor: colors.background }]}>
      <TextInput
        testID="terminal-input"
        value={shown}
        onChangeText={text => !previewing && onChangeDraft(text)}
        onSelectionChange={event => onSelectionChange(event.nativeEvent.selection)}
        selection={previewing ? undefined : selection}
        editable={!disabled && !previewing}
        placeholder="Type, dictate or pick a shortcut"
        placeholderTextColor={colors.textMuted}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        smartInsertDelete={false}
        keyboardAppearance={theme.scheme}
        textAlignVertical="top"
        selectionColor={colors.accent}
        style={[styles.input, { color: previewing ? colors.textMuted : colors.text, opacity: disabled ? 0.5 : 1 }]}
      />
      <View style={styles.actions}>
        <BoxAction testID="terminal-attach" label="Attach files" hint="Copies photos or files to the host and inserts their paths" ios="paperclip" android="attach_file" disabled={disabled} onPress={onAttach} />
        <BoxAction testID="terminal-paste" label="Paste" hint="Pastes the clipboard at the cursor" ios="doc.on.clipboard" android="content_paste" tinted disabled={disabled} onPress={onPaste} />
        <BoxAction testID="terminal-shortcuts" label="Shortcuts" hint="Inserts one of the host's shortcuts" ios="bolt" android="bolt" disabled={disabled} onPress={onShortcuts} />
        <BoxAction testID="terminal-copy" label="Copy from terminal" hint="Shows recent output to copy" ios="doc.on.doc" android="content_copy" disabled={disabled} onPress={onCopy} />
        <View style={styles.spacer} />
        <BoxAction
          testID="terminal-controller-toggle"
          label={controllerShown ? 'Hide controller' : 'Show controller'}
          hint="Shows or hides the arrow keys and scroll joystick over the terminal"
          ios="gamecontroller"
          android="sports_esports"
          selected={controllerShown}
          disabled={false}
          onPress={onToggleController}
        />
        <MicButton voice={voice} disabled={disabled} onSetup={onSetupVoice} />
        <SendButton hasText={draft.trim().length > 0} dimmed={disabled || voiceBusy} onPress={onSubmit} />
      </View>
    </View>
  );
}

function BoxAction({ testID, label, hint, ios, android, tinted: alwaysTinted = false, selected, disabled, onPress }: {
  testID: string;
  label: string;
  hint: string;
  ios: SFSymbol;
  android: AndroidSymbol;
  /** The most-used action, drawn tinted. */
  tinted?: boolean;
  /** A toggle that is on: drawn tinted and announced as selected. */
  selected?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const tinted = alwaysTinted || selected === true;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.action,
        {
          borderRadius: theme.radius.md,
          backgroundColor: pressed ? colors.surfacePressed : tinted ? colors.selected : 'transparent',
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Icon ios={ios} android={android} size={17} color={tinted ? colors.accentText : colors.textSecondary} />
    </Pressable>
  );
}

/**
 * Empty box: outlined "Enter" that sends a bare Enter, to answer a menu or
 * confirm a prompt. With text: filled "Send" that sends it, then Enter. One
 * footprint in every state, so nothing beside it moves.
 */
function SendButton({ hasText, dimmed, onPress }: { hasText: boolean; dimmed: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const send = hasText || dimmed;
  const tint = send ? colors.onAccent : colors.text;
  return (
    <Pressable
      testID="terminal-send"
      accessibilityRole="button"
      accessibilityLabel={hasText ? 'Send' : 'Enter'}
      accessibilityHint={hasText ? 'Sends the text, then Enter' : 'Sends Enter'}
      accessibilityState={{ disabled: dimmed }}
      disabled={dimmed}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.send,
        {
          borderRadius: theme.radius.md,
          borderColor: send ? colors.accent : colors.border,
          backgroundColor: send ? colors.accent : pressed ? colors.surfacePressed : colors.surfaceRaised,
          opacity: dimmed ? 0.5 : pressed && send ? 0.8 : 1,
        },
      ]}
    >
      <Icon ios={send ? 'paperplane.fill' : 'return.left'} android={send ? 'send' : 'keyboard_return'} size={14} color={tint} />
      <Text variant="callout" style={[styles.sendLabel, { color: tint }]}>{send ? 'Send' : 'Enter'}</Text>
    </Pressable>
  );
}

/** The mic; while recording, a red stop key with the elapsed time, then the last minute counting down, beside it. */
function MicButton({ voice, disabled, onSetup }: { voice: Voice; disabled: boolean; onSetup: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const listening = voice.phase === 'listening';
  const busy = voice.phase === 'starting' || voice.phase === 'transcribing';
  const off = !listening && (disabled || busy || !voice.loaded);

  return (
    <View style={styles.micRow}>
      {listening ? <RecordingTime startedAt={voice.startedAt} /> : null}
      <Pressable
        testID="terminal-mic"
        accessibilityRole="button"
        accessibilityLabel={listening ? 'Stop voice recording' : 'Start voice recording'}
        accessibilityHint={voice.available || listening ? undefined : 'Sets up voice on the host first'}
        accessibilityState={{ busy, disabled: off }}
        disabled={off}
        hitSlop={4}
        onPress={() => {
          void Haptics.impactAsync(listening ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium);
          if (voice.available || listening) voice.toggle();
          else onSetup();
        }}
        style={({ pressed }) => [
          styles.action,
          {
            borderRadius: theme.radius.md,
            backgroundColor: listening ? colors.danger : pressed ? colors.surfacePressed : 'transparent',
            opacity: off && !busy ? 0.5 : 1,
          },
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Icon
            ios={listening ? 'stop.fill' : 'mic'}
            android={listening ? 'stop' : 'mic'}
            size={listening ? 14 : 18}
            color={listening ? colors.onAccent : colors.textSecondary}
          />
        )}
      </Pressable>
    </View>
  );
}

/** Time since the hook started recording; in the last minute, the time left. */
function RecordingTime({ startedAt }: { startedAt: number }) {
  const { colors } = useTheme();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Ticks faster than a second so the label turns over within 250 ms of the hook's limit check.
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const clock = recordingClock(now - startedAt);
  return (
    <View style={styles.timer} accessibilityLabel={clock.countdown ? `Recording, ${clock.seconds} seconds left` : `Recording, ${clock.seconds} seconds`}>
      <Icon ios="waveform" android="graphic_eq" size={15} color={colors.danger} />
      <Text variant="footnote" tone="danger" style={styles.timerText}>{clock.label}</Text>
    </View>
  );
}

const ACTION = 32;
const ACTION_MIN = 28;

const styles = StyleSheet.create({
  box: { borderWidth: 1 },
  input: {
    minHeight: 38,
    maxHeight: 160,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
    fontSize: 14,
    lineHeight: 19,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 5, paddingBottom: 5 },
  spacer: { flex: 1 },
  // On a 320 pt screen the row is a few points short; the icon buttons give way, Send/Enter never does.
  action: { width: ACTION, minWidth: ACTION_MIN, flexShrink: 1, height: ACTION, alignItems: 'center', justifyContent: 'center' },
  micRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 4 },
  timer: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  // Wide enough for "14:59", so the count-up and the countdown share one footprint.
  timerText: { width: 38, textAlign: 'right', fontWeight: '600', fontVariant: ['tabular-nums'] },
  send: {
    width: 78,
    height: ACTION,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  sendLabel: { fontSize: 13, fontWeight: '600' },
});
