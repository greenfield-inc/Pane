import { StyleSheet, Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { scaleType, useTheme, type ThemeColors, type TypographyVariant } from '@/theme';
import { typography } from '@/theme/tokens';

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
  /** The most this text grows, the UI scale and the system's text size together, for text in a fixed space. */
  maxScale?: number;
}

export function Text({ variant = 'body', tone = 'primary', maxScale, style, ...props }: TextProps) {
  const theme = useTheme();
  const scale = maxScale === undefined ? theme.uiScale : Math.min(theme.uiScale, maxScale);
  return (
    <RNText
      maxFontSizeMultiplier={maxScale === undefined ? undefined : maxScale / scale}
      {...props}
      // The theme's variant is already at the UI scale; a capped one and a size set in `style` are scaled here.
      style={[
        scale === theme.uiScale ? theme.typography[variant] : scaleType(typography[variant], scale),
        { color: theme.colors[toneColor[tone]] },
        scale === 1 ? style : scaleType(StyleSheet.flatten(style) ?? {}, scale),
      ]}
    />
  );
}
