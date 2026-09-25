import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { monoFontFamily, useTheme } from '@/theme';

import { Text } from './Text';

export interface TextFieldProps extends TextInputProps {
  label?: string;
  error?: string | null;
  hint?: string;
  mono?: boolean;
}

export function TextField({ label, error, hint, mono, style, ...props }: TextFieldProps) {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      {label ? <Text variant="callout" tone="secondary">{label}</Text> : null}
      <TextInput
        placeholderTextColor={theme.colors.textMuted}
        selectionColor={theme.colors.accent}
        accessibilityLabel={label}
        {...props}
        style={[
          theme.typography.body,
          styles.input,
          {
            color: theme.colors.text,
            backgroundColor: theme.colors.surfaceRaised,
            borderColor: error ? theme.colors.danger : theme.colors.border,
            borderRadius: theme.radius.md,
          },
          mono && { fontFamily: monoFontFamily, fontSize: 14 },
          style,
        ]}
      />
      {error ? <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">{error}</Text> : null}
      {!error && hint ? <Text variant="footnote" tone="muted">{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  // PWA inputs: rounded-md, 1px border, bg-secondary, p-3.
  input: { minHeight: 44, padding: 12, borderWidth: 1 },
});
