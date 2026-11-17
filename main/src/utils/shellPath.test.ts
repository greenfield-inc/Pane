import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearShellPathCache, findExecutableInPath, getShellPath, warmShellPath, windowsExecutableNames } from './shellPath';

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

  it('joins simultaneous warmups instead of running user profiles repeatedly', async () => {
    await Promise.all([warmShellPath(), warmShellPath(), warmShellPath()]);
    expect(getShellPath().split(':').slice(0, 2)).toEqual(['/opt/fake-shell/bin', '/usr/bin']);
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

describe('windowsExecutableNames', () => {
  const pathext = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

  it('tries only .com, .exe, .bat and .cmd, then the bare name', () => {
    expect(windowsExecutableNames('codex', pathext))
      .toEqual(['codex.com', 'codex.exe', 'codex.bat', 'codex.cmd', 'codex']);
  });

  it("keeps PATHEXT's order among the launchable extensions", () => {
    expect(windowsExecutableNames('codex', '.JS;.CMD;.EXE'))
      .toEqual(['codex.cmd', 'codex.exe', 'codex']);
  });

  it('falls back to the launchable extensions when PATHEXT is unset or lists none of them', () => {
    const fallback = ['codex.com', 'codex.exe', 'codex.bat', 'codex.cmd', 'codex'];
    expect(windowsExecutableNames('codex', undefined)).toEqual(fallback);
    expect(windowsExecutableNames('codex', '.JS;.VBS')).toEqual(fallback);
  });
});

describe.runIf(process.platform === 'win32')('findExecutableInPath on Windows', () => {
  it('skips a codex.js in an earlier PATH folder and finds codex.cmd in a later one', () => {
    const jsBin = fs.mkdtempSync(path.join(os.tmpdir(), 'find-executable-js-'));
    const cmdBin = fs.mkdtempSync(path.join(os.tmpdir(), 'find-executable-cmd-'));
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;
    try {
      fs.writeFileSync(path.join(jsBin, 'codex.js'), 'console.log(1);\n');
      fs.writeFileSync(path.join(cmdBin, 'codex.cmd'), '@echo off\r\n');
      process.env.PATH = `${jsBin};${cmdBin};${originalPath ?? ''}`;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC';
      clearShellPathCache();
      expect(findExecutableInPath('codex')).toBe(path.join(cmdBin, 'codex.cmd'));
    } finally {
      process.env.PATH = originalPath;
      if (originalPathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathext;
      clearShellPathCache();
      fs.rmSync(jsBin, { recursive: true, force: true });
      fs.rmSync(cmdBin, { recursive: true, force: true });
    }
  });

  it('picks npm.cmd over the extensionless npm shell script beside it, as cmd.exe does', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'find-executable-'));
    const originalPath = process.env.PATH;
    try {
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\n');
      fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\n');
      process.env.PATH = `${bin};${originalPath ?? ''}`;
      clearShellPathCache();
      expect(findExecutableInPath('npm')).toBe(path.join(bin, 'npm.cmd'));
    } finally {
      process.env.PATH = originalPath;
      clearShellPathCache();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
