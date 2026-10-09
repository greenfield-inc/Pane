import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Notes } from './notes';
import { exportNoteMemories } from './noteExports';
import { exportCursorMemoryHook } from './cursorNoteHook';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function notebook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-notes-'));
  roots.push(root);
  return { root, notes: new Notes(root) };
}

describe('Notes', () => {
  it('keeps one editable note after promotion and restart, with references in earlier scopes', () => {
    const { root, notes } = notebook();
    const feature = { kind: 'feature' as const, id: 'worktree-1' };
    const project = { kind: 'project' as const, id: '42' };
    const note = notes.create(feature, 'Checkout');
    const moved = notes.move(note.id, note.revision, project);
    notes.save({ ...moved, blocks: [{ type: 'text', id: 'text-1', text: 'Review before payment' }] });
    const reopened = new Notes(root);
    expect(reopened.list(feature)).toEqual(reopened.list(project));
    expect(reopened.list(project)[0].blocks).toEqual([{ type: 'text', id: 'text-1', text: 'Review before payment' }]);
    expect(reopened.list({ kind: 'project', id: '99' })).toEqual([]);
  });

  it('rejects stale saves without losing the winning edit', () => {
    const { notes } = notebook();
    const note = notes.create({ kind: 'global', id: 'user' }, 'Original');
    notes.save({ ...note, title: 'First editor' });
    expect(() => notes.save({ ...note, title: 'Stale editor' })).toThrow('changed in another view');
    expect(notes.list(note.scope)[0].title).toBe('First editor');
  });

  it('replaces relocated memory blocks, preserves authored bytes, and refuses malformed markers', () => {
    const { root, notes } = notebook();
    const file = path.join(root, 'AGENTS.md');
    const note = notes.create({ kind: 'global', id: 'user' }, 'Checkout');
    const start = '<!-- pane-memories:start -->';
    const end = '<!-- pane-memories:end -->';
    fs.writeFileSync(file, `Before\r\n${start}\nold\n${end}\r\nAfter`);
    exportNoteMemories(root, file, [note]);
    const published = fs.readFileSync(file, 'utf8');
    expect(published.startsWith('Before\r\n')).toBe(true);
    expect(published.endsWith('\r\nAfter')).toBe(true);
    expect(published).toContain('### Checkout');
    exportNoteMemories(root, file, [note]);
    expect(fs.readFileSync(file, 'utf8')).toBe(published);
    fs.writeFileSync(file, `Authored\n${start}\nIncomplete`);
    expect(() => exportNoteMemories(root, file, [note])).toThrow('markers');
    expect(fs.readFileSync(file, 'utf8')).toBe(`Authored\n${start}\nIncomplete`);
    fs.writeFileSync(file, `${start}\nfirst\n${end}\n${start}\nsecond\n${end}`);
    expect(() => exportNoteMemories(root, file, [note])).toThrow('markers');
  });

  it('exports ordered text and drawing labels with resolvable image and editable scene references, then removes memory', () => {
    const { root, notes } = notebook();
    const note = notes.create({ kind: 'global', id: 'user' }, 'Payment');
    const saved = notes.save({ ...note, blocks: [
      { type: 'text', id: 'before', text: 'Start with the cart.' },
      { type: 'drawing', id: 'drawing', title: 'Flow', labels: 'Cart → Payment',
        scene: { type: 'excalidraw', elements: [], files: {} },
        png: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' },
      { type: 'text', id: 'after', text: 'Finish with confirmation.' },
    ] });
    const file = path.join(root, 'user rules', 'memories.mdc');
    exportNoteMemories(root, file, [saved]);
    const markdown = fs.readFileSync(file, 'utf8');
    expect(markdown).toContain('alwaysApply: true');
    expect(markdown.indexOf('Start with')).toBeLessThan(markdown.indexOf('Drawing: Flow'));
    expect(markdown.indexOf('Drawing: Flow')).toBeLessThan(markdown.indexOf('Finish with'));
    expect(markdown).toContain('Labels: Cart → Payment');
    const drawingReference = markdown.match(/\[Editable drawing\]\(([^)]+)\)/)?.[1];
    expect(drawingReference).toBeTruthy();
    const scenePath = path.resolve(path.dirname(file), decodeURIComponent(drawingReference!));
    expect(JSON.parse(fs.readFileSync(scenePath, 'utf8'))).toEqual({ type: 'excalidraw', elements: [], files: {} });
    expect(fs.readFileSync(scenePath.replace('.excalidraw', '.png')).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    fs.truncateSync(scenePath.replace('.excalidraw', '.png'), 8);
    exportNoteMemories(root, file, [saved]);
    expect(fs.readFileSync(scenePath.replace('.excalidraw', '.png')).subarray(-12).toString('hex')).toBe('0000000049454e44ae426082');
    notes.remove(saved.id, saved.revision);
    exportNoteMemories(root, file, notes.list(saved.scope));
    expect(fs.readFileSync(file, 'utf8')).toBe('---\nalwaysApply: true\n---\n\n\n');
  });

  it('adds Cursor session context without replacing existing user hooks or duplicating its own hook', () => {
    const { root } = notebook();
    const file = path.join(root, 'hooks.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, custom: 'keep', hooks: { stop: [{ command: 'user-check' }], sessionStart: [{ command: 'user-start' }] } }));
    exportCursorMemoryHook(root, 'Read the saved payment note.', 'darwin');
    exportCursorMemoryHook(root, 'Read the updated payment note.', 'darwin');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, custom: 'keep', hooks: {
      stop: [{ command: 'user-check' }], sessionStart: [{ command: 'user-start' }, { command: "cat './pane-notes-context.json'" }],
    } });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'pane-notes-context.json'), 'utf8'))).toEqual({ additional_context: 'Read the updated payment note.' });
  });

  it('keeps another Pane data directory from replacing or removing owned memory', () => {
    const first = notebook();
    const second = notebook();
    const file = path.join(first.root, 'AGENTS.md');
    const note = first.notes.create({ kind: 'global', id: 'user' }, 'Primary memory');
    exportNoteMemories(first.root, file, [note]);
    const original = fs.readFileSync(file, 'utf8');
    expect(() => exportNoteMemories(second.root, file, [])).toThrow('another Pane data directory');
    expect(() => exportNoteMemories(second.root, file, [note])).toThrow('another Pane data directory');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('updates symlinked instructions without replacing the link or changing authored permissions', () => {
    const { root, notes } = notebook();
    const target = path.join(root, 'dotfiles.md');
    const link = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(target, 'My instructions\n', { mode: 0o640 });
    fs.symlinkSync(target, link);
    const note = notes.create({ kind: 'global', id: 'user' }, 'Symlink memory');
    exportNoteMemories(root, link, [note]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('My instructions\n');
    expect(fs.readFileSync(target, 'utf8')).toContain('### Symlink memory');
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it('delivers Unicode Cursor memory through legacy Windows code pages', () => {
    const { root } = notebook();
    exportCursorMemoryHook(root, 'Cart → 支払い · 🎨', 'win32');
    const bytes = fs.readFileSync(path.join(root, 'pane-notes-context.json'));
    expect(bytes.every(byte => byte < 128)).toBe(true);
    expect(JSON.parse(bytes.toString('ascii'))).toEqual({ additional_context: 'Cart → 支払い · 🎨' });
  });
});
