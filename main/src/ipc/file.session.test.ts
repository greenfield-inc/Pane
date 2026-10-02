import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerFileHandlers } from './file';

let directory: string;
let registry: PaneCommandRegistry;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-session-files-'));
  registry = new PaneCommandRegistry();
  // SAFETY: Only these Session fields and service methods are read by file handlers.
  const services = { sessionManager: {
    getSession: (id: string) => ({ id, isHidden: true, worktreePath: directory }),
    getProjectContext: () => undefined,
  } } as AppServices;
  // SAFETY: Registration only uses the IpcMain handle method.
  registerFileHandlers({ handle: vi.fn() } as IpcMain, services, registry);
  await fs.writeFile(path.join(directory, 'notes.md'), 'Session notes');
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('private Session files without a project', () => {
  it.each(['__pane_chat_session__', '__orchestration_session_test__terminal__'])('lists, reads, writes and resolves files for %s', async sessionId => {
    await expect(registry.invoke('file:list', [{ sessionId }])).resolves.toMatchObject({ success: true, files: expect.arrayContaining([expect.objectContaining({ name: 'notes.md' })]) });
    await expect(registry.invoke('file:read', [{ sessionId, filePath: 'notes.md' }])).resolves.toMatchObject({ success: true, content: 'Session notes' });
    await expect(registry.invoke('file:write', [{ sessionId, filePath: 'notes.md', content: 'Updated' }])).resolves.toMatchObject({ success: true });
    expect(await fs.readFile(path.join(directory, 'notes.md'), 'utf8')).toBe('Updated');
    await expect(registry.invoke('file:resolveAbsolutePath', [{ sessionId, path: 'notes.md' }])).resolves.toMatchObject({ success: true, path: path.join(directory, 'notes.md') });
  });
  it('rejects traversal, symlink escapes and unrelated projectless panes', async () => {
    const sessionId = '__pane_chat_session__';
    await expect(registry.invoke('file:read', [{ sessionId, filePath: '../outside' }])).resolves.toMatchObject({ success: false });
    await fs.symlink(os.tmpdir(), path.join(directory, 'outside'));
    await expect(registry.invoke('file:list', [{ sessionId, path: 'outside' }])).resolves.toMatchObject({ success: false });
    await expect(registry.invoke('file:list', [{ sessionId: 'unrelated' }])).resolves.toMatchObject({ success: false, error: 'Project not found for session' });
  });
});
