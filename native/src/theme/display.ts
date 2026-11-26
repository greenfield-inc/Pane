import type { TextStyle, ViewStyle } from 'react-native';

/** UI scale, as on the desktop (Settings › Appearance): 0.8x to 1.5x in steps of 0.1. */
export const UI_SCALE = { min: 0.8, max: 1.5, default: 1 } as const;

/** Terminal font size in px: the desktop's range (Settings › Terminal), starting at the phone's own 12. */
export const TERMINAL_FONT = { min: 10, max: 24, default: 12 } as const;

/** The UI scale `steps` tenths away, kept in range. */
export function stepUiScale(scale: number, steps: number): number {
  return clamp(Math.round(scale * 10 + steps) / 10, UI_SCALE.min, UI_SCALE.max);
}

/** The terminal font size `steps` px away, kept in range. */
export function stepTerminalFont(size: number, steps: number): number {
  return clamp(Math.round(size) + steps, TERMINAL_FONT.min, TERMINAL_FONT.max);
}

/** A saved UI scale, or the default when nothing valid was saved. */
export function parseUiScale(saved: string | null): number {
  const value = Number(saved);
  return saved !== null && Number.isFinite(value) ? stepUiScale(value, 0) : UI_SCALE.default;
}

/** A saved terminal font size, or the default when nothing valid was saved. */
export function parseTerminalFont(saved: string | null): number {
  const value = Number(saved);
  return saved !== null && Number.isFinite(value) ? stepTerminalFont(value, 0) : TERMINAL_FONT.default;
}

/** A text style drawn at the UI scale: its font size, line height and letter spacing. */
export function scaleType<Style extends TextStyle>(style: Style, scale: number): Style {
  if (scale === 1) return style;
  const scaled = { ...style };
  if (style.fontSize !== undefined) scaled.fontSize = style.fontSize * scale;
  if (style.lineHeight !== undefined) scaled.lineHeight = style.lineHeight * scale;
  if (style.letterSpacing !== undefined) scaled.letterSpacing = style.letterSpacing * scale;
  return scaled;
}

/** A fixed box that holds a line of text or an icon, at the UI scale: its width and height. */
export function scaleBox<Style extends ViewStyle>(style: Style, scale: number): Style {
  if (scale === 1) return style;
  const scaled = { ...style };
  if (typeof style.width === 'number') scaled.width = style.width * scale;
  if (typeof style.height === 'number') scaled.height = style.height * scale;
  return scaled;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
