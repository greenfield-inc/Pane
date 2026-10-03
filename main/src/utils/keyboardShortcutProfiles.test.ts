import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_FOR_NEW_USERS,
  KEYBOARD_SHORTCUT_PROFILES,
  normalizeShortcutProfileId,
  profileDefaultChord,
} from '../../../shared/constants/keyboardShortcutProfiles';
import { getCatalogEntry } from '../../../shared/constants/keyboardShortcuts';
import {
  collectActiveBindings,
  effectiveDefaultChord,
  findChordConflicts,
  resolveEffectiveChord,
  selectProfileOverridesRaw,
} from '../../../shared/utils/keyboardBindings';
import { parseChord } from '../../../shared/utils/keyboardChords';

/** The default snippets a fresh install ships (configManager) occupy mod+alt+<key>. */
const DEFAULT_SNIPPETS = ['e', 'r', 'd', 's'].map((key, index) => ({
  id: `default-${index}`, key, enabled: true,
}));
const FOUR_CUSTOM_COMMANDS = Array.from({ length: 4 }, (_, index) => ({ name: `Custom ${index}` }));



describe('keyboard shortcut profiles', () => {
  it('references only catalog ids and only parseable canonical chords', () => {
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const [id, chord] of profile.chords) {
        expect(getCatalogEntry(id), `${profile.id}: ${id}`).toBeDefined();
        for (const variant of [chord.darwin, chord.other]) {
          if (variant === null) continue;
          const parsed = parseChord(variant);
          expect(parsed.ok, `${profile.id}: ${id} = ${variant}`).toBe(true);
          if (parsed.ok) expect(parsed.chord, `${profile.id}: ${id} must be canonical`).toBe(variant);
        }
      }
    }
  });

  it('is conflict-free on both platform variants with default snippets and full custom slots', () => {
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const hostPlatform of ['darwin', 'linux', 'win32']) {
        const conflicts = findChordConflicts(collectActiveBindings({
          profile: profile.id,
          hostPlatform,
          terminalShortcuts: DEFAULT_SNIPPETS,
          customCommands: FOUR_CUSTOM_COMMANDS,
        }));
        expect(conflicts, `${profile.id} on ${hostPlatform}`).toEqual([]);
      }
    }
  });

  it('matches Superset fidelity spot checks per platform', () => {
    expect(effectiveDefaultChord('open-command-palette', 'superset', 'darwin')).toBe('mod+shift+k');
    expect(effectiveDefaultChord('add-tool-terminal', 'superset', 'darwin')).toBe('mod+t');
    expect(effectiveDefaultChord('add-tool-terminal', 'superset', 'linux')).toBe('mod+shift+t');
    expect(effectiveDefaultChord('switch-session-3', 'superset', 'darwin')).toBe('mod+3');
    expect(effectiveDefaultChord('switch-session-3', 'superset', 'win32')).toBe('mod+shift+3');
    expect(effectiveDefaultChord('panel-tab-4', 'superset', 'darwin')).toBe('mod+alt+4');
    expect(effectiveDefaultChord('add-tool-terminal-claude', 'superset', 'darwin')).toBe('mod+alt+c');
    expect(effectiveDefaultChord('focus-group-up', 'superset', 'darwin')).toBeNull();
    expect(effectiveDefaultChord('add-tool-custom-0', 'superset', 'linux')).toBeNull();
    // The pane profile is the untouched catalog.
    expect(effectiveDefaultChord('add-tool-terminal-claude', 'pane', 'darwin')).toBe('mod+alt+3');
    expect(effectiveDefaultChord('open-command-palette', 'pane', 'linux')).toBe('mod+shift+p');
  });

  it('resolves override | unassigned | profile chord | catalog default in that order', () => {
    const supersetDefault = effectiveDefaultChord('toggle-sidebar', 'superset', 'darwin');
    expect(supersetDefault).toBe('mod+l');
    expect(resolveEffectiveChord('toggle-sidebar', { 'toggle-sidebar': 'mod+alt+9' }, supersetDefault)).toBe('mod+alt+9');
    expect(resolveEffectiveChord('toggle-sidebar', { 'toggle-sidebar': null }, supersetDefault)).toBeNull();
    expect(resolveEffectiveChord('toggle-sidebar', {}, supersetDefault)).toBe('mod+l');
    expect(profileDefaultChord('toggle-terminal', 'mod+`', 'superset', 'darwin')).toBe('mod+`');
  });

  it('normalizes unknown profile ids to pane and keeps superset as the new-user default', () => {
    expect(normalizeShortcutProfileId('superset')).toBe('superset');
    expect(normalizeShortcutProfileId('vscode')).toBe('pane');
    expect(normalizeShortcutProfileId(undefined)).toBe('pane');
    expect(normalizeShortcutProfileId(7)).toBe('pane');
    expect(DEFAULT_PROFILE_FOR_NEW_USERS).toBe('superset');
  });

  it('selects the per-profile override map with the legacy key reserved for pane', () => {
    const config = {
      keyboardShortcutOverrides: { 'toggle-sidebar': 'mod+alt+9' },
      keyboardShortcutProfileOverrides: { superset: { 'toggle-sidebar': 'mod+alt+8' } },
    };
    expect(selectProfileOverridesRaw(config, 'pane')).toEqual({ 'toggle-sidebar': 'mod+alt+9' });
    expect(selectProfileOverridesRaw(config, 'superset')).toEqual({ 'toggle-sidebar': 'mod+alt+8' });
    expect(selectProfileOverridesRaw({}, 'superset')).toBeUndefined();
    expect(selectProfileOverridesRaw(undefined, 'pane')).toBeUndefined();
  });
});
