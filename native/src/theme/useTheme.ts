import { useColorScheme } from 'react-native';

import { chatColors } from './chatTokens';

import { colors, machineColors, radius, spacing, terminalColors, typography } from './tokens';

export function useTheme() {
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark';
  return { scheme, chat: chatColors[scheme], colors: colors[scheme], machine: machineColors[scheme], terminal: terminalColors[scheme], spacing, radius, typography } as const;
}
