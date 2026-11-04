import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database';
import { PaneError } from '../../../shared/paneError';
import { FakeKeychain } from '../test/fakeKeychain';
import { memorySecretStore } from '../test/memorySecretStore';
import type { PaneSecretStore } from './paneSecrets';
import { ProjectEnvService } from './projectEnvVars';

describe('project environment variables', () => {
  let tempDir: string;
  let db: DatabaseService;
  let keychain: FakeKeychain;
  let service: ProjectEnvService;
  let secrets: PaneSecretStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-project-env-service-'));
    db = new DatabaseService(path.join(tempDir, 'sessions.db'));
    db.initialize();
    keychain = new FakeKeychain();
    secrets = memorySecretStore(keychain);
    service = new ProjectEnvService(db, () => keychain, () => secrets);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a Pane secret from a typed value and keeps only its address', async () => {
    const project = db.createProject('cura', '/repos/cura');

    const saved = await service.save(project.id, [
      { key: 'UIVERIFY_API_KEY', source: 'secret', project: 'cura', name: 'UIVERIFY', value: 'sk-live-123' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);

    expect(saved).toEqual([
      { key: 'UIVERIFY_API_KEY', source: 'secret', project: 'cura', name: 'UIVERIFY' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);
    expect(await secrets.read('cura', 'UIVERIFY')).toBe('sk-live-123');
    expect(JSON.stringify(service.list(project.id))).not.toContain('sk-live-123');
    expect(fs.readFileSync(path.join(tempDir, 'sessions.db')).includes('sk-live-123')).toBe(false);
  });

  it('reads a Pane secret at each resolve, so a changed secret reaches the next process', async () => {
    const project = db.createProject('cura', '/repos/cura');
    await secrets.set('shared', 'TOKEN', 'first');
    await service.save(project.id, [{ key: 'API_TOKEN', source: 'secret', project: 'shared', name: 'TOKEN' }]);
    await expect(service.resolve(project.id)).resolves.toEqual({ env: { API_TOKEN: 'first' }, warnings: [] });

    await secrets.set('shared', 'TOKEN', 'second');

    await expect(service.resolve(project.id)).resolves.toEqual({ env: { API_TOKEN: 'second' }, warnings: [] });
  });

  it('skips a variable whose Pane secret is missing and says why without any value', async () => {
    const project = db.createProject('cura', '/repos/cura');
    await service.save(project.id, [
      { key: 'API_TOKEN', source: 'secret', project: 'shared', name: 'TOKEN', value: 'sk-live-123' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);
    await secrets.delete('shared', 'TOKEN');

    const resolved = await service.resolve(project.id);

    expect(resolved.env).toEqual({ NODE_ENV: 'development' });
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('API_TOKEN');
    expect(resolved.warnings[0]).toContain('shared/TOKEN');
    expect(resolved.warnings[0]).not.toContain('sk-live-123');
  });

  it('keeps Pane secrets when their variable or project is removed', async () => {
    const project = db.createProject('cura', '/repos/cura');
    keychain.set('conductor', 'uiverify', 'theirs');
    await service.save(project.id, [
      { key: 'OWN', source: 'secret', project: 'cura', name: 'OWN', value: 'mine' },
      { key: 'THEIRS', source: 'keychain', service: 'conductor', account: 'uiverify' },
    ]);

    await service.clear(project.id);

    expect(service.list(project.id)).toEqual([]);
    expect(await secrets.read('cura', 'OWN')).toBe('mine');
    expect(keychain.get('conductor', 'uiverify')).toBe('theirs');
  });

  it('resolves plain values and keychain references for the project', async () => {
    const project = db.createProject('cura', '/repos/cura');
    keychain.set('conductor', 'uiverify', 'from-conductor');
    await service.save(project.id, [
      { key: 'UIVERIFY_API_KEY', source: 'keychain', service: 'conductor', account: 'uiverify' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);

    await expect(service.resolve(project.id)).resolves.toEqual({
      env: { UIVERIFY_API_KEY: 'from-conductor', NODE_ENV: 'development' },
      warnings: [],
    });
  });

  it('resolves a Pane\'s variables from its own project only', async () => {
    const cura = db.createProject('cura', '/repos/cura');
    const other = db.createProject('other', '/repos/other');
    await service.save(cura.id, [{ key: 'UIVERIFY_API_KEY', source: 'plain', value: 'cura-only' }]);
    for (const [id, projectId] of [['cura-pane', cura.id], ['other-pane', other.id]] as const) {
      db.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: `/w/${id}`, project_id: projectId, tool_type: 'none' });
    }

    await expect(service.resolveForSession('cura-pane')).resolves.toEqual({ env: { UIVERIFY_API_KEY: 'cura-only' }, warnings: [] });
    await expect(service.resolveForSession('other-pane')).resolves.toEqual({ env: {}, warnings: [] });
    await expect(service.resolveForSession('no-such-pane')).resolves.toEqual({ env: {}, warnings: [] });
  });

  it('refuses invalid, reserved and duplicate names and saves nothing', async () => {
    const project = db.createProject('cura', '/repos/cura');
    await service.save(project.id, [{ key: 'KEEP', source: 'plain', value: '1' }]);

    for (const inputs of [
      [{ key: '1BAD', source: 'plain', value: 'x' }],
      [{ key: 'PANE_PORT', source: 'plain', value: 'x' }],
      [{ key: 'PATH', source: 'plain', value: 'x' }],
      [{ key: 'A', source: 'plain', value: 'x' }, { key: 'A', source: 'plain', value: 'y' }],
      [{ key: 'A', source: 'keychain', service: '', account: 'x' }],
      [{ key: 'A', source: 'secret', project: 'bad project', name: 'A', value: 'x' }],
      [{ key: 'A', source: 'secret', project: 'qa', name: 'PATH', value: 'x' }],
    ] as const) {
      await expect(service.save(project.id, [...inputs])).rejects.toBeInstanceOf(PaneError);
    }
    expect(service.list(project.id)).toEqual([{ key: 'KEEP', source: 'plain', value: '1' }]);
    expect(secrets.list()).toEqual([]);
  });

  it('refuses keychain variables where the keychain is unsupported, and warns at spawn', async () => {
    const project = db.createProject('cura', '/repos/cura');
    await service.save(project.id, [{ key: 'TOKEN', source: 'keychain', service: 'svc', account: 'acct' }]);
    keychain.supported = false;

    await expect(service.save(project.id, [{ key: 'TOKEN', source: 'keychain', service: 'svc', account: 'other' }]))
      .rejects.toMatchObject({ code: 'KEYCHAIN_UNSUPPORTED' });
    const resolved = await service.resolve(project.id);
    expect(resolved.env).toEqual({});
    expect(resolved.warnings[0]).toMatch(/TOKEN.*macOS/);
  });
});
