import { describe, expect, it } from 'vitest';
import {
  buildShortcutMap,
  filterShortcutRows,
  isRecordableChord,
  labelForId,
  resolveShortcutEnvironment,
} from './shortcutMap';

const base = { environment: 'darwin' };
const row = (map: ReturnType<typeof buildShortcutMap>, id: string) => map.rows.find(candidate => candidate.id === id);

describe('buildShortcutMap', () => {
  it('lists every catalog command with its default as the effective chord when nothing is overridden', () => {
    const map = buildShortcutMap(base);
    expect(row(map, 'add-tool-terminal-claude')).toMatchObject({
      defaultChord: 'mod+alt+3', effectiveChord: 'mod+alt+3', state: 'default', editable: true, origin: 'catalog',
    });
    expect(map.rows.filter(candidate => candidate.id.startsWith('add-tool-custom-'))).toHaveLength(0);
    expect(map.conflicts).toEqual([]);
    expect(map.unknownIdDiagnostics).toEqual([]);
  });

  it('derives customized, unassigned, and invalid states from the raw map', () => {
    const map = buildShortcutMap({
      ...base,
      overridesRaw: { 'add-tool-terminal-claude': 'mod+alt+k', 'toggle-sidebar': null, 'open-settings': 'nope', 'ghost': 'mod+x' },
    });
    expect(row(map, 'add-tool-terminal-claude')).toMatchObject({ effectiveChord: 'mod+alt+k', state: 'customized' });
    expect(row(map, 'toggle-sidebar')).toMatchObject({ effectiveChord: null, state: 'unassigned' });
    expect(row(map, 'open-settings')).toMatchObject({ effectiveChord: 'mod+,', state: 'invalid' });
    expect(map.unknownIdDiagnostics).toEqual([
      'invalid keyboard shortcut open-settings: unsupported-key',
      'unknown keyboard shortcut id: ghost',
    ]);
  });

  it('reports conflicts between catalog commands, snippets, and custom commands in overlapping scopes', () => {
    const map = buildShortcutMap({
      ...base,
      overridesRaw: { 'add-tool-terminal-codex': 'mod+alt+q' },
      terminalShortcuts: [
        { id: 'snip', label: 'Snippet', key: 'q', text: 'x', enabled: true },
        { id: 'off', label: 'Disabled', key: 'q', text: 'x', enabled: false },
      ],
      customCommands: [{ name: 'Lint', command: 'pnpm lint' }],
    });
    expect(row(map, 'add-tool-terminal-codex')?.conflicts).toEqual(['terminal-shortcut-snip']);
    expect(row(map, 'terminal-shortcut-snip')).toMatchObject({ editable: false, origin: 'snippet', conflicts: ['add-tool-terminal-codex'] });
    expect(row(map, 'terminal-shortcut-off')).toBeUndefined();
    expect(row(map, 'add-tool-custom-0')).toMatchObject({ label: 'Add Lint', effectiveChord: 'mod+alt+6' });
  });

  it('validates conflicts globally: a Cursor remap on native Windows still conflicts', () => {
    const map = buildShortcutMap({
      environment: 'win32',
      overridesRaw: { 'add-tool-terminal-cursor': 'mod+alt+3' },
    });
    expect(row(map, 'add-tool-terminal-cursor')).toMatchObject({
      availability: 'unavailable-platform',
      editable: true,
      conflicts: ['add-tool-terminal-claude'],
    });
    expect(row(map, 'add-tool-terminal-claude')?.conflicts).toEqual(['add-tool-terminal-cursor']);
  });

  it('keeps the intentional scoped duplicate between Run Dev Server and Usage Download conflict-free', () => {
    const map = buildShortcutMap(base);
    expect(row(map, 'run-dev-server')?.conflicts).toEqual([]);
    expect(row(map, 'usage-download')?.conflicts).toEqual([]);
  });

  it('normalizes project environments for availability', () => {
    expect(row(buildShortcutMap({ environment: 'windows' }), 'add-tool-terminal-cursor')?.availability).toBe('unavailable-platform');
    expect(row(buildShortcutMap({ environment: 'macos' }), 'add-tool-terminal-cursor')?.availability).toBe('available');
    expect(row(buildShortcutMap({ environment: 'wsl' }), 'add-tool-terminal-cursor')?.availability).toBe('available');
  });

  it('lets a reserved snippet letter participate in conflicts without rejecting it', () => {
    const map = buildShortcutMap({
      ...base,
      overridesRaw: { 'toggle-sidebar': 'mod+alt+f' },
      terminalShortcuts: [{ id: 'find', label: 'Find snippet', key: 'f', text: 'x', enabled: true }],
    });
    expect(row(map, 'terminal-shortcut-find')?.conflicts).toEqual(['toggle-sidebar']);
  });
});

describe('helpers', () => {
  it('filters by label, id, or chord', () => {
    const { rows } = buildShortcutMap(base);
    expect(filterShortcutRows(rows, 'codex').map(candidate => candidate.id)).toEqual(['add-tool-terminal-codex']);
    expect(filterShortcutRows(rows, 'mod+alt+3').map(candidate => candidate.id)).toEqual(['add-tool-terminal-claude']);
  });

  it('labels snippet, custom, catalog, and unknown ids', () => {
    const sources = {
      terminalShortcuts: [{ id: 'snip', label: 'Lint snippet', key: 'l', text: 'x', enabled: true }],
      customCommands: [{ name: 'Lint', command: 'pnpm lint' }],
    };
    expect(labelForId('terminal-shortcut-snip', sources)).toBe('Lint snippet');
    expect(labelForId('add-tool-custom-0', sources)).toBe('Add Lint');
    expect(labelForId('add-tool-custom-3', sources)).toBe('Add custom tool 4');
    expect(labelForId('toggle-sidebar', sources)).toBe('Toggle Sidebar');
    expect(labelForId('mystery', sources)).toBe('mystery');
  });

  it('refuses reserved chords for recordings but grandfathers a row default', () => {
    expect(isRecordableChord('mod+alt+f', { ownDefault: 'mod+b' })).toEqual({ ok: false, reason: 'reserved-by-terminal' });
    expect(isRecordableChord('mod+shift+k', { ownDefault: 'mod+shift+k' })).toEqual({ ok: true });
    expect(isRecordableChord('mod+shift+p', { ownDefault: 'mod+shift+p' })).toEqual({ ok: true });
    expect(isRecordableChord('mod+alt+x', { ownDefault: 'mod+b' })).toEqual({ ok: true });
  });

  it('prefers the active project environment over the host platform', () => {
    expect(resolveShortcutEnvironment('wsl', 'win32')).toBe('wsl');
    expect(resolveShortcutEnvironment('macos', 'linux')).toBe('darwin');
    expect(resolveShortcutEnvironment(undefined, 'win32')).toBe('win32');
  });
});
