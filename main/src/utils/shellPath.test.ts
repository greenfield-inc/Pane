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
});
