import { boundary, decodeBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import { isThemeChoice, type ThemeChoice } from '../../../shared/types/appearance';
import type { StoredBackgroundColors } from '../services/appearanceService';

export const WINDOW_BACKGROUND_COLORS_KEY = 'pane.window-background-colors';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const themeSchema: BoundarySchema<ThemeChoice> = {
  decode(current) {
    const value = boundary.string.decode(current);
    return isThemeChoice(value) ? value : current.fail('expected theme');
  },
};

const backgroundHexSchema: BoundarySchema<string> = {
  decode(current) {
    const value = boundary.string.decode(current).trim().toLowerCase();
    return HEX_COLOR.test(value) ? value : current.fail('expected #rrggbb color');
  },
};

export const windowBackgroundColorSchema = boundary.object({
  theme: themeSchema,
  color: backgroundHexSchema,
});

export function parseStoredBackgroundColors(raw: string | null): StoredBackgroundColors {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establishes the JSON object representation before validating every entry.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const colors: StoredBackgroundColors = {};
    for (const [theme, color] of Object.entries(parsed)) {
      if (!isThemeChoice(theme)) continue;
      try {
        colors[theme] = decodeBoundary(color, backgroundHexSchema);
      } catch {
        // Ignore a corrupt entry without discarding valid theme colors.
      }
    }
    return colors;
  } catch {
    return {};
  }
}
