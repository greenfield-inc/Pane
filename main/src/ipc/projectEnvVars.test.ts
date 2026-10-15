import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { DatabaseService } from '../database/database';
import { ProjectEnvService } from '../services/projectEnvVars';
import { FakeKeychain } from '../test/fakeKeychain';
import type { AppServices } from './types';
import { registerProjectHandlers } from './project';

const SECRET = 'sk-live-never-in-the-renderer';
let tempDir: string;
let database: DatabaseService;
let registry: PaneCommandRegistry;
let keychain: FakeKeychain;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-project-env-ipc-'));
  database = new DatabaseService(path.join(tempDir, 'sessions.db'));
  database.initialize();
  keychain = new FakeKeychain();
  // SAFETY: The fixture provides the services the project handlers under test call.
  const services = {
    databaseService: database,
    sessionManager: { getActiveProject: () => undefined, getProjectContextByProjectId: () => undefined, invalidateProjectContext: () => {}, emit: () => true },
  } as AppServices;
  // SAFETY: This registry test only needs IpcMain.handle for channel binding.
  const ipc = { handle: vi.fn() } as IpcMain;
  registry = new PaneCommandRegistry();
  registerProjectHandlers(ipc, services, registry, undefined, new ProjectEnvService(database, () => keychain, 'Pane'));
});

afterEach(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it('stores a keychain secret without ever sending it back to the renderer', async () => {
  const project = database.createProject('cura', path.join(tempDir, 'cura'));

  const saved = await registry.invoke('projects:set-env-vars', [project.id, [
    { key: 'UIVERIFY_API_KEY', source: 'keychain', secret: SECRET },
    { key: 'NODE_ENV', source: 'plain', value: 'development' },
  ]]);
  const listed = await registry.invoke('projects:get-env-vars', [project.id]);
  const projects = await registry.invoke('projects:get-all', []);

  expect(keychain.get('Pane', `${project.id}:UIVERIFY_API_KEY`)).toBe(SECRET);
  expect(listed).toEqual({
    success: true,
    data: [
      { key: 'UIVERIFY_API_KEY', source: 'keychain', service: 'Pane', account: `${project.id}:UIVERIFY_API_KEY`, managed: true },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ],
  });
  expect(saved).toEqual(listed);
  for (const response of [saved, listed, projects]) {
    expect(JSON.stringify(response)).not.toContain(SECRET);
  }
});

it('explains a refused save and keeps the stored variables', async () => {
  const project = database.createProject('cura', path.join(tempDir, 'cura'));
  await registry.invoke('projects:set-env-vars', [project.id, [{ key: 'KEEP', source: 'plain', value: '1' }]]);

  const refused = await registry.invoke('projects:set-env-vars', [project.id, [{ key: 'PANE_PORT', source: 'plain', value: '1' }]]);

  expect(refused).toEqual({ success: false, error: expect.stringMatching(/PANE_PORT is set by Pane itself.*Nothing was saved\. Next: /) });
  await expect(registry.invoke('projects:get-env-vars', [project.id])).resolves.toEqual({
    success: true,
    data: [{ key: 'KEEP', source: 'plain', value: '1' }],
  });
});

it('removes Pane\'s keychain items when the project is deleted', async () => {
  const project = database.createProject('cura', path.join(tempDir, 'cura'));
  await registry.invoke('projects:set-env-vars', [project.id, [{ key: 'TOKEN', source: 'keychain', secret: SECRET }]]);

  await expect(registry.invoke('projects:delete', [String(project.id)])).resolves.toMatchObject({ success: true });

  expect(keychain.size).toBe(0);
});
