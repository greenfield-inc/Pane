import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { saveErrorMessage, useAffordances, useSaveHostSettings } from '@/features/hosts/hostSettings';
import { VoiceKeyField } from '@/features/voice/VoiceKeyField';
import { hostNeedsUpdate, maskSecrets, voiceKeysFor, type VoiceKey } from '@/features/voice/voiceKeys';
import { useTheme } from '@/theme';
import { Button, ErrorState, Screen, Text } from '@/ui';

/** Settings › Voice: which voice keys the host has, and replacing them. Saved there, never shown again. */
export default function VoiceSettingsScreen() {
  const theme = useTheme();
  const { profile } = useDaemon();
  const affordances = useAffordances();
  const save = useSaveHostSettings();
  const [typed, setTyped] = useState<Partial<Record<VoiceKey, string>>>({});
  const [editing, setEditing] = useState<VoiceKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const host = affordances.data?.voiceTranscription;
  const [deepgram, openRouter] = host ? voiceKeysFor('streaming', host) : [];
  const [fal] = host ? voiceKeysFor('recorded', host) : [];
  const keys = deepgram && fal && openRouter ? [deepgram, fal, openRouter] : [];
  const needsUpdate = host ? hostNeedsUpdate('streaming', host) || hostNeedsUpdate('recorded', host) : false;
  const entries = keys.flatMap(({ key }) => {
    const value = typed[key]?.trim();
    return value ? [[key, value] as const] : [];
  });

  const submit = async () => {
    const secrets = entries.map(([, value]) => value);
    setError(null);
    try {
      await save.mutateAsync(Object.fromEntries(entries));
      // Saved on the host; the phone keeps no copy.
      setTyped({});
      setEditing([]);
      setSaved(true);
    } catch (cause) {
      setError(maskSecrets(saveErrorMessage(cause, profile.label), secrets));
    } finally {
      // Drop the request, keys included, from the mutation's memory whatever happened.
      save.reset();
    }
  };

  return (
    <Screen scroll testID="voice-settings">
      <Text variant="subhead" tone="secondary">
        Dictation runs on <Text variant="subhead" style={styles.bold}>{profile.label}</Text>. Live mode needs a Deepgram key and recorded mode a fal key. With an OpenRouter key, the host also cleans up the text.
      </Text>
      {affordances.isPending ? (
        <ActivityIndicator color={theme.colors.textMuted} />
      ) : affordances.isError ? (
        <ErrorState error={affordances.error} onRetry={() => void affordances.refetch()} />
      ) : (
        <View style={styles.form}>
          {keys.map(({ key, set, optional }) => (
            <VoiceKeyField
              key={key}
              voiceKey={key}
              set={set}
              optional={optional}
              asking={editing.includes(key)}
              value={typed[key] ?? ''}
              onChange={value => {
                setSaved(false);
                setTyped(current => ({ ...current, [key]: value }));
              }}
              onReplace={() => setEditing(current => [...current, key])}
            />
          ))}
          {needsUpdate ? (
            <Text variant="footnote" tone="secondary" testID="voice-settings-update">
              Update Pane on {profile.label} to use voice without OpenRouter.
            </Text>
          ) : null}
          {error ? (
            <Text variant="footnote" tone="danger" testID="voice-settings-error" accessibilityLiveRegion="polite">{error}</Text>
          ) : saved ? (
            <Text variant="footnote" tone="secondary" testID="voice-settings-saved" accessibilityLiveRegion="polite">Saved to {profile.label}.</Text>
          ) : (
            <Text variant="footnote" tone="muted">
              Sent once over this phone's connection and stored on {profile.label}. Pane never shows a saved key again.
            </Text>
          )}
          {editing.length > 0 ? (
            <Button testID="voice-settings-save" title="Save" disabled={entries.length === 0} loading={save.isPending} onPress={() => void submit()} />
          ) : null}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '600' },
  form: { gap: 14 },
});
