import { useColorScheme } from 'react-native';

import { chatColors } from './chatTokens';
import { scaleType } from './display';
import { useDisplayPreferences } from './displayPreferences';
import { colors, machineColors, radius, spacing, syntaxColors, terminalColors, typography } from './tokens';

type Typography = typeof typography;
const scaledTypography = new Map<number, Typography>();

/** The type scale at a UI scale, made once per scale so every screen shares it. */
function typographyAt(scale: number): Typography {
  let scaled = scaledTypography.get(scale);
  if (!scaled) {
    scaled = Object.fromEntries(Object.entries(typography).map(([name, style]) => [name, scaleType(style, scale)])) as Typography;
    scaledTypography.set(scale, scaled);
  }
  return scaled;
}

export function useTheme() {
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark';
  /** Settings › Display › UI scale: text and icons draw at this multiple. */
  const uiScale = useDisplayPreferences(state => state.uiScale);
  return { scheme, chat: chatColors[scheme], colors: colors[scheme], machine: machineColors[scheme], terminal: terminalColors[scheme], syntax: syntaxColors[scheme] as Readonly<Record<string, string>>, spacing, radius, typography: typographyAt(uiScale), uiScale } as const;
}
