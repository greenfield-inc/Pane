import * as Clipboard from 'expo-clipboard';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import type { VoiceKey } from './voiceKeys';

export const KEY_INFO: Record<VoiceKey, { name: string; role: string; url: string }> = {
  deepgramApiKey: { name: 'Deepgram', role: 'live transcription', url: 'https://console.deepgram.com' },
  openRouterApiKey: { name: 'OpenRouter', role: 'cleans up the text', url: 'https://openrouter.ai/keys' },
  falApiKey: { name: 'fal', role: 'recorded transcription', url: 'https://fal.ai/dashboard/keys' },
};

export interface VoiceKeyFieldProps {
  voiceKey: VoiceKey;
  /** The host has this key. Its value is never shown. */
  set: boolean;
  optional: boolean;
  /** Show the input instead of the status. */
  asking: boolean;
  value: string;
  onChange: (value: string) => void;
  onReplace: () => void;
}

/** One voice key: its status (Set or Not set) with Replace or Add, or a secure input with Paste. */
export function VoiceKeyField({ voiceKey, set, optional, asking, value, onChange, onReplace }: VoiceKeyFieldProps) {
  const theme = useTheme();
  const { colors } = theme;
  const info = KEY_INFO[voiceKey];
  const box = [styles.input, { borderRadius: theme.radius.card, backgroundColor: colors.card }];

  return (
    <View style={styles.field}>
      <Text variant="sectionLabel" tone="muted" style={styles.label}>
        {optional ? `Clean up text (optional) · ${info.name} key` : `${info.name} key · ${info.role}`}
      </Text>
      {asking ? (
        <View style={[box, { borderColor: value ? colors.accent : colors.cardBorder }]}>
          <TextInput
            testID={`voice-key-${voiceKey}`}
            accessibilityLabel={`${info.name} key`}
            value={value}
            onChangeText={onChange}
            placeholder={optional ? 'Skip to keep the transcript as heard' : `Paste your ${info.name} key`}
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            importantForAutofill="no"
            keyboardAppearance={theme.scheme}
            style={[theme.typography.rowTitle, styles.grow, { color: colors.text }]}
          />
          <Pressable
            testID={`voice-key-paste-${voiceKey}`}
            accessibilityRole="button"
            accessibilityLabel={`Paste ${info.name} key`}
            hitSlop={8}
            onPress={() => void Clipboard.getStringAsync().then(pasted => onChange(pasted.trim()))}
          >
            <Text variant="rowValue" tone="accent" style={styles.bold}>Paste</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[box, { borderColor: colors.cardBorder }]}>
          {set ? <Icon ios="checkmark" android="check" size={14} color={colors.success} /> : null}
          <Text variant="rowTitle" style={[styles.grow, { color: set ? colors.success : colors.textMuted }]} testID={`voice-key-status-${voiceKey}`}>
            {set ? 'Set' : 'Not set'}
          </Text>
          <Pressable testID={`voice-key-replace-${voiceKey}`} accessibilityRole="button" accessibilityLabel={`${set ? 'Replace' : 'Add'} ${info.name} key`} hitSlop={8} onPress={onReplace}>
            <Text variant="rowValue" tone={set ? 'secondary' : 'accent'}>{set ? 'Replace' : 'Add'}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { paddingHorizontal: 4 },
  // A one-row grouped card (ListSection's look) holding the status or the input.
  input: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 9, borderWidth: StyleSheet.hairlineWidth },
  grow: { flex: 1, paddingVertical: 0 },
  bold: { fontWeight: '600' },
});
