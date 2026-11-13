import { describe, expect, it } from 'vitest';
import { decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { contextMenuEntriesSchema, type ContextMenuEntry } from '../../../../shared/types/contextMenu';
import {
  findSelectionTargets,
  terminalContextMenuChoiceSchema,
  terminalContextMenuEntries,
  type TerminalContextMenuContext,
} from './terminalSelectionActions';

function labels(entries: ContextMenuEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'separator') return '---';
    if (entry.type === 'look-up') return `Look Up ${entry.text}`;
    return `${entry.label}${entry.enabled ? '' : ' (disabled)'}`;
  });
}

function menuFor(selection: string, overrides: Partial<TerminalContextMenuContext> = {}): ContextMenuEntry[] {
  return terminalContextMenuEntries({
    selection,
    targets: findSelectionTargets(selection, '/repo', '/Users/dev'),
    hasSession: true,
    notesEnabled: false,
    isRemoteMode: false,
    isMac: false,
    keyboardShortcutsEnabled: true,
    ...overrides,
  });
}

describe('findSelectionTargets', () => {
  it('takes the URL out of the words around it', () => {
    expect(findSelectionTargets('error: https://example.com/a?b=1 failed', '/repo')).toEqual({ url: 'https://example.com/a?b=1', file: null });
  });

  it('resolves a file path against the working directory', () => {
    expect(findSelectionTargets(' src/app.ts:12 ', '/repo')).toEqual({ url: null, file: { absolutePath: '/repo/src/app.ts', relativePath: 'src/app.ts' } });
  });

  it('finds nothing in plain words', () => {
    expect(findSelectionTargets('just some words', '/repo')).toEqual({ url: null, file: null });
  });
});

describe('terminalContextMenuEntries', () => {
  it('offers Paste and Select All, with Copy disabled, when nothing is selected', () => {
    expect(labels(menuFor(''))).toEqual(['Copy (disabled)', 'Paste', '---', 'Select All']);
  });

  it('shows the copy key for the platform', () => {
    expect(menuFor('words')[0]).toMatchObject({ id: 'copy', enabled: true, accelerator: 'Ctrl+Shift+C' });
    expect(menuFor('words', { isMac: true }).find((entry) => entry.type === 'item' && entry.id === 'copy')).toMatchObject({ accelerator: 'Cmd+C' });
  });

  it('lets main perform Paste, labelled with a key only where that key pastes', () => {
    expect(menuFor('')[1]).toMatchObject({ type: 'paste', id: 'paste', accelerator: 'Ctrl+V' });
    expect(menuFor('', { keyboardShortcutsEnabled: false })[1]).toMatchObject({ type: 'paste', accelerator: undefined });
    expect(menuFor('', { isMac: true, keyboardShortcutsEnabled: false })[1]).toMatchObject({ type: 'paste', accelerator: 'Cmd+V' });
  });

  it('starts with Look Up for a selection on macOS, as the edit menu did', () => {
    expect(labels(menuFor(' words ', { isMac: true })).slice(0, 3)).toEqual(['Look Up words', '---', 'Copy']);
    expect(labels(menuFor('', { isMac: true }))[0]).toBe('Copy (disabled)');
    expect(labels(menuFor('words'))[0]).toBe('Copy');
  });

  it('adds the browser actions for a URL', () => {
    expect(labels(menuFor('see https://example.com'))).toEqual(['Copy', 'Paste', '---', 'Select All', '---', 'Open in Browser', 'Open URL']);
    expect(labels(menuFor('https://example.com', { hasSession: false }))).toEqual(['Copy', 'Paste', '---', 'Select All', '---', 'Open URL']);
  });

  it('adds Show in Explorer for a path, disabled where it cannot work', () => {
    expect(labels(menuFor('src/app.ts')).slice(-1)).toEqual(['Show in Explorer']);
    expect(labels(menuFor('src/app.ts', { isRemoteMode: true })).slice(-1)).toEqual(['Show in Explorer (local only) (disabled)']);
    expect(labels(menuFor('~/.zshrc', { targets: findSelectionTargets('~/.zshrc', '/repo') })).slice(-1)).toEqual(['Show in Explorer (disabled)']);
  });

  it('adds Add to notes for a selection when notes are on', () => {
    expect(labels(menuFor('words', { notesEnabled: true })).slice(-1)).toEqual(['Add to notes']);
    expect(labels(menuFor('', { notesEnabled: true }))).not.toContain('Add to notes');
  });

  it('builds menus main accepts, and reads its answer', () => {
    expect(decodeBoundary(menuFor('see https://example.com', { notesEnabled: true, isMac: true }), contextMenuEntriesSchema)).toHaveLength(10);
    expect(decodeBoundary('open-url', terminalContextMenuChoiceSchema)).toBe('open-url');
    expect(decodeBoundary(null, terminalContextMenuChoiceSchema)).toBeNull();
    expect(() => decodeBoundary('format-disk', terminalContextMenuChoiceSchema)).toThrow();
  });
});
