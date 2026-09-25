import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { QUICK_KEYS } from './keys';

export interface QuickKeysProps {
  onKey: (data: string) => void;
  /** Pastes the clipboard into the draft. */
  onPaste: () => void;
  /** Clears the terminal's scrollback, here and on the host. */
  onReset: () => void;
  shortcutsOpen: boolean;
  onToggleShortcuts: () => void;
  disabled?: boolean;
}

/** The web app's row of keys under the input: Paste, the control keys, Reset and Shortcuts. */
export function QuickKeys({ onKey, onPaste, onReset, shortcutsOpen, onToggleShortcuts, disabled = false }: QuickKeysProps) {
  return (
    <View style={styles.row} testID="terminal-quick-keys">
      <Key
        testID="quick-key-paste"
        label="Paste"
        hint="Pastes the clipboard into the input"
        icon={{ ios: 'doc.on.clipboard', android: 'content_paste' }}
        disabled={disabled}
        onPress={onPaste}
      />
      {QUICK_KEYS.map(key => (
        <Key
          key={key.id}
          testID={`quick-key-${key.id}`}
          label={key.label}
          hint={key.hint}
          disabled={disabled}
          onPress={() => onKey(key.data)}
        />
      ))}
      <Key testID="quick-key-reset" label="Reset" hint="Clears the terminal scrollback" disabled={disabled} onPress={onReset} />
      <Key
        testID="terminal-shortcuts"
        label="Shortcuts"
        icon={{ ios: 'command', android: 'keyboard_command_key' }}
        expanded={shortcutsOpen}
        disabled={disabled}
        onPress={onToggleShortcuts}
      />
    </View>
  );
}

function Key({ label, hint, icon, expanded, disabled, onPress, testID }: {
  label: string;
  hint?: string;
  icon?: { ios: SFSymbol; android: AndroidSymbol };
  /** For a key that opens a panel: whether it is open. */
  expanded?: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.key,
        {
          borderRadius: theme.radius.md,
          borderColor: colors.border,
          backgroundColor: pressed || expanded ? colors.surfacePressed : colors.surface,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {icon ? <Icon ios={icon.ios} android={icon.android} size={14} color={colors.textSecondary} /> : null}
      <Text variant="callout" tone="secondary">{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  key: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
  },
});
