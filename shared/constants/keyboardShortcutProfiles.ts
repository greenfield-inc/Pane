/**
 * Keyboard shortcut profiles: complete default keymaps layered under user
 * overrides. Effective chord = override | unassigned | profile chord |
 * catalog default. A profile map is sparse over the catalog: a missing id
 * keeps the catalog default, `null` ships the command unassigned, and the
 * `{ darwin, other }` form covers keymaps whose Windows/Linux convention is
 * not a mechanical Meta→Ctrl translation of the macOS chords.
 */
import { normalizeEnvironmentPlatform, type KeyboardShortcutId } from './keyboardShortcuts';
import type { JsonValue } from '../validation/boundaryDecoder';

export type KeyboardShortcutProfileId = 'pane' | 'superset';

export interface ShortcutProfileChord {
  darwin: string | null;
  /** Every non-darwin host platform. */
  other: string | null;
}

export interface KeyboardShortcutProfile {
  id: KeyboardShortcutProfileId;
  label: string;
  description: string;
  chords: ReadonlyMap<KeyboardShortcutId, ShortcutProfileChord>;
}

/** Fresh installs (no existing config file) start on this profile. */
export const DEFAULT_PROFILE_FOR_NEW_USERS: KeyboardShortcutProfileId = 'superset';

const both = (chord: string | null): ShortcutProfileChord => ({ darwin: chord, other: chord });
const split = (darwin: string | null, other: string | null): ShortcutProfileChord => ({ darwin, other });

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * Pane's commands on Superset's default keymap
 * (superset-sh/superset apps/desktop/src/renderer/hotkeys/registry.ts).
 * Superset's own Windows/Linux convention shifts printable chords to
 * Ctrl+Shift (plain Ctrl belongs to the shell), hence the split entries.
 * The full mapping rationale, including the displaced-command relocations,
 * lives in briefs/keyboard-shortcut-profiles.md.
 */
const SUPERSET_CHORDS = new Map<KeyboardShortcutId, ShortcutProfileChord>([
  ['open-command-palette', both('mod+shift+k')],
  ['toggle-sidebar', split('mod+l', 'mod+shift+l')],
  ['toggle-detail-panel', split('mod+b', 'mod+shift+b')],
  ['split-right', split('mod+d', 'mod+shift+d')],
  ['split-down', split('mod+shift+d', 'mod+alt+shift+d')],
  ['close-active-tab', split('mod+w', 'mod+shift+w')],
  ['archive-active-session', both('mod+shift+Backspace')],
  ['new-session', split('mod+n', 'mod+shift+n')],
  ['new-project', split('mod+shift+o', 'mod+alt+shift+o')],
  ['cycle-tab-next-d', both('mod+Tab')],
  ['cycle-tab-prev-a', both('mod+shift+Tab')],
  ['cycle-session-next-0', split('mod+alt+ArrowDown', 'mod+alt+shift+ArrowDown')],
  ['cycle-session-prev-0', split('mod+alt+ArrowUp', 'mod+alt+shift+ArrowUp')],
  ['add-tool-terminal', split('mod+t', 'mod+shift+t')],
  ['open-add-tool', split('mod+shift+t', 'mod+alt+shift+t')],
  ['run-dev-server', split('mod+g', 'mod+shift+g')],
  ['open-shortcut-settings', both('mod+shift+/')],
  ['add-tool-explorer', both('mod+alt+o')],
  ['add-tool-terminal-claude', both('mod+alt+c')],
  ['add-tool-terminal-codex', both('mod+alt+x')],
  ['add-tool-terminal-cursor', both('mod+alt+u')],
  ['add-tool-custom-0', both(null)],
  ['add-tool-custom-1', both(null)],
  ['add-tool-custom-2', both(null)],
  ['add-tool-custom-3', both(null)],
  // Displaced by borrowed Superset chords; Superset has no git hotkeys.
  ['git-commit', both('mod+alt+k')],
  ['git-pull', both('mod+alt+l')],
  ['usage-download', both('mod+alt+i')],
  // Superset ships directional pane focus unbound.
  ['focus-group-up', both(null)],
  ['focus-group-down', both(null)],
  ...digits.map((digit): [KeyboardShortcutId, ShortcutProfileChord] => [
    `panel-tab-${digit}`, split(`mod+alt+${digit}`, `mod+alt+shift+${digit}`),
  ]),
  ...digits.map((digit): [KeyboardShortcutId, ShortcutProfileChord] => [
    `switch-session-${digit}`, split(`mod+${digit}`, `mod+shift+${digit}`),
  ]),
]);

export const KEYBOARD_SHORTCUT_PROFILES: readonly KeyboardShortcutProfile[] = [
  {
    id: 'superset',
    label: 'Superset',
    description: 'Matches the default keymap of the Superset agent IDE.',
    chords: SUPERSET_CHORDS,
  },
  {
    id: 'pane',
    label: 'Pane Classic',
    description: "Pane's original default key bindings.",
    chords: new Map<KeyboardShortcutId, ShortcutProfileChord>(),
  },
];

const profilesById = new Map<string, KeyboardShortcutProfile>(
  KEYBOARD_SHORTCUT_PROFILES.map(profile => [profile.id, profile]),
);

/** Unknown or missing values resolve to the classic Pane profile. */
export function normalizeShortcutProfileId(value: JsonValue | undefined): KeyboardShortcutProfileId {
  for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
    if (profile.id === value) return profile.id;
  }
  return 'pane';
}

/**
 * The profile-level default chord for a catalog entry: the profile's chord
 * for the id when it has one (per host platform), otherwise the catalog
 * default. `platform` accepts `process.platform` values or environment names
 * (`macos` normalizes to `darwin`); anything non-darwin uses `other`.
 */
export function profileDefaultChord(
  id: string,
  catalogDefault: string | null,
  profile: KeyboardShortcutProfileId,
  platform: string | undefined,
): string | null {
  // SAFETY: an id outside the catalog union simply misses the map and falls
  // through to the supplied catalog default.
  const entry = profilesById.get(profile)?.chords.get(id as KeyboardShortcutId);
  if (entry === undefined) return catalogDefault;
  return normalizeEnvironmentPlatform(platform ?? '') === 'darwin' ? entry.darwin : entry.other;
}
