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
  return entries.map((entry) => entry.type === 'separator' ? '---' : `${entry.label}${entry.enabled ? '' : ' (disabled)'}`);
}

function menuFor(selection: string, overrides: Partial<TerminalContextMenuContext> = {}): ContextMenuEntry[] {
  return terminalContextMenuEntries({
    selection,
    targets: findSelectionTargets(selection, '/repo', '/Users/dev'),
    hasSession: true,
    notesEnabled: false,
    isRemoteMode: false,
    isMac: false,
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
    expect(menuFor('words', { isMac: true })[0]).toMatchObject({ accelerator: 'Cmd+C' });
  });

  it('lets main perform Paste', () => {
    expect(menuFor('')[1]).toMatchObject({ type: 'paste', id: 'paste' });
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
    expect(decodeBoundary(menuFor('see https://example.com', { notesEnabled: true }), contextMenuEntriesSchema)).toHaveLength(8);
    expect(decodeBoundary('open-url', terminalContextMenuChoiceSchema)).toBe('open-url');
    expect(decodeBoundary(null, terminalContextMenuChoiceSchema)).toBeNull();
    expect(() => decodeBoundary('format-disk', terminalContextMenuChoiceSchema)).toThrow();
  });
});
