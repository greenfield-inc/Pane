import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import { importJsonStoreOnce, readImportMarker } from './jsonStoreImport';

describe('importJsonStoreOnce', () => {
  let db: Database.Database;
  let dir: string;
  let file: string;
  const apply = (parsed: JsonValue) => {
    const { items } = decodeBoundary(parsed, boundary.object({ items: boundary.array(boundary.string) }));
    for (const item of items) db.prepare('INSERT INTO rows (id) VALUES (?)').run(item);
    return items.length;
  };
  const rows = () => decodeBoundary(db.prepare('SELECT COUNT(*) AS count FROM rows').get(), boundary.object({ count: boundary.number })).count;

  beforeEach(() => {
    db = new Database(':memory:');
    db.prepare('CREATE TABLE rows (id TEXT PRIMARY KEY)').run();
    dir = mkdtempSync(path.join(os.tmpdir(), 'pane-import-'));
    file = path.join(dir, 'store.json');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('backs up first, moves the rows with a marker, and leaves the source in place', () => {
    const text = JSON.stringify({ items: ['a', 'b'] });
    writeFileSync(file, text);
    const outcome = importJsonStoreOnce(db, { source: 'things', filePath: file, apply, now: () => 42 });
    expect(outcome).toMatchObject({ status: 'imported', marker: { itemCount: 2, importedAt: 42 } });
    expect(rows()).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(readFileSync(`${file}.before-import`, 'utf8')).toBe(text);
    expect(readImportMarker(db, 'things')?.backupPath).toBe(`${file}.before-import`);
  });

  it('does nothing on a second run', () => {
    writeFileSync(file, JSON.stringify({ items: ['a'] }));
    importJsonStoreOnce(db, { source: 'things', filePath: file, apply });
    writeFileSync(file, JSON.stringify({ items: ['a', 'new'] }));
    expect(importJsonStoreOnce(db, { source: 'things', filePath: file, apply }).status).toBe('already');
    expect(rows()).toBe(1);
  });

  it('leaves no rows and no marker when interrupted inside the transaction, then imports once', () => {
    writeFileSync(file, JSON.stringify({ items: ['a', 'b'] }));
    const outcome = importJsonStoreOnce(db, { source: 'things', filePath: file, apply, insideTransaction: () => { throw new Error('killed'); } });
    expect(outcome.status).toBe('failed');
    expect(rows()).toBe(0);
    expect(readImportMarker(db, 'things')).toBeUndefined();
    expect(importJsonStoreOnce(db, { source: 'things', filePath: file, apply }).status).toBe('imported');
    expect(rows()).toBe(2);
  });

  it('reports a corrupt file with a PaneError, leaves it untouched and retries next time', () => {
    writeFileSync(file, '{ not json');
    const outcome = importJsonStoreOnce(db, { source: 'approvals', filePath: file, apply });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error.code).toBe('ERR_JSON_STORE_IMPORT');
    expect(outcome.error.message).toMatch(/^Pane couldn't import your saved approvals from store\.json: .*Nothing was deleted; it retries on the next start\.$/);
    expect(outcome.error.next).toBeTruthy();
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    expect(readImportMarker(db, 'approvals')).toBeUndefined();
  });

  it('marks a store with no file as imported with nothing in it, without a backup', () => {
    expect(importJsonStoreOnce(db, { source: 'things', filePath: file, apply })).toMatchObject({ status: 'imported', marker: { itemCount: 0, backupPath: null } });
    expect(existsSync(`${file}.before-import`)).toBe(false);
  });
});
