import * as Haptics from 'expo-haptics';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { QUICK_KEYS } from './keys';

export interface QuickKeysProps {
  onKey: (data: string) => void;
  /** Host-configured snippets; tapping one inserts its text into the draft. */
  shortcuts: readonly RemotePwaTerminalShortcut[];
  onShortcut: (text: string) => void;
}

export function QuickKeys({ onKey, shortcuts, onShortcut }: QuickKeysProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      contentContainerStyle={styles.row}
      testID="terminal-quick-keys"
    >
      {QUICK_KEYS.map(key => (
        <Key
          key={key.id}
          testID={`quick-key-${key.id}`}
          label={key.label}
          icon={key.icon}
          onPress={() => onKey(key.data)}
        />
      ))}
      {shortcuts.filter(shortcut => shortcut.enabled).map(shortcut => (
        <Key
          key={shortcut.id}
          testID={`terminal-shortcut-${shortcut.id}`}
          label={shortcut.label}
          onPress={() => onShortcut(shortcut.text)}
        />
      ))}
    </ScrollView>
  );
}

function Key({ label, icon, onPress, testID }: {
  label: string;
  icon?: (typeof QUICK_KEYS)[number]['icon'];
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.key,
        {
          backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.sm,
        },
      ]}
    >
      {icon
        ? <Icon ios={icon.ios} android={icon.android} size={15} color={theme.colors.text} />
        : <Text variant="footnote" style={styles.label}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  key: {
    minWidth: 40,
    height: 34,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: { fontFamily: monoFontFamily, fontWeight: '600' },
});
