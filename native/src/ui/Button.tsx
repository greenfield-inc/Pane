import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  testID?: string;
  accessibilityHint?: string;
}

export function Button({ title, onPress, variant = 'primary', loading, disabled, icon, testID, accessibilityHint }: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || loading;
  const background = {
    primary: theme.colors.accent,
    secondary: theme.colors.surface,
    plain: 'transparent',
    destructive: theme.colors.surface,
  }[variant];
  // PWA buttons: blue filled primary; bordered white secondary with body-colored text.
  const tone = variant === 'primary' ? 'onAccent' : variant === 'destructive' ? 'danger' : variant === 'secondary' ? 'primary' : 'accent';

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: background,
          borderRadius: theme.radius.md,
          borderColor: variant === 'secondary' || variant === 'destructive' ? theme.colors.border : 'transparent',
          opacity: inactive ? 0.5 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <View style={styles.content}>
        {loading ? <ActivityIndicator color={variant === 'primary' ? theme.colors.onAccent : theme.colors.accentText} /> : icon}
        <Text variant="callout" tone={tone} style={styles.label}>{title}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // PWA: rounded-md px-4 py-2.5 text-sm font-semibold, 1px border on outlined buttons.
  base: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 1 },
  label: { fontWeight: '600' },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
});
