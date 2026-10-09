import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import type { VoiceTranscriptionMode } from '@shared/types/voiceTranscription';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Button, Icon, Text } from '@/ui';

import { ComposerSheet } from '../composer/ComposerSheet';
import { saveErrorMessage, useSaveHostSettings } from '../hosts/hostSettings';
import type { useVoiceDictation } from './useVoiceDictation';
import { KEY_INFO, VoiceKeyField } from './VoiceKeyField';
import { canStartVoice, hostNeedsUpdate, maskSecrets, voiceKeysFor, type VoiceKey } from './voiceKeys';

/** Long enough for Deepgram to refuse a bad key before the sheet closes. */
const CONFIRM_MS = 2500;

export interface VoiceSetupSheetProps {
  visible: boolean;
  onClose: () => void;
  voice: ReturnType<typeof useVoiceDictation>;
  /** Called once recording has started; `saved` when the sheet saved keys first. */
  onStarted: (saved: boolean) => void;
}

/**
 * Opens from the mic when the host can't record yet. It asks only for the
 * keys the host doesn't have, saves them to the host, then starts recording
 * in the same tap. A host before v2.4.159 also needs OpenRouter, so there the
 * sheet asks for it and suggests updating Pane. Keys the host has show as
 * "Set", never their value; typed keys leave the phone only in the save
 * request and are cleared after it.
 */
export function VoiceSetupSheet({ visible, onClose, voice, onStarted }: VoiceSetupSheetProps) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const save = useSaveHostSettings();
  const [mode, setMode] = useState<VoiceTranscriptionMode>('streaming');
  const [typed, setTyped] = useState<Partial<Record<VoiceKey, string>>>({});
  const [replacing, setReplacing] = useState<VoiceKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const host = voice.host;
  const keys = host ? voiceKeysFor(mode, host) : [];
  const missing = keys.filter(item => !item.set && !item.optional);
  const needsUpdate = host ? hostNeedsUpdate(mode, host) : false;
  const ready = host ? canStartVoice(mode, host, typed) : false;
  const entries = keys.flatMap(({ key }) => {
    const value = typed[key]?.trim();
    return value ? [[key, value] as const] : [];
  });
  const subtitle = needsUpdate
    ? `Dictation runs on ${profile.label}. Its version of Pane also needs an OpenRouter key.`
    : missing.length > 0
      ? `Dictation runs on ${profile.label}. It needs one more key, then recording starts.`
      : `Dictation runs on ${profile.label}. Replace a key, or start recording.`;

  const reset = () => {
    setTyped({});
    setReplacing([]);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    const secrets = entries.map(([, value]) => value);
    setBusy(true);
    setError(null);
    try {
      if (entries.length > 0) await save.mutateAsync(Object.fromEntries(entries));
      // Saved on the host; the phone keeps no copy.
      reset();
      const failure = await voice.start(mode, CONFIRM_MS);
      if (failure) {
        voice.clearError();
        setError(/\b(401|403)\b/.test(failure) ? 'The key was refused. Replace it and try again.' : maskSecrets(failure, secrets));
        return;
      }
      onStarted(entries.length > 0);
    } catch (cause) {
      setError(maskSecrets(saveErrorMessage(cause, profile.label), secrets));
    } finally {
      // Drop the request, keys included, from the mutation's memory whatever happened.
      save.reset();
      setBusy(false);
    }
  };

  return (
    <ComposerSheet visible={visible} onClose={close} testID="voice-setup-sheet">
      <View style={styles.content}>
        <View style={styles.header}>
          <Text variant="headline" accessibilityRole="header">Set up voice on {profile.label}</Text>
          <Text variant="subhead" tone="secondary">{subtitle}</Text>
        </View>
        {keys.map(({ key, set, optional }) => (
          <VoiceKeyField
            key={key}
            voiceKey={key}
            set={set}
            optional={optional}
            asking={!set || replacing.includes(key)}
            value={typed[key] ?? ''}
            onChange={value => setTyped(current => ({ ...current, [key]: value }))}
            onReplace={() => setReplacing(current => [...current, key])}
          />
        ))}
        <Text variant="footnote" tone="muted">
          Sent once over this phone's connection and stored on {profile.label}. Pane never shows a saved key again.
          {missing[0] ? (
            <Text variant="footnote" tone="accent" onPress={() => void Linking.openURL(KEY_INFO[missing[0].key].url)}>
              {` Get a key from ${KEY_INFO[missing[0].key].name}`}
            </Text>
          ) : null}
        </Text>
        {error ? (
          <Text variant="footnote" tone="danger" testID="voice-setup-error" accessibilityLiveRegion="polite">{error}</Text>
        ) : null}
        {needsUpdate && !ready ? (
          <View style={styles.notice}>
            <Text variant="callout" tone="secondary" style={styles.center} testID="voice-setup-update">
              Update Pane on {profile.label} to use voice without OpenRouter.
            </Text>
          </View>
        ) : (
          <Button
            testID="voice-setup-save"
            title={entries.length > 0 || missing.length > 0 ? 'Save and start recording' : 'Start recording'}
            icon={<Icon ios="mic.fill" android="mic" size={15} color={colors.onAccent} />}
            disabled={!ready}
            loading={busy}
            onPress={() => void submit()}
          />
        )}
        <Pressable
          testID="voice-setup-mode"
          accessibilityRole="button"
          onPress={() => {
            reset();
            setMode(mode === 'streaming' ? 'recorded' : 'streaming');
          }}
          style={styles.switchMode}
        >
          <Text variant="callout" tone="accent" style={styles.bold}>
            {mode === 'streaming' ? 'Use recorded mode (fal) instead' : 'Use live mode (Deepgram) instead'}
          </Text>
        </Pressable>
      </View>
    </ComposerSheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 14 },
  header: { gap: 4 },
  // The Button's height, so swapping the notice for the button doesn't move the sheet.
  notice: { minHeight: 44, justifyContent: 'center' },
  center: { textAlign: 'center' },
  bold: { fontWeight: '600' },
  switchMode: { alignItems: 'center', paddingVertical: 4 },
});
