import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatLocalEnvFile,
  parseLocalStartScriptEnv,
  runLocalStartScript,
  type LocalStartScriptResult,
  type LocalStartScriptShell,
} from './cloudLocalStartScript';

// A stand-in secret; it must never reach a log, an error or anything but `env`.
const SECRET = 'FAKE-SECRET-VALUE-7f3a';
const posixOnly = process.platform === 'win32' ? it.skip : it;

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  constructor(readonly pid: number) {
    super();
  }
}

interface FakeChild {
  child: FakeProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  close(exitCode: number | null): void;
}

function fakeChild(pid = 4242): FakeChild {
  const child = new FakeProcess(pid);
  return { child, stdout: child.stdout, stderr: child.stderr, close: exitCode => child.emit('close', exitCode) };
}

function withoutEnv(result: LocalStartScriptResult) {
  return { ...result, env: [...result.env.keys()] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseLocalStartScriptEnv', () => {
  it('reads strict KEY=VALUE lines, skips the rest and keeps the last value', () => {
    const env = parseLocalStartScriptEnv([
      'Fetching secrets…',
      'DOPPLER_TOKEN=first',
      'export NOT_THIS=1',
      ' LEADING_SPACE=1',
      '1BAD=1',
      'BAD-NAME=1',
      'EMPTY=',
      'WITH_EQUALS=a=b==c',
      'DOPPLER_TOKEN=second\r',
      '_UNDERSCORE=ok',
      '',
    ].join('\n'));

    expect([...env]).toEqual([
      ['DOPPLER_TOKEN', 'second'],
      ['EMPTY', ''],
      ['WITH_EQUALS', 'a=b==c'],
      ['_UNDERSCORE', 'ok'],
    ]);
  });
});

describe('reserved names', () => {
  posixOnly('keeps names that would change how the sandbox runs out of env and reports them by name only', async () => {
    const result = await runLocalStartScript([
      `echo "DOPPLER_TOKEN=${SECRET}"`,
      ...['PATH', 'HOME', 'USER', 'SHELL', 'IFS', 'ENV', 'BASH_ENV', 'LD_PRELOAD', 'GIT_DIR', 'SSH_AUTH_SOCK', 'PANE_DIR', 'RUNPANE_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']
        .map(name => `echo "${name}=${SECRET}"`),
      'echo "GITHUB_ORG=acme"',
      'echo "PANEL=fine"',
    ].join('\n'));

    expect(result.keys).toEqual(['DOPPLER_TOKEN', 'GITHUB_ORG', 'PANEL']);
    expect(result.reservedKeys).toEqual([
      'ANTHROPIC_API_KEY', 'BASH_ENV', 'CLAUDE_CODE_OAUTH_TOKEN', 'ENV', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_DIR', 'HOME', 'IFS',
      'LD_PRELOAD', 'PANE_DIR', 'PATH', 'RUNPANE_TOKEN', 'SHELL', 'SSH_AUTH_SOCK', 'USER',
    ]);
    expect(JSON.stringify(withoutEnv(result))).not.toContain(SECRET);
  });
});

