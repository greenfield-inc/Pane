import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubDeviceLoginState } from '../../../shared/types/githubDeviceLogin';
import { createGhSpawner, GitHubDeviceLogin, parseGhDeviceCode } from './githubDeviceLogin';

// Fake one-time code; real codes never appear in tests or logs.
const CODE = 'TEST-0000';

// gh 2.101.0 output shapes, captured with the code redacted.
const NON_TTY_OUTPUT = [
  '',
  '! Failed to copy one-time code to clipboard',
  '  No clipboard utilities available. Please install xsel, xclip, wl-clipboard or Termux:API add-on for termux-clipboard-get/set.',
  `! First copy your one-time code: ${CODE}`,
  'Open this URL to continue in your web browser: https://github.com/login/device',
  '',
].join('\n');
const TTY_OUTPUT = `! First copy your one-time code: ${CODE}\nPress Enter to open https://github.com/login/device in your browser... `;

/**
 * A stand-in for gh. FAKE_GH_MODE picks how `auth login` behaves; every call
 * appends its arguments and its BROWSER settings to FAKE_GH_LOG.
 */
const FAKE_GH = `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, pid: process.pid, BROWSER: process.env.BROWSER, GH_BROWSER: process.env.GH_BROWSER }) + '\\n');
const mode = process.env.FAKE_GH_MODE;
const sub = args.slice(0, 2).join(' ');
if (sub === 'auth setup-git') process.exit(mode === 'setup-git-fails' ? 4 : 0);
if (sub === 'api user') { process.stdout.write('octocat\\n'); process.exit(0); }
if (mode === 'fail') { process.stderr.write('error connecting to github.com\\n'); process.exit(2); }
if (mode === 'expired') { process.stderr.write(${JSON.stringify(NON_TTY_OUTPUT)}); setTimeout(() => { process.stderr.write('error: the device code has expired\\n'); process.exit(1); }, 20); return; }
if (mode === 'tty') {
  process.stderr.write(${JSON.stringify(TTY_OUTPUT)});
  process.stdin.on('data', chunk => {
    if (!chunk.toString().includes('\\n')) return;
    process.stderr.write('\\n✓ Authentication complete.\\n✓ Logged in as octocat\\n');
    process.exit(0);
  });
  return;
}
process.stderr.write(${JSON.stringify(NON_TTY_OUTPUT)});
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
setTimeout(() => { process.stderr.write('✓ Authentication complete.\\n✓ Logged in as octocat\\n'); process.exit(0); }, 30);
`;

let dir: string;
let logPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pane-gh-login-'));
  logPath = path.join(dir, 'calls.log');
  await writeFile(path.join(dir, 'gh.cjs'), FAKE_GH);
  await writeFile(logPath, '');
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function createLogin(mode: string, timeoutMs?: number) {
  // A user's BROWSER must not survive into gh's environment.
  const env = { ...process.env, BROWSER: 'xdg-open', FAKE_GH_LOG: logPath, FAKE_GH_MODE: mode };
  return new GitHubDeviceLogin({
    spawnGh: createGhSpawner(env, process.execPath, [path.join(dir, 'gh.cjs')]),
    timeoutMs,
  });
}

