import { mkdtemp, writeFile, readFile, readdir, rm, truncate, symlink, link } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listArchive, listSqlite } from './filePreviewListing';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'pane-listing-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('lists SQLite tables and views without changing the source or creating sidecars', async () => {
  const path = join(directory, 'sample.sqlite');
  const database = new Database(path);
  database.exec('CREATE TABLE items (name TEXT); CREATE VIEW names AS SELECT name FROM items;');
  database.close();
  const before = await readFile(path);
  expect((await listSqlite(path)).rows).toEqual([['items', 'table'], ['names', 'view']]);
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(directory)).toEqual(['sample.sqlite']);
});

it('refuses live WAL databases and oversized snapshots', async () => {
  const path = join(directory, 'sample.sqlite');
  const database = new Database(path); database.exec('CREATE TABLE items (name TEXT)'); database.close();
  await writeFile(`${path}-wal`, 'live');
  await expect(listSqlite(path)).rejects.toThrow('active WAL');
  await rm(`${path}-wal`);
  await truncate(path, 33 * 1024 * 1024);
  await expect(listSqlite(path)).rejects.toThrow('32 MiB');
});

it('lists a ZIP directory without extracting traversal names', async () => {
  const path = join(directory, 'sample.zip');
  const name = Buffer.from('../not-extracted.txt');
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(12, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12);
  await writeFile(path, Buffer.concat([central, name, end]));
  expect((await listArchive(path)).rows).toEqual([['../not-extracted.txt', '12', 'File']]);
  expect(await readdir(directory)).toEqual(['sample.zip']);
});

it('lists TAR headers while skipping payload bytes', async () => {
  const path = join(directory, 'sample.tar');
  const header = Buffer.alloc(512); header.write('hello.txt'); header.write('00000000003\0', 124); header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  await writeFile(path, Buffer.concat([header, Buffer.from('abc'), Buffer.alloc(509 + 1024)]));
  expect((await listArchive(path)).rows).toEqual([['hello.txt', '3', 'File']]);
  header[0] = 0; await writeFile(path, header);
  await expect(listArchive(path)).rejects.toThrow('checksum');
});

it.each(['zip', 'tar'])('limits a %s listing to 1,000 entries without extracting files', async extension => {
  const path = join(directory, `many.${extension}`);
  const entries = Array.from({ length: 1001 }, (_, index) => {
    const name = Buffer.from(`entry-${index}`);
    if (extension === 'zip') {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50); header.writeUInt16LE(name.length, 28);
      return Buffer.concat([header, name]);
    }
    const header = Buffer.alloc(512);
    name.copy(header); header.write('00000000000\0', 124); header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    return header;
  });
  const end = Buffer.alloc(extension === 'zip' ? 22 : 1024);
  if (extension === 'zip') {
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(entries.reduce((sum, entry) => sum + entry.length, 0), 12);
  }
  await writeFile(path, Buffer.concat([...entries, end]));
  const listing = await listArchive(path);
  expect(listing.rows).toHaveLength(1000);
  expect(listing.rows.at(-1)).toEqual(['entry-999', '0', 'File']);
  expect(listing.notice).toContain('Limited to 1,000 entries');
  expect(await readdir(directory)).toEqual([`many.${extension}`]);
});

it.each([
  ['oversized directory', 12, 4 * 1024 * 1024 + 1, '4 MiB'],
  ['ZIP64 size', 12, 0xffffffff, 'ZIP64'],
  ['ZIP64 offset', 16, 0xffffffff, 'ZIP64'],
  ['ZIP64 count', 10, 65535, 'ZIP64'],
  ['split disk', 4, 1, 'split ZIP'],
  ['split directory', 6, 1, 'split ZIP'],
] as const)('refuses a ZIP with %s before reading its directory', async (_label, offset, value, error) => {
  const path = join(directory, 'unsupported.zip');
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  if (offset >= 12) end.writeUInt32LE(value, offset);
  else end.writeUInt16LE(value, offset);
  await writeFile(path, end);
  await expect(listArchive(path)).rejects.toThrow(error);
});

