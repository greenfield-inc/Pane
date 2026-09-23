import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Pull requests run the full suite on Linux and this subset on Windows and
// macOS: tests that branch on the platform or drive real OS resources (git,
// SQLite files, temp directories, symlinks, ptys, path resolution), directly
// or through the module they cover. Pushes to main run the full suite on
// every OS.
const OS_SENSITIVE = new RegExp([
  String.raw`process\.platform`,
  String.raw`platform: '(win32|darwin|linux)'`,
  `'win32'`,
  `'darwin'`,
  String.raw`path\.(win32|posix|resolve|sep|normalize|relative|isAbsolute)`,
  String.raw`os\.platform`,
  'isWindows',
  String.raw`(execFileSync|execSync|spawnSync)\(['"]git`,
  'mkdtemp',
  String.raw`new DatabaseService\(`,
  'better-sqlite3',
  'node-pty',
  'symlinkSync',
  'realpathSync',
].join('|'));

// Files that have failed only on Windows without matching the patterns above.
const PAST_OS_ONLY_FAILURES = [
  'src/daemon/setupRemoteHostCli.test.ts',
  'src/ipc/daemonRegistryBindings.test.ts',
  'src/services/__tests__/worktreeManager.test.ts',
  'src/services/terminalPanelManager.test.ts',
];

function listTests(dir: string): string[] {
  return readdirSync(path.join(__dirname, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return listTests(relative);
    return /\.(test|spec)\.ts$/.test(entry.name) ? [relative] : [];
  });
}

// The module a test covers: foo.test.ts -> foo.ts, __tests__/foo.test.ts -> ../foo.ts.
function moduleUnderTest(file: string): string {
  const source = file.replace(/\.(test|spec)\.ts$/, '.ts');
  return source.includes('/__tests__/') ? source.replace('/__tests__/', '/') : source;
}

function readIfPresent(file: string): string {
  return existsSync(path.join(__dirname, file)) ? readFileSync(path.join(__dirname, file), 'utf8') : '';
}

const include = listTests('src').filter((file) =>
  PAST_OS_ONLY_FAILURES.includes(file)
  || OS_SENSITIVE.test(readIfPresent(file))
  || OS_SENSITIVE.test(readIfPresent(moduleUnderTest(file))),
);

export default defineConfig({
  ...baseConfig,
  test: { ...baseConfig.test, include },
});
