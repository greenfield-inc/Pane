const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Arch } = require('electron-builder');
const { verifyLinuxSqliteArchitecture } = require('./after-pack');

test('Linux package rejects a host SQLite binary in an ARM64 app', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-native-arch-'));
  try {
    const file = path.join(directory, 'resources', 'app.asar.unpacked', 'node_modules',
      'better-sqlite3-multiple-ciphers', 'build', 'Release', 'better_sqlite3.node');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const elf = Buffer.alloc(20);
    elf.write('\x7fELF');
    elf[5] = 1;
    elf.writeUInt16LE(62, 18);
    fs.writeFileSync(file, elf);
    assert.doesNotThrow(() => verifyLinuxSqliteArchitecture(directory, Arch.x64));
    assert.throws(() => verifyLinuxSqliteArchitecture(directory, Arch.arm64), /does not target Linux arm64/);
    elf.writeUInt16LE(183, 18);
    fs.writeFileSync(file, elf);
    assert.doesNotThrow(() => verifyLinuxSqliteArchitecture(directory, Arch.arm64));
    assert.throws(() => verifyLinuxSqliteArchitecture(directory, Arch.x64), /does not target Linux x64/);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pane-native-arch-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
