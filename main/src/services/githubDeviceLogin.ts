import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import os from 'os';
import type {
  GitHubDeviceLoginFailureReason,
  GitHubDeviceLoginStartRequest,
  GitHubDeviceLoginState,
} from '../../../shared/types/githubDeviceLogin';

/** Starts `gh` with the given arguments; the caller owns the environment (no browser). */
export type SpawnGh = (args: string[]) => ChildProcessWithoutNullStreams;

interface GitHubDeviceLoginOptions {
  spawnGh: SpawnGh;
  /** gh's device code lives 15 minutes; give up a little after that. */
  timeoutMs?: number;
}

interface GhResult {
  exitCode: number | null;
  output: string;
  missing: boolean;
}

const GITHUB_HOSTNAME = 'github.com';
const DEFAULT_TIMEOUT_MS = 16 * 60 * 1000;
const MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_VERIFICATION_URL = 'https://github.com/login/device';
const ONE_TIME_CODE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const VERIFICATION_URL = /(https:\/\/[^\s]+\/login\/device)\b/;
const LOGGED_IN_AS = /Logged in as ([A-Za-z0-9-]+)/;

/**
 * Spawn gh directly (no shell, so this works the same on Windows hosts) with
 * every browser launcher disabled: the code is approved on the user's own
 * computer, never on this host.
 */
export function createGhSpawner(baseEnv: NodeJS.ProcessEnv, command = 'gh', prefixArgs: string[] = []): SpawnGh {
  const env = { ...baseEnv, BROWSER: 'false', GH_BROWSER: 'false' };
  return args => spawn(command, [...prefixArgs, ...args], { env, windowsHide: true });
}

/** Find gh's one-time code and verification URL in its (combined) output. */
export function parseGhDeviceCode(output: string): { code: string; verificationUrl: string } | null {
  const code = ONE_TIME_CODE.exec(output)?.[1];
  if (!code) return null;
  return { code, verificationUrl: VERIFICATION_URL.exec(output)?.[1] ?? DEFAULT_VERIFICATION_URL };
}

function isActive(state: GitHubDeviceLoginState): boolean {
  return state.status === 'starting' || state.status === 'waiting' || state.status === 'approved';
}

/**
 * One gh device-flow sign-in at a time on this host. gh never opens a
 * browser here and never waits for Enter: the caller's environment sets
 * BROWSER=false, and a newline is written to gh's stdin up front.
 */
export class GitHubDeviceLogin {
  private state: GitHubDeviceLoginState = { status: 'idle' };
  private child: ChildProcessWithoutNullStreams | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly options: GitHubDeviceLoginOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getState(): GitHubDeviceLoginState {
    return this.state;
  }

  start(request: GitHubDeviceLoginStartRequest = {}): GitHubDeviceLoginState {
    if (isActive(this.state)) return this.state;
    const loginId = randomUUID();
    const hostLabel = request.hostLabel?.trim() || os.hostname();
    this.state = { status: 'starting', loginId };
    this.timer = setTimeout(() => this.fail(loginId, 'timeout', null, 'Sign-in timed out. Start again.'), this.timeoutMs);
    void this.run(loginId, hostLabel, request.ghInsecureStorage === true);
    return this.state;
  }

  cancel(): GitHubDeviceLoginState {
    if (!isActive(this.state) || !('loginId' in this.state)) return this.state;
    this.finish({ status: 'cancelled', loginId: this.state.loginId });
    return this.state;
  }

  private async run(loginId: string, hostLabel: string, insecureStorage: boolean): Promise<void> {
    const loginArgs = ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', GITHUB_HOSTNAME];
    if (insecureStorage) loginArgs.push('--insecure-storage');
    const login = await this.runGh(loginId, loginArgs, output => {
      const device = this.isCurrent(loginId, 'starting') ? parseGhDeviceCode(output) : null;
      if (device) this.state = { status: 'waiting', loginId, ...device };
    });
    if (!login || !isActive(this.state)) return;
    if (login.missing) {
      this.fail(loginId, 'gh-missing', null, `GitHub CLI (gh) isn't installed on ${hostLabel}.`);
      return;
    }
    if (login.exitCode !== 0) {
      if (/expired/i.test(login.output)) {
        this.fail(loginId, 'expired', login.exitCode, 'The code expired before it was approved. Start again.');
      } else {
        this.fail(loginId, 'exit', login.exitCode, `GitHub sign-in failed (gh exited with code ${login.exitCode ?? 'unknown'}).`);
      }
      return;
    }

    this.state = { status: 'approved', loginId };
    const setupGit = await this.runGh(loginId, ['auth', 'setup-git', '--hostname', GITHUB_HOSTNAME]);
    if (!setupGit || !this.isCurrent(loginId, 'approved')) return;
    if (setupGit.exitCode !== 0) {
      this.fail(loginId, 'exit', setupGit.exitCode, `Signed in, but gh auth setup-git failed (exit ${setupGit.exitCode ?? 'unknown'}).`);
      return;
    }

    const apiUser = await this.runGh(loginId, ['api', 'user', '--jq', '.login']);
    if (!apiUser || !this.isCurrent(loginId, 'approved')) return;
    const user = (apiUser.exitCode === 0 ? apiUser.output.trim() : '') || LOGGED_IN_AS.exec(login.output)?.[1] || null;
    this.finish({ status: 'signed-in', loginId, user });
  }

  /** Run gh to completion; null when this login was replaced or cancelled meanwhile. */
  private runGh(loginId: string, args: string[], onOutput?: (output: string) => void): Promise<GhResult | null> {
    return new Promise(resolve => {
      let output = '';
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.options.spawnGh(args);
      } catch {
        resolve({ exitCode: null, output: '', missing: true });
        return;
      }
      this.child = child;
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
        onOutput?.(output);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      // gh may ask "Press Enter to open … in your browser"; answer it up front.
      child.stdin.on('error', () => {});
      child.stdin.end('\n');
      let settled = false;
      const settle = (result: GhResult) => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        resolve('loginId' in this.state && this.state.loginId === loginId && isActive(this.state) ? result : null);
      };
      child.on('error', (error: NodeJS.ErrnoException) => settle({ exitCode: null, output, missing: error.code === 'ENOENT' }));
      child.on('close', exitCode => settle({ exitCode, output, missing: false }));
    });
  }

  private isCurrent(loginId: string, status: GitHubDeviceLoginState['status']): boolean {
    return this.state.status === status && 'loginId' in this.state && this.state.loginId === loginId;
  }

  private fail(loginId: string, reason: GitHubDeviceLoginFailureReason, exitCode: number | null, message: string): void {
    if (!isActive(this.state) || !('loginId' in this.state) || this.state.loginId !== loginId) return;
    this.finish({ status: 'failed', loginId, reason, exitCode, message });
  }

  private finish(state: GitHubDeviceLoginState): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill();
    this.child = null;
    this.state = state;
  }
}
