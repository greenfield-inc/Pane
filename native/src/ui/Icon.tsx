import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';

import { useTheme } from '@/theme';

export interface IconProps {
  /** SF Symbol name (iOS). */
  ios: SFSymbol;
  /** Material Symbol name (Android). */
  android: AndroidSymbol;
  size?: number;
  color?: string;
}

export function Icon({ ios, android, size = 20, color }: IconProps) {
  const theme = useTheme();
  return (
    <SymbolView
      name={{ ios, android }}
      size={size}
      tintColor={color ?? theme.colors.textMuted}
      resizeMode="scaleAspectFit"
    />
  );
}
