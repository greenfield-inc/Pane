import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

import { Focusable } from './Focusable';
import { FocusScope } from './FocusScope';

/** The keys a controller's X offers in a terminal; Shift+Tab is the back-tab sequence. */
const KEY_PAD_KEYS = [
  { label: 'Esc', data: '\x1b' },
  { label: '^C', data: '\x03' },
  { label: 'Tab', data: '\t' },
  { label: 'Shift+Tab', data: '\x1b[Z' },
] as const;

/**
 * X's key pad over a terminal: pick a key with the D-pad and A to send it to
 * the agent. B or X closes it. Touch works on it too.
 */
export function KeyPad({ onKey, onClose }: { onKey(data: string): void; onClose(): void }) {
  const theme = useTheme();
  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <FocusScope context="keypad" also="open-key-pad" onBack={onClose} style={[styles.pad, { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border }]}>
        {KEY_PAD_KEYS.map((key, index) => (
          <Focusable key={key.label} preferred={index === 0} onActivate={() => onKey(key.data)}>
            <Pressable
              testID={`controller-key-${key.label}`}
              accessibilityRole="button"
              accessibilityLabel={key.label}
              onPress={() => onKey(key.data)}
              style={({ pressed }) => [styles.key, { borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface }]}
            >
              <Text variant="callout">{key.label}</Text>
            </Pressable>
          </Focusable>
        ))}
      </FocusScope>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 16 },
  pad: { flexDirection: 'row', gap: 8, padding: 8, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  key: { minWidth: 56, height: 40, paddingHorizontal: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});
