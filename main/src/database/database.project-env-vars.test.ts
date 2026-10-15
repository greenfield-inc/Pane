import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database';

const tempDirs: string[] = [];

function tempDatabasePath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-project-env-'));
  tempDirs.push(tempDir);
  return path.join(tempDir, 'sessions.db');
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('project environment variables storage', () => {
  it('keeps each project\'s variables in order across reopens', () => {
    const databasePath = tempDatabasePath();
    const first = new DatabaseService(databasePath);
    first.initialize();
    const cura = first.createProject('cura', '/repos/cura');
    const other = first.createProject('other', '/repos/other');

    first.replaceProjectEnvVars(cura.id, [
      { key: 'UIVERIFY_API_KEY', source: 'keychain', service: 'Pane', account: `${cura.id}:UIVERIFY_API_KEY`, managed: true },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);
    first.replaceProjectEnvVars(other.id, [{ key: 'OTHER', source: 'plain', value: '1' }]);
    first.close();

    const second = new DatabaseService(databasePath);
    second.initialize();
    expect(second.getProjectEnvVars(cura.id)).toEqual([
      { key: 'UIVERIFY_API_KEY', source: 'keychain', service: 'Pane', account: `${cura.id}:UIVERIFY_API_KEY`, managed: true },
      { key: 'NODE_ENV', source: 'plain', value: 'development' },
    ]);
    expect(second.getProjectEnvVars(other.id)).toEqual([{ key: 'OTHER', source: 'plain', value: '1' }]);
    second.close();
  });

  it('replaces the whole list and drops variables that were removed', () => {
    const db = new DatabaseService(tempDatabasePath());
    db.initialize();
    const project = db.createProject('repo', '/repos/repo');
    db.replaceProjectEnvVars(project.id, [
      { key: 'A', source: 'plain', value: '1' },
      { key: 'B', source: 'plain', value: '2' },
    ]);

    db.replaceProjectEnvVars(project.id, [{ key: 'B', source: 'plain', value: '3' }]);

    expect(db.getProjectEnvVars(project.id)).toEqual([{ key: 'B', source: 'plain', value: '3' }]);
    db.close();
  });

  it('keeps whether Pane created each keychain item', () => {
    const db = new DatabaseService(tempDatabasePath());
    db.initialize();
    const project = db.createProject('repo', '/repos/repo');
    db.replaceProjectEnvVars(project.id, [
      { key: 'OWN', source: 'keychain', service: 'Pane', account: `${project.id}:OWN`, managed: true },
      { key: 'LOOKALIKE', source: 'keychain', service: 'Pane', account: `${project.id}:LOOKALIKE`, managed: false },
    ]);

    expect(db.getProjectEnvVars(project.id).map(variable => variable.source === 'keychain' && variable.managed)).toEqual([true, false]);
    db.close();
  });

  it('deletes a project\'s variables with the project', () => {
    const databasePath = tempDatabasePath();
    const db = new DatabaseService(databasePath);
    db.initialize();
    const project = db.createProject('repo', '/repos/repo');
    db.replaceProjectEnvVars(project.id, [{ key: 'A', source: 'plain', value: '1' }]);

    db.deleteProject(project.id);
    db.close();

    const raw = new Database(databasePath);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM project_env_vars').get()).toEqual({ count: 0 });
    raw.close();
  });

  it('adds the table to a database created before project variables existed', () => {
    const databasePath = tempDatabasePath();
    const legacy = new DatabaseService(databasePath);
    legacy.initialize();
    const project = legacy.createProject('repo', '/repos/repo');
    legacy.close();
    const raw = new Database(databasePath);
    raw.exec('DROP TABLE project_env_vars');
    raw.close();

    const upgraded = new DatabaseService(databasePath);
    upgraded.initialize();

    expect(upgraded.getProjectEnvVars(project.id)).toEqual([]);
    upgraded.replaceProjectEnvVars(project.id, [{ key: 'A', source: 'plain', value: '1' }]);
    expect(upgraded.getProjectEnvVars(project.id)).toEqual([{ key: 'A', source: 'plain', value: '1' }]);
    upgraded.close();
  });
});
