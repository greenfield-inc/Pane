import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('checkpointWal', () => {
  it('writes committed rows into the database file, so they survive losing the WAL', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-wal-checkpoint-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'sessions.db');
    const db = new DatabaseService(dbPath);
    db.initialize();
    // Copy only the main file, as a power-off that loses the unsynced WAL would leave it.
    const projectNamesInMainFile = () => {
      const copy = path.join(tempDir, `copy-${Date.now()}-${Math.random()}.db`);
      fs.copyFileSync(dbPath, copy);
      const reader = new Database(copy, { readonly: true });
      try {
        return reader.prepare('SELECT name FROM projects').all();
      } finally {
        reader.close();
      }
    };

    db.checkpointWal();
    db.createProject('Repo', path.join(tempDir, 'repo'));
    expect(projectNamesInMainFile()).toEqual([]);

    db.checkpointWal();

    expect(projectNamesInMainFile()).toEqual([{ name: 'Repo' }]);
    db.close();
  });
});
