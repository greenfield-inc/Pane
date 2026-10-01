import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearShellPathCache, getShellPath, warmShellPath } from './shellPath';

// A stand-in login shell: logs each run, fails its first run when asked, and
// prints a fixed PATH.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-path-test-'));
const fakeShell = path.join(dir, 'fake-shell');
const runLog = path.join(dir, 'runs.log');
// When present, the fake shell behaves like a ~/.bashrc: it prepends to the PATH it was started with.
const prependMode = path.join(dir, 'prepend-mode');
const originalShell = process.env.SHELL;

function shellRuns(): number {
  return fs.existsSync(runLog) ? fs.readFileSync(runLog, 'utf8').split('\n').filter(Boolean).length : 0;
}

describe.skipIf(process.platform === 'win32')('shellPath', () => {
  beforeAll(() => {
    fs.writeFileSync(fakeShell, [
      '#!/bin/sh',
      `if [ -n "$FAIL_FIRST_PROBE" ] && [ ! -f '${runLog}' ]; then echo "$*" >> '${runLog}'; exit 1; fi`,
      `echo "$*" >> '${runLog}'`,
      `if [ -f '${prependMode}' ]; then echo "/opt/fake-shell/bin:$PATH"; exit 0; fi`,
      'echo "/opt/fake-shell/bin:/usr/bin"',
    ].join('\n'), { mode: 0o755 });
    process.env.SHELL = fakeShell;
  });

  afterAll(() => {
    process.env.SHELL = originalShell;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearShellPathCache();
    fs.rmSync(runLog, { force: true });
    delete process.env.FAIL_FIRST_PROBE;
    fs.rmSync(prependMode, { force: true });
  });

  it('serves getShellPath from the warmed cache without running the shell again', async () => {
    await warmShellPath();
    const shellPath = getShellPath();

    expect(shellPath.split(':').slice(0, 2)).toEqual(['/opt/fake-shell/bin', '/usr/bin']);
    expect(shellRuns()).toBe(1);
  });

  it.each([
    ['getShellPath', async () => getShellPath()],
    ['warmShellPath', async () => { await warmShellPath(); return getShellPath(); }],
  ])('%s falls back to the next probe when the first one fails', async (_name, resolveShellPath) => {
    process.env.FAIL_FIRST_PROBE = '1';

    const shellPath = await resolveShellPath();

    expect(shellPath.split(':').slice(0, 2)).toEqual(['/opt/fake-shell/bin', '/usr/bin']);
    expect(shellRuns()).toBe(2);
  });

  it.skipIf(process.platform !== 'linux')(
    'a packaged Linux app starts the probe from the login PATH, so /usr/local/bin still wins over /usr/bin',
    () => {
      fs.writeFileSync(prependMode, '');
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const entries = getShellPath().split(':');

        expect(entries[0]).toBe('/opt/fake-shell/bin');
        expect(entries.indexOf('/usr/local/bin')).toBeGreaterThan(0);
        expect(entries.indexOf('/usr/local/bin')).toBeLessThan(entries.indexOf('/usr/bin'));
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    },
  );
});
