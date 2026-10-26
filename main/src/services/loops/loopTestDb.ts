import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';

/** An in-memory database with Pane's real schema and one project (id 1). */
export function createLoopTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8'));
  db.prepare("INSERT INTO projects (id, name, path) VALUES (1, 'Pane', '/repos/pane')").run();
  return db;
}
