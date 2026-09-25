import { useColorScheme } from 'react-native';

import { colors, radius, spacing, typography } from './tokens';

export function useTheme() {
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark';
  return { scheme, colors: colors[scheme], spacing, radius, typography } as const;
}
