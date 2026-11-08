import { describe, expect, it } from 'vitest';
import {
  buildInterceptionSets,
  collectActiveBindings,
  findChordConflicts,
  normalizeKeyboardShortcutOverrides,
  resolveEffectiveChord,
} from '../../../shared/utils/keyboardBindings';

describe('keyboard bindings', () => {
  it('normalizes valid overrides and diagnoses invalid data', () => {
    expect(normalizeKeyboardShortcutOverrides({
      'open-settings': 'SHIFT+MOD+P', unknown: 'mod+x', 'new-session': 'x', 'new-project': null,
      'zoom-toggle': 'mod+k  mod+z',
    })).toEqual({
      overrides: { 'open-settings': 'mod+shift+p', 'new-project': null, 'zoom-toggle': 'mod+k mod+z' },
      diagnostics: expect.arrayContaining([
        expect.stringContaining('unknown'), expect.stringContaining('new-session'),
      ]),
    });
    expect(normalizeKeyboardShortcutOverrides('bad').diagnostics).toHaveLength(1);
  });

  it('resolves explicit, null, and per-platform default bindings', () => {
    expect(resolveEffectiveChord('focus-sidebar', { 'focus-sidebar': 'mod+shift+e' }, 'mac')).toBe('mod+shift+e');
    expect(resolveEffectiveChord('focus-sidebar', { 'focus-sidebar': null }, 'mac')).toBeNull();
    expect(resolveEffectiveChord('focus-sidebar', {}, 'mac')).toBe('mod+0');
    expect(resolveEffectiveChord('toggle-terminal', {}, 'mac')).toBe('ctrl+`');
    expect(resolveEffectiveChord('toggle-terminal', {}, 'other')).toBe('mod+`');
    expect(resolveEffectiveChord('cycle-tab-next-d', {}, 'mac')).toBe('mod+shift+]');
    expect(resolveEffectiveChord('cycle-tab-next-d', {}, 'other')).toBe('mod+PageDown');
    expect(resolveEffectiveChord('next-machine', {}, 'other')).toBe('mod+alt+shift+]');
    expect(resolveEffectiveChord('next-machine', { 'next-machine': 'ctrl+]' }, 'other')).toBe('mod+]');
  });

  it.each(['mac', 'other'] as const)('has no conflicts in the default keymap on %s', (keyPlatform) => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(findChordConflicts(collectActiveBindings({ keyPlatform, platform, customCommands: [{}, {}, {}, {}] }))).toEqual([]);
    }
  });

  it('finds overlapping conflicts but permits the exclusive usage duplicate', () => {
    const conflicts = findChordConflicts(collectActiveBindings({
      keyPlatform: 'mac',
      overrides: { 'add-tool-terminal-codex': 'mod+alt+3' },
    }));
    expect(conflicts).toContainEqual({
      chord: 'mod+alt+3', ids: ['add-tool-terminal-claude', 'add-tool-terminal-codex'],
    });
    expect(findChordConflicts(collectActiveBindings({
      keyPlatform: 'mac', overrides: { 'run-dev-server': 'mod+s' },
    }))).toEqual([]);
  });

  it('treats a key that starts a two-step key as a conflict', () => {
    expect(findChordConflicts(collectActiveBindings({
      keyPlatform: 'mac', overrides: { 'new-project': 'mod+k' },
    }))).toEqual([{ chord: 'mod+k', ids: ['new-project', 'open-shortcut-settings', 'zoom-toggle'] }]);
    expect(findChordConflicts(collectActiveBindings({
      keyPlatform: 'mac', overrides: { 'new-project': 'mod+k mod+x' },
    }))).toEqual([]);
  });

  it('folds macOS Control into mod off macOS, so ⌃⌘] overrides cannot clash silently', () => {
    expect(findChordConflicts(collectActiveBindings({
      keyPlatform: 'other', overrides: { 'next-machine': 'ctrl+b' },
    }))).toEqual([{ chord: 'mod+b', ids: ['next-machine', 'toggle-sidebar'] }]);
    expect(findChordConflicts(collectActiveBindings({
      keyPlatform: 'mac', overrides: { 'next-machine': 'ctrl+b' },
    }))).toEqual([]);
  });

  it('instantiates custom conflicts only for configured slots and handles malformed arrays', () => {
    const override = { 'add-tool-terminal-claude': 'mod+alt+7' };
    expect(findChordConflicts(collectActiveBindings({ keyPlatform: 'mac', overrides: override, customCommands: [] }))).toEqual([]);
    expect(findChordConflicts(collectActiveBindings({ keyPlatform: 'mac', overrides: override, customCommands: [{}] }))[0]?.ids)
      .toContain('add-tool-custom-0');
    expect(() => collectActiveBindings({ keyPlatform: 'mac', terminalShortcuts: 'bad', customCommands: {} })).not.toThrow();
  });

  it('keeps interception mount-independent and lists two-step keys by first step', () => {
    const sets = buildInterceptionSets({ keyPlatform: 'other', platform: 'win32', customCommands: [] });
    expect(sets.bound.has('mod+alt+5')).toBe(true);
    expect(sets.bound.has('mod+alt+9')).toBe(true);
    expect(sets.bound.has('mod+k')).toBe(false);
    expect([...(sets.sequences.get('mod+k') ?? [])].sort()).toEqual(['mod+m', 'mod+s']);
    expect([...(sets.webviewSequences.get('mod+k') ?? [])].sort()).toEqual(['mod+m', 'mod+s']);
    expect(sets.webviewForward.has('F6')).toBe(true);
    expect(sets.webviewForward.has('shift+ArrowUp')).toBe(false);
  });

  it('releases only navigation keys from full-screen programs on macOS, never Ctrl-letters', () => {
    const sets = buildInterceptionSets({ keyPlatform: 'mac' });
    for (const chord of ['mod+0', 'mod+alt+ArrowRight', 'F6', 'shift+F6', 'mod+shift+m', 'mod+alt+o',
      'mod+ctrl+]', 'mod+ctrl+[', 'mod+ctrl+0', 'mod+shift+[', 'mod+shift+]', 'mod+alt+b', 'ctrl+`']) {
      expect(sets.tuiReleasable.has(chord), chord).toBe(true);
    }
    for (const letter of 'abdekwq') {
      expect(sets.tuiReleasable.has(`ctrl+${letter}`), letter).toBe(false);
      expect(sets.bound.has(`ctrl+${letter}`), letter).toBe(false);
    }
  });
});
