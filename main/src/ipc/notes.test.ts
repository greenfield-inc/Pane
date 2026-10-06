import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { registerNotesHandlers } from './notes';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { noteSchema, type NoteMutation } from '../../../shared/types/notes';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-notes-routing-'));
  vi.stubEnv('PANE_DIR', path.join(root, 'data'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('CURSOR_CONFIG_DIR', path.join(root, 'cursor'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const projects = [1, 2].map(id => ({ id, name: `Project ${id}`, path: path.join(root, `repo-${id}`) }));
  const panes = [{ id: 'a', projectId: 1 }, { id: 'b', projectId: 1 }, { id: 'c', projectId: 2 }]
    .map(pane => ({ ...pane, name: pane.id, worktreePath: path.join(root, pane.id) }));
  for (const directory of [...projects.map(project => project.path), ...panes.map(pane => pane.worktreePath)]) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), '# Authored instructions\n');
    fs.writeFileSync(path.join(directory, 'CLAUDE.md'), '# Authored Claude instructions\n');
  }
  const config = { agentContext: { managedAgentsMd: false } };
  const configManager = Object.assign(new EventEmitter(), { getConfig: () => config });
  const sessionManager = Object.assign(new EventEmitter(), {
    getSession: (id: string) => panes.find(pane => pane.id === id),
    getSessionsForProject: (id: number) => panes.filter(pane => pane.projectId === id),
  });
  const handlers = new Map<string, (...args: unknown[]) => Promise<{ note?: unknown }>>();
  // SAFETY: this fixture implements only the public service methods exercised by Notes IPC.
  const services = { sessionManager, configManager, getMainWindow: () => null,
    databaseService: { getProject: (id: number) => projects.find(project => project.id === id),
      getAllProjects: () => projects, getMainRepoSession: () => undefined, getAllSessions: () => [] },
  } as AppServices;
  // SAFETY: Electron calls the registered listener with event followed by invocation arguments.
  const ipc = { handle: (name: string, handler: (...args: unknown[]) => Promise<{ note?: unknown }>) => handlers.set(name, handler) } as IpcMain;
  registerNotesHandlers(ipc, services);
  const mutate = async (pane: string, mutation: NoteMutation) => {
    const result = await handlers.get('notes:mutate')!(undefined, pane, mutation);
    return result.note ? decodeBoundary(result.note, noteSchema) : undefined;
  };
  return { projects, panes, config, configManager, sessionManager, mutate };
}

const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Notes IPC delivery', () => {
  it('keeps repository files untouched while each Pane receives only its applicable scoped notes', async () => {
    const { projects, panes, mutate } = fixture();
    await mutate('a', { action: 'create', scope: { kind: 'project', id: '1' }, title: 'Shared project literal' });
    await mutate('a', { action: 'create', scope: { kind: 'feature', id: 'a' }, title: 'Only feature A literal' });
    await mutate('c', { action: 'create', scope: { kind: 'project', id: '2' }, title: 'Other project literal' });
    expect(read('data/notes/contexts/a.md')).toContain('Shared project literal');
    expect(read('data/notes/contexts/a.md')).toContain('Only feature A literal');
    expect(read('data/notes/contexts/a.md')).not.toContain('Other project literal');
    expect(read('data/notes/contexts/b.md')).toContain('Shared project literal');
    expect(read('data/notes/contexts/b.md')).not.toContain('Only feature A literal');
    expect(read('data/notes/contexts/c.md')).toContain('Other project literal');
    expect(read('data/notes/contexts/c.md')).not.toContain('Shared project literal');
    expect(read('claude/CLAUDE.md')).toContain('PANE_NOTES_FILE');
    expect(read('claude/CLAUDE.md')).not.toContain('Shared project literal');
    for (const directory of [...projects.map(project => project.path), ...panes.map(pane => pane.worktreePath)]) {
      expect(fs.readdirSync(directory).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
      expect(fs.readFileSync(path.join(directory, 'AGENTS.md'), 'utf8')).toBe('# Authored instructions\n');
      expect(fs.readFileSync(path.join(directory, 'CLAUDE.md'), 'utf8')).toBe('# Authored Claude instructions\n');
    }
  });

  it('does not let an unreadable notebook interrupt Pane creation or a Settings event', async () => {
    const { mutate, sessionManager, configManager, config } = fixture();
    await mutate('a', { action: 'create', scope: { kind: 'project', id: '1' } });
    fs.writeFileSync(path.join(root, 'data/notes/notes.json'), '[{"futureSchema":true}]');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const laterListener = vi.fn();
    configManager.on('config-updated', laterListener);
    expect(() => sessionManager.emit('session-created', { projectId: 1 })).not.toThrow();
    config.agentContext.managedAgentsMd = true;
    expect(() => configManager.emit('config-updated')).not.toThrow();
    expect(laterListener).toHaveBeenCalledOnce();
  });

  it('removes a redundant Claude memory block after an AGENTS import is added and clears repo exports on opt-out', async () => {
    const { mutate, config, configManager } = fixture();
    config.agentContext.managedAgentsMd = true;
    configManager.emit('config-updated');
    const note = await mutate('a', { action: 'create', scope: { kind: 'project', id: '1' }, title: 'Old note' });
    const claude = path.join(root, 'repo-1/CLAUDE.md');
    fs.writeFileSync(claude, '@AGENTS.md\n' + fs.readFileSync(claude, 'utf8'));
    await mutate('a', { action: 'save', note: { ...note!, title: 'Updated note' } });
    expect(read('repo-1/AGENTS.md')).toContain('Updated note');
    expect(read('repo-1/CLAUDE.md')).not.toContain('pane-memories:start');
    expect(read('repo-1/CLAUDE.md')).toContain('@AGENTS.md\n# Authored Claude instructions\n');
    config.agentContext.managedAgentsMd = false;
    configManager.emit('config-updated');
    expect(read('repo-1/AGENTS.md')).not.toContain('pane-memories:start');
    expect(read('a/AGENTS.md')).not.toContain('pane-memories:start');
    expect(read('data/notes/contexts/a.md')).toContain('Updated note');
  });
});