describe('formatLocalEnvFile', () => {
  posixOnly('writes sorted export lines that sh sources back to the exact values', () => {
    const env = new Map([['ZED', `it's "quoted" $HOME \`x\` \\n`], ['ALPHA', 'plain']]);
    const text = formatLocalEnvFile(env);
    expect(text.split('\n')[0]).toBe("export ALPHA='plain'");

    const dir = mkdtempSync(join(tmpdir(), 'pane-local-env-'));
    try {
      const file = join(dir, 'local-env');
      writeFileSync(file, text);
      const sourced = execFileSync('/bin/sh', ['-c', `. "${file}"; printf '%s' "$ZED"`], { encoding: 'utf8' });
      expect(sourced).toBe(env.get('ZED'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runLocalStartScript with sh', () => {
  posixOnly('returns the printed variables and ignores stderr and other lines', async () => {
    const result = await runLocalStartScript(`echo "progress on stderr" >&2\necho "Fetching…"\necho "DOPPLER_TOKEN=${SECRET}"\necho "REGION=us"\n`);

    expect(withoutEnv(result)).toEqual({
      ok: true, env: ['DOPPLER_TOKEN', 'REGION'], keys: ['DOPPLER_TOKEN', 'REGION'], reservedKeys: [], skippedLines: 1, exitCode: 0, timedOut: false, failureSummary: null,
    });
    expect(result.env.get('DOPPLER_TOKEN')).toBe(SECRET);
  });

  posixOnly('runs from an owner-only temp file that is gone afterwards', async () => {
    const result = await runLocalStartScript('echo "SCRIPT=$0"\necho "MODE=$(stat -c %a "$0" 2>/dev/null || stat -f %Lp "$0")"\n');

    expect(result.env.get('MODE')).toBe('600');
    const scriptPath = result.env.get('SCRIPT') ?? '';
    expect(scriptPath).toMatch(/pane-local-start-.*start\.sh$/);
    expect(existsSync(scriptPath)).toBe(false);
  });

  posixOnly('reports a non-zero exit with the key count only', async () => {
    const result = await runLocalStartScript(`echo "DOPPLER_TOKEN=${SECRET}"\necho "doppler: not logged in" >&2\nexit 2\n`);

    expect(withoutEnv(result)).toEqual({
      ok: false, env: [], keys: [], reservedKeys: [], skippedLines: 0, exitCode: 2, timedOut: false,
      failureSummary: 'Local start script exited with code 2 (1 key read).',
    });
  });

  posixOnly('kills the script and its children on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pane-local-start-test-'));
    const pidFile = join(dir, 'child.pid');
    try {
      const result = await runLocalStartScript(`echo "A=${SECRET}"\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`, { timeoutMs: 400 });

      expect(withoutEnv(result)).toEqual({
        ok: false, env: [], keys: [], reservedKeys: [], skippedLines: 0, exitCode: null, timedOut: true,
        failureSummary: 'Local start script timed out after 0 s (1 key read).',
      });
      const childPid = Number(readFileSync(pidFile, 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 3000, interval: 50 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing for an empty script', async () => {
    const spawnProcess = vi.fn();
    await expect(runLocalStartScript('  \n', { spawnProcess })).resolves.toEqual({
      ok: true, env: new Map(), keys: [], reservedKeys: [], skippedLines: 0, exitCode: null, timedOut: false, failureSummary: null,
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe('runLocalStartScript on Windows (mocked spawn)', () => {
  it('runs PowerShell non-interactively from a .ps1 file by default', async () => {
    const fake = fakeChild();
    let seen: { command: string; args: string[]; contents: string; mode: number } | null = null;
    const spawnProcess = vi.fn((command: string, args: string[]) => {
      const file = args[args.length - 1];
      seen = { command, args, contents: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 };
      setImmediate(() => {
        fake.stdout.end(`DOPPLER_TOKEN=${SECRET}\r\nREGION=us\r\n`);
        fake.close(0);
      });
      return fake.child;
    });

    const result = await runLocalStartScript('doppler configure get token --plain', { platform: 'win32', spawnProcess });

    expect(seen).toMatchObject({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', expect.stringMatching(/start\.ps1$/)],
      contents: 'doppler configure get token --plain',
    });
    if (process.platform !== 'win32') expect(seen).toMatchObject({ mode: 0o600 });
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({ windowsHide: true, detached: false });
    expect(result.keys).toEqual(['DOPPLER_TOKEN', 'REGION']);
    expect(result.env.get('DOPPLER_TOKEN')).toBe(SECRET);
  });

  it('runs cmd with echo off from a .cmd file', async () => {
    const fake = fakeChild();
    let seen: { command: string; args: string[]; contents: string } | null = null;
    const spawnProcess = vi.fn((command: string, args: string[]) => {
      seen = { command, args, contents: readFileSync(args[args.length - 1], 'utf8') };
      setImmediate(() => { fake.stdout.end('C:\\>echo noise\r\nTOKEN=x\r\n'); fake.close(0); });
      return fake.child;
    });

    const shell: LocalStartScriptShell = 'cmd';
    const result = await runLocalStartScript('echo TOKEN=x', { platform: 'win32', shell, spawnProcess });

    expect(seen).toMatchObject({
      command: 'cmd.exe',
      args: ['/d', '/q', '/c', expect.stringMatching(/start\.cmd$/)],
      contents: '@echo off\r\necho TOKEN=x',
    });
    expect(result.keys).toEqual(['TOKEN']);
  });

  it('kills the whole process tree with taskkill on timeout', async () => {
    const fake = fakeChild(5150);
    const spawnProcess = vi.fn((command: string) => (command === 'taskkill' ? fakeChild(1).child : fake.child));

    const result = await runLocalStartScript('Start-Sleep 60', { platform: 'win32', spawnProcess, timeoutMs: 50 });

    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(spawnProcess).toHaveBeenCalledWith('taskkill', ['/PID', '5150', '/T', '/F'], expect.objectContaining({ windowsHide: true }));
  });

  it('reports a shell that will not start', async () => {
    const spawnProcess = vi.fn(() => { throw new Error(`spawn powershell.exe ENOENT ${SECRET}`); });
    await expect(runLocalStartScript('echo A=1', { platform: 'win32', spawnProcess })).resolves.toMatchObject({
      ok: false,
      failureSummary: "Couldn't start PowerShell for the local start script (0 keys read).",
    });
  });
});

describe('secret handling', () => {
  it('never puts a value in a log, a summary or anything but env', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level));
    const outcomes: LocalStartScriptResult[] = [];
    for (const [exitCode, stderr] of [[0, ''], [3, `failed with ${SECRET}`]] as const) {
      const fake = fakeChild();
      const spawnProcess = vi.fn(() => {
        setImmediate(() => { fake.stderr.end(stderr); fake.stdout.end(`TOKEN=${SECRET}\n${SECRET}\n`); fake.close(exitCode); });
        return fake.child;
      });
      outcomes.push(await runLocalStartScript('print', { platform: 'linux', spawnProcess }));
    }
    const timeoutChild = fakeChild();
    const timeoutSpawn = vi.fn(() => {
      setImmediate(() => timeoutChild.stdout.write(`TOKEN=${SECRET}\n`));
      return timeoutChild.child;
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    outcomes.push(await runLocalStartScript('print', { platform: 'linux', spawnProcess: timeoutSpawn, timeoutMs: 50 }));

    expect(outcomes.map(outcome => outcome.ok)).toEqual([true, false, false]);
    for (const outcome of outcomes) expect(JSON.stringify(withoutEnv(outcome))).not.toContain(SECRET);
    expect(logs.flatMap(spy => spy.mock.calls).map(call => JSON.stringify(call)).filter(line => line.includes(SECRET))).toEqual([]);
  });
});
