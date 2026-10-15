import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database';
import { PaneError } from '../../../shared/paneError';
import { FakeKeychain } from '../test/fakeKeychain';
import { ProjectEnvService } from './projectEnvVars';

describe('project environment variables', () => {
  let tempDir: string;
  let db: DatabaseService;
  let keychain: FakeKeychain;
  let service: ProjectEnvService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-project-env-service-'));
    db = new DatabaseService(path.join(tempDir, 'sessions.db'));
    db.initialize();
    keychain = new FakeKeychain();
    service = new ProjectEnvService(db, () => keychain, 'Pane');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores a typed secret in Pane\'s keychain item and keeps only the reference', async () => {
    const project = db.createProject('cura', '/repos/cura');

    const saved = await service.save(project.id, [
      { key: 'UIVERIFY_API_KEY', source: 'keychain', secret: 'sk-live-123' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);

    expect(keychain.get('Pane', `${project.id}:UIVERIFY_API_KEY`)).toBe('sk-live-123');
    expect(saved).toEqual([
      { key: 'UIVERIFY_API_KEY', source: 'keychain', service: 'Pane', account: `${project.id}:UIVERIFY_API_KEY`, managed: true },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);
    expect(JSON.stringify(service.list(project.id))).not.toContain('sk-live-123');
    expect(fs.readFileSync(path.join(tempDir, 'sessions.db')).includes('sk-live-123')).toBe(false);
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

  it('skips a variable whose keychain item cannot be read and says why without its value', async () => {
    const project = db.createProject('cura', '/repos/cura');
    await service.save(project.id, [
      { key: 'UIVERIFY_API_KEY', source: 'keychain', secret: 'sk-live-123' },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);
    keychain.fail('Pane', `${project.id}:UIVERIFY_API_KEY`, 'User interaction is not allowed.');

    const resolved = await service.resolve(project.id);

    expect(resolved.env).toEqual({ NODE_ENV: 'development' });
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('UIVERIFY_API_KEY');
    expect(resolved.warnings[0]).toContain('User interaction is not allowed');
    expect(resolved.warnings[0]).not.toContain('sk-live-123');
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

  it('keeps an existing Pane-managed secret when the renderer sends its reference back', async () => {
    const project = db.createProject('cura', '/repos/cura');
    const [stored] = await service.save(project.id, [{ key: 'TOKEN', source: 'keychain', secret: 'first' }]);
    if (stored.source !== 'keychain') throw new Error('expected a keychain variable');

    await service.save(project.id, [{ key: 'TOKEN', source: 'keychain', service: stored.service, account: stored.account }]);

    expect(keychain.get('Pane', `${project.id}:TOKEN`)).toBe('first');
  });

  it('deletes Pane\'s keychain item when its variable is removed, but never a referenced item', async () => {
    const project = db.createProject('cura', '/repos/cura');
    keychain.set('conductor', 'uiverify', 'theirs');
    await service.save(project.id, [
      { key: 'OWN', source: 'keychain', secret: 'mine' },
      { key: 'THEIRS', source: 'keychain', service: 'conductor', account: 'uiverify' },
    ]);

    await service.save(project.id, []);

    expect(keychain.get('Pane', `${project.id}:OWN`)).toBeUndefined();
    expect(keychain.get('conductor', 'uiverify')).toBe('theirs');
  });

  it('never deletes a referenced item, even one named like Pane\'s own', async () => {
    const project = db.createProject('cura', '/repos/cura');
    // Another Pane data directory (a dev build, say) may own an item with this name.
    keychain.set('Pane', `${project.id}:TOKEN`, 'another-instance');
    await service.save(project.id, [{ key: 'TOKEN', source: 'keychain', service: 'Pane', account: `${project.id}:TOKEN` }]);

    await service.save(project.id, []);

    expect(keychain.get('Pane', `${project.id}:TOKEN`)).toBe('another-instance');
  });

  it('keeps Pane\'s own item after a rename and deletes it once nothing uses it', async () => {
    const project = db.createProject('cura', '/repos/cura');
    const [stored] = await service.save(project.id, [{ key: 'OLD', source: 'keychain', secret: 'kept' }]);
    if (stored.source !== 'keychain') throw new Error('expected a keychain variable');

    const [renamed] = await service.save(project.id, [{ key: 'NEW', source: 'keychain', service: stored.service, account: stored.account }]);
    expect(renamed).toMatchObject({ key: 'NEW', managed: true });
    await expect(service.resolve(project.id)).resolves.toEqual({ env: { NEW: 'kept' }, warnings: [] });

    await service.save(project.id, []);
    expect(keychain.size).toBe(0);
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
    ] as const) {
      await expect(service.save(project.id, [...inputs])).rejects.toBeInstanceOf(PaneError);
    }
    expect(service.list(project.id)).toEqual([{ key: 'KEEP', source: 'plain', value: '1' }]);
  });

  it('refuses keychain variables where the keychain is unsupported, and warns at spawn', async () => {
    const project = db.createProject('cura', '/repos/cura');
    await service.save(project.id, [{ key: 'TOKEN', source: 'keychain', service: 'svc', account: 'acct' }]);
    keychain.supported = false;

    await expect(service.save(project.id, [{ key: 'TOKEN', source: 'keychain', secret: 'x' }]))
      .rejects.toMatchObject({ code: 'KEYCHAIN_UNSUPPORTED' });
    const resolved = await service.resolve(project.id);
    expect(resolved.env).toEqual({});
    expect(resolved.warnings[0]).toMatch(/TOKEN.*macOS/);
  });
});
