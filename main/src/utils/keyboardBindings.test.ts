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
    })).toEqual({
      overrides: { 'open-settings': 'mod+shift+p', 'new-project': null },
      diagnostics: expect.arrayContaining([
        expect.stringContaining('unknown'), expect.stringContaining('new-session'),
      ]),
    });
    expect(normalizeKeyboardShortcutOverrides('bad').diagnostics).toHaveLength(1);
  });

  it('resolves explicit, null, and default bindings', () => {
    expect(resolveEffectiveChord('x', { x: 'mod+z' }, 'mod+a')).toBe('mod+z');
    expect(resolveEffectiveChord('x', { x: null }, 'mod+a')).toBeNull();
    expect(resolveEffectiveChord('x', {}, 'mod+a')).toBe('mod+a');
  });

  it('finds overlapping conflicts but permits the exclusive usage duplicate', () => {
    const defaults = collectActiveBindings({});
    expect(findChordConflicts(defaults)).toEqual([]);
    const conflicts = findChordConflicts(collectActiveBindings({
      overrides: { 'add-tool-terminal-codex': 'mod+alt+3' },
    }));
    expect(conflicts).toContainEqual({
      chord: 'mod+alt+3', ids: ['add-tool-terminal-claude', 'add-tool-terminal-codex'],
    });
  });

  it('instantiates custom conflicts only for configured slots and handles malformed arrays', () => {
    const override = { 'add-tool-terminal-claude': 'mod+alt+6' };
    expect(findChordConflicts(collectActiveBindings({ overrides: override, customCommands: [] }))).toEqual([]);
    expect(findChordConflicts(collectActiveBindings({ overrides: override, customCommands: [{}] }))[0]?.ids)
      .toContain('add-tool-custom-0');
    expect(() => collectActiveBindings({ terminalShortcuts: 'bad', customCommands: {} })).not.toThrow();
  });

  it('keeps interception mount- and platform-independent', () => {
    const sets = buildInterceptionSets({ platform: 'win32', customCommands: [] });
    expect(sets.bound.has('mod+alt+5')).toBe(true);
    expect(sets.bound.has('mod+alt+9')).toBe(true);
  });
});