async function calls(): Promise<Array<{ args: string[]; pid: number; BROWSER?: string; GH_BROWSER?: string }>> {
  return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function waitForState(login: GitHubDeviceLogin, status: GitHubDeviceLoginState['status']): Promise<GitHubDeviceLoginState> {
  await vi.waitFor(() => expect(login.getState().status).toBe(status), { timeout: 5000, interval: 10 });
  return login.getState();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('parseGhDeviceCode', () => {
  it('reads the code and URL from gh output without a TTY', () => {
    expect(parseGhDeviceCode(NON_TTY_OUTPUT)).toEqual({ code: CODE, verificationUrl: 'https://github.com/login/device' });
  });

  it('reads the code and URL from the Press Enter prompt gh shows in a TTY', () => {
    expect(parseGhDeviceCode(TTY_OUTPUT)).toEqual({ code: CODE, verificationUrl: 'https://github.com/login/device' });
  });

  it('waits for the code line and defaults the URL', () => {
    expect(parseGhDeviceCode('! Failed to copy one-time code to clipboard\n')).toBeNull();
    expect(parseGhDeviceCode('! First copy your one-time code: TEST-')).toBeNull();
    expect(parseGhDeviceCode(`! First copy your one-time code: ${CODE}\n`))
      .toEqual({ code: CODE, verificationUrl: 'https://github.com/login/device' });
  });
});

describe('GitHubDeviceLogin', () => {
  it('shows the code, then sets up git and reports the signed-in user', async () => {
    const login = createLogin('ok');

    expect(login.start({ hostLabel: 'sandbox-1' })).toMatchObject({ status: 'starting' });
    const waiting = await waitForState(login, 'waiting');
    expect(waiting).toMatchObject({ code: CODE, verificationUrl: 'https://github.com/login/device' });
    const signedIn = await waitForState(login, 'signed-in');

    expect(signedIn).toEqual({ status: 'signed-in', loginId: waiting.status === 'waiting' ? waiting.loginId : '', user: 'octocat' });
    expect((await calls()).map(call => call.args)).toEqual([
      ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com'],
      ['auth', 'setup-git', '--hostname', 'github.com'],
      ['api', 'user', '--jq', '.login'],
    ]);
  });

  it('answers gh\'s Press Enter prompt so it never waits on the user', async () => {
    const login = createLogin('tty');
    login.start();
    await waitForState(login, 'signed-in');
  });

  it('returns the running login instead of starting a second gh', async () => {
    const login = createLogin('hang');
    const first = login.start();
    await waitForState(login, 'waiting');

    expect(login.start()).toMatchObject({ status: 'waiting', loginId: 'loginId' in first ? first.loginId : '' });
    login.cancel();
    expect((await calls()).filter(call => call.args[1] === 'login')).toHaveLength(1);
  });

  it('cancel kills gh and drops the code', async () => {
    const login = createLogin('hang');
    login.start();
    await waitForState(login, 'waiting');
    const [{ pid }] = await calls();
    expect(isAlive(pid)).toBe(true);

    const cancelled = login.cancel();

    expect(cancelled).toEqual({ status: 'cancelled', loginId: expect.any(String) });
    expect(JSON.stringify(cancelled)).not.toContain(CODE);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5000, interval: 20 });
  });

  it('times out, kills gh and never leaks the code into the failure', async () => {
    const login = createLogin('hang', 300);
    login.start({ hostLabel: 'sandbox-1' });
    await waitForState(login, 'waiting');
    const [{ pid }] = await calls();

    const failed = await waitForState(login, 'failed');

    expect(failed).toMatchObject({ reason: 'timeout', exitCode: null, message: 'Sign-in timed out. Start again.' });
    expect(JSON.stringify(failed)).not.toContain(CODE);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5000, interval: 20 });
  });

  it('reports an expired code', async () => {
    const login = createLogin('expired');
    login.start();
    const failed = await waitForState(login, 'failed');
    expect(failed).toMatchObject({ reason: 'expired', exitCode: 1, message: 'The code expired before it was approved. Start again.' });
    expect(JSON.stringify(failed)).not.toContain(CODE);
  });

  it('reports a non-zero gh exit', async () => {
    const login = createLogin('fail');
    login.start();
    await expect(waitForState(login, 'failed')).resolves.toMatchObject({
      reason: 'exit',
      exitCode: 2,
      message: 'GitHub sign-in failed (gh exited with code 2).',
    });
  });

  it('reports a failed gh auth setup-git', async () => {
    const login = createLogin('setup-git-fails');
    login.start();
    await expect(waitForState(login, 'failed')).resolves.toMatchObject({ reason: 'exit', exitCode: 4 });
  });

  it('reports a host without gh', async () => {
    const login = new GitHubDeviceLogin({ spawnGh: createGhSpawner(process.env, path.join(dir, 'no-such-gh')) });
    login.start({ hostLabel: 'sandbox-1' });
    await expect(waitForState(login, 'failed')).resolves.toMatchObject({
      reason: 'gh-missing',
      message: "GitHub CLI (gh) isn't installed on sandbox-1.",
    });
  });

  it('runs gh with the browser disabled', async () => {
    const login = createLogin('ok');
    login.start();
    await waitForState(login, 'signed-in');
    for (const call of await calls()) {
      expect(call).toMatchObject({ BROWSER: 'false', GH_BROWSER: 'false' });
    }
  });
});
