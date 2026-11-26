import { StyleSheet, Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { scaleType, useTheme, type ThemeColors, type TypographyVariant } from '@/theme';

type TextTone = 'primary' | 'secondary' | 'muted' | 'accent' | 'danger' | 'onAccent';

const toneColor: Record<TextTone, keyof ThemeColors> = {
  primary: 'text',
  secondary: 'textSecondary',
  muted: 'textMuted',
  accent: 'accentText',
  danger: 'danger',
  onAccent: 'onAccent',
};

export interface TextProps extends RNTextProps {
  variant?: TypographyVariant;
  tone?: TextTone;
}

export function Text({ variant = 'body', tone = 'primary', style, ...props }: TextProps) {
  const theme = useTheme();
  return (
    <RNText
      {...props}
      // The variant is already at the UI scale; a size set in `style` is scaled here.
      style={[theme.typography[variant], { color: theme.colors[toneColor[tone]] }, theme.uiScale === 1 ? style : scaleType(StyleSheet.flatten(style) ?? {}, theme.uiScale)]}
    />
  );
}
