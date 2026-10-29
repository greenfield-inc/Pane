import type { Theme } from '../contexts/themeContextValue';

export type ThemeFamily = 'Standard' | 'Neon' | 'Editorial' | 'Retro' | 'Atmosphere' | 'Accessibility';

export interface ThemeOption {
  id: Theme;
  label: string;
  /** One-line vibe shown under the label in theme pickers. */
  description: string;
  /** Picker group. The Appearance Select renders one labelled group per family; the Home dropdown is flat. */
  family: ThemeFamily;
}

// Picker order: the original themes first (their long-standing order), then the
// 15 batch themes grouped by family — neon, editorial, retro, atmosphere,
// accessibility. Every Theme id must appear here exactly once.
const THEME_OPTIONS = [
  { id: 'light-rounded', label: 'Light (rounded)', description: 'Clean white with rounded, islanded panels', family: 'Standard' },
  { id: 'light', label: 'Light (sharp)', description: 'Clean white, flat edge-to-edge chrome', family: 'Standard' },
  { id: 'forge', label: 'Forge', description: 'IntelliJ-style two-tone graphite with a blue accent', family: 'Standard' },
  { id: 'night-owl', label: 'Night Owl', description: 'Warm rose and crimson, no blue light', family: 'Standard' },
  { id: 'night-owl-oled', label: 'Night Owl (OLED)', description: 'Night Owl on pure-black foundations', family: 'Standard' },
  { id: 'dusk', label: 'Dusk', description: 'Achromatic navy-gray with soft radii', family: 'Standard' },
  { id: 'dusk-oled', label: 'Dusk (OLED)', description: 'Dusk on pure-black foundations', family: 'Standard' },
  { id: 'ember', label: 'Ember', description: 'Synthwave graphite with a copper-pink glow', family: 'Standard' },
  { id: 'aurora', label: 'Aurora', description: 'Rosé Pine-inspired romantic dark', family: 'Standard' },
  { id: 'terracotta', label: 'Terracotta', description: 'Warm dusty earth tones, no blue light', family: 'Standard' },
  { id: 'dark', label: 'Dark (sharp)', description: 'GitHub-style dark, flat edge-to-edge chrome', family: 'Standard' },
  { id: 'oled', label: 'OLED Black (sharp)', description: 'True black for OLED displays', family: 'Standard' },
  { id: 'synthwave', label: 'Synthwave', description: 'Violet-black with magenta and cyan neon accents.', family: 'Neon' },
  { id: 'acid', label: 'Acid Terminal', description: 'Charcoal-black with electric lime and amber accents.', family: 'Neon' },
  { id: 'tokyo-rain', label: 'Tokyo Rain', description: 'Blue-black with pink and blue signage accents.', family: 'Neon' },
  { id: 'folio', label: 'Folio', description: 'Paper & ink — warm cream, near-black type, one vermilion accent.', family: 'Editorial' },
  { id: 'newsprint', label: 'Newsprint', description: 'Cool grey stock, graphite type, halftone surfaces, ink-blue accent.', family: 'Editorial' },
  { id: 'walnut', label: 'Walnut', description: 'Vellum & walnut — warm brown-black, parchment type, brass accent.', family: 'Editorial' },
  { id: 'amber-crt', label: 'Amber CRT', description: 'Amber phosphor on black-brown glass', family: 'Retro' },
  { id: 'teletype', label: 'Teletype', description: 'Brown ink on warm paper, burnt-orange accents', family: 'Retro' },
  { id: 'dot-matrix', label: 'Dot Matrix', description: 'Monochrome LCD green on olive-black', family: 'Retro' },
  { id: 'haar', label: 'Haar', description: 'Pre-dawn sea fog — cold blue-white surfaces, ink text', family: 'Atmosphere' },
  { id: 'abyss', label: 'Abyss', description: 'Deep ocean — near-black navy, bioluminescent teal accent', family: 'Atmosphere' },
  { id: 'understory', label: 'Understory', description: 'Forest floor — moss greens, bark-brown chrome, lichen accent', family: 'Atmosphere' },
  { id: 'colorblind-safe', label: 'Colorblind Safe', description: 'Dark. Okabe-Ito status, diff and terminal colors, readable with any color-vision deficiency.', family: 'Accessibility' },
  { id: 'low-fatigue', label: 'Low Fatigue', description: 'Warm sepia-dark for long sessions: low blue, no pure white, soft ≥4.5:1 text.', family: 'Accessibility' },
  { id: 'high-legibility', label: 'High Legibility', description: 'Light. 7:1+ body text, crisp 3:1 borders and focus rings, color only for state.', family: 'Accessibility' },
] as const satisfies readonly ThemeOption[];

type CoveredTheme = (typeof THEME_OPTIONS)[number]['id'];

// SAFETY: the cast narrows Object.fromEntries' string-keyed result to the ids that are
// literally present in THEME_OPTIONS; assigning that to Record<Theme, string> is a
// compile-time check that every Theme id has an entry (a missing id fails typecheck).
const THEME_LABELS: Record<Theme, string> = Object.fromEntries(
  THEME_OPTIONS.map((option) => [option.id, option.label]),
) as Record<CoveredTheme, string>;

export const getThemeLabel = (theme: Theme): string => THEME_LABELS[theme];

/** Every theme, in picker order. Any theme can fill either System slot, so pickers never filter. */
export const ALL_THEME_OPTIONS: readonly ThemeOption[] = THEME_OPTIONS;

/** THEME_OPTIONS partitioned by family, in first-appearance order. */
export const THEME_OPTION_GROUPS: ReadonlyArray<{ family: ThemeFamily; options: readonly ThemeOption[] }> = (() => {
  const groups: Array<{ family: ThemeFamily; options: ThemeOption[] }> = [];
  for (const option of THEME_OPTIONS) {
    const group = groups.find((g) => g.family === option.family);
    if (group) group.options.push(option);
    else groups.push({ family: option.family, options: [option] });
  }
  return groups;
})();

