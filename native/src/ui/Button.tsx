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
    secondary: theme.colors.surfaceRaised,
    plain: 'transparent',
    destructive: theme.colors.surfaceRaised,
  }[variant];
  const tone = variant === 'primary' ? 'onAccent' : variant === 'destructive' ? 'danger' : 'accent';

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
        <Text variant="headline" tone={tone}>{title}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 50, paddingHorizontal: 16, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
});