it.each(['bad.zip', 'bad.tar', 'bad.sqlite'])('fails clearly for malformed %s', async name => {
  const path = join(directory, name); await writeFile(path, 'bad data');
  await expect(name.endsWith('sqlite') ? listSqlite(path) : listArchive(path)).rejects.toThrow();
});

for (const access of ['direct', 'symlink', 'hardlink'] as const) {
  it.skipIf(access === 'symlink' && process.platform === 'win32')(`refuses a spilled rollback transaction via ${access} without changing source files`, async () => {
    const path = join(directory, 'rollback.sqlite');
    const writer = new Database(path);
    try {
      writer.pragma('journal_mode = DELETE');
      writer.pragma('cache_size = 2');
      writer.transaction(() => {
        for (let index = 0; index < 100; index++) writer.exec(`CREATE TABLE committed_${index} (value TEXT)`);
      })();
      const alias = join(directory, 'alias.sqlite');
      if (access === 'symlink') await symlink(path, alias);
      if (access === 'hardlink') await link(path, alias);
      writer.exec('BEGIN IMMEDIATE');
      for (let index = 0; index < 100; index++) writer.exec(`ALTER TABLE committed_${index} RENAME TO temporary_${index}`);
      const before = await readFile(path);
      const journal = await readFile(`${path}-journal`);
      const names = await readdir(directory);
      expect(journal.length).toBeGreaterThan(0);
      await expect(listSqlite(access === 'direct' ? path : alias)).rejects.toThrow(access === 'hardlink' ? 'hard links' : 'rollback journal');
      expect(await readFile(path)).toEqual(before);
      expect(await readFile(`${path}-journal`)).toEqual(journal);
      expect(await readdir(directory)).toEqual(names);
    } finally { writer.close(); }
  });
}

it.skipIf(process.platform === 'win32')('checks WAL beside a symlink target and permits a closed target', async () => {
  const path = join(directory, 'target.sqlite');
  const alias = join(directory, 'alias.sqlite');
  const writer = new Database(path); writer.exec('CREATE TABLE items (name TEXT)'); writer.close();
  await symlink(path, alias);
  expect((await listSqlite(alias)).rows).toEqual([['items', 'table']]);
  await writeFile(`${path}-wal`, 'nonempty WAL');
  const before = await readFile(path);
  await expect(listSqlite(alias)).rejects.toThrow('active WAL');
  expect(await readFile(path)).toEqual(before);
  expect(await readFile(`${path}-wal`, 'utf8')).toBe('nonempty WAL');
});

it('keeps the event loop responsive and enforces a deadline while parsing a wide SQLite schema', async () => {
  const path = join(directory, 'wide.sqlite');
  const database = new Database(path);
  database.unsafeMode(true);
  database.exec('CREATE TABLE seed (value TEXT); PRAGMA writable_schema = ON;');
  const columns = Array.from({ length: 1900 }, (_, index) => `column_${index}`).join(',');
  const insert = database.prepare("INSERT INTO sqlite_schema(type, name, tbl_name, rootpage, sql) VALUES ('table', ?, ?, 2, ?)");
  database.transaction(() => {
    for (let index = 0; index < 1200; index++) {
      const name = `wide_${index}`;
      insert.run(name, name, `CREATE TABLE ${name} (${columns})`);
    }
  })();
  database.close();
  let beats = 0;
  let previous = Date.now();
  let largestGap = 0;
  const heartbeat = setInterval(() => {
    const now = Date.now(); largestGap = Math.max(largestGap, now - previous); previous = now; beats++;
  }, 10);
  try {
    await expect(listSqlite(path, 100)).rejects.toThrow('timed out');
    expect(beats).toBeGreaterThan(1);
    expect(largestGap).toBeLessThan(500);
  } finally { clearInterval(heartbeat); }
}, 15000);
