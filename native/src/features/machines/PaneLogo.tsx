import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { brandColors } from '@/theme';

/** The Pane app icon, drawn from main/assets/icon-source.svg. Its colors are the brand's, in both themes. */
export function PaneLogo({ size = 28 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        <LinearGradient id="pane-logo-silver" x1="0" y1="0" x2="0.85" y2="1">
          <Stop offset="0" stopColor={brandColors.silver[0]} />
          <Stop offset="0.55" stopColor={brandColors.silver[1]} />
          <Stop offset="1" stopColor={brandColors.silver[2]} />
        </LinearGradient>
      </Defs>
      <Rect width="512" height="512" rx="100" fill={brandColors.tile} />
      <G fill="url(#pane-logo-silver)">
        <Path d="M158 120h8c12 0 20 8 20 20v218c0 18-15 33-33 33h-3c-11 0-20-9-20-20V148c0-16 12-28 28-28Z" />
        <Path d="M201 120h88c49 0 85 33 85 77s-36 78-85 78h-88c-4 0-6-3-6-7v-38c0-4 2-7 6-7h88c19 0 30-10 30-26s-11-25-30-25h-88c-4 0-6-3-6-7v-38c0-4 2-7 6-7Z" />
        <Circle cx="374" cy="346" r="45" />
      </G>
    </Svg>
  );
}
