import { spawn, type SpawnOptions } from 'child_process';
import type { Readable } from 'stream';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The user's local start script: it runs on THIS computer before each cloud
 * sandbox create and start, and every `KEY=VALUE` line it prints becomes an
 * environment variable on the sandbox. Values are usually secrets (a Doppler
 * token, say), so nothing here logs, prints or returns them except in `env`.
 */

export type LocalStartScriptShell = 'powershell' | 'cmd' | 'sh';

/** The part of a child process the runner uses; `child_process.spawn` results satisfy it. */
interface LocalStartChild {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (exitCode: number | null) => void): this;
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => LocalStartChild;

interface ScriptFile {
  name: string;
  contents: string;
}

interface ShellCommand {
  command: string;
  args: string[];
}

interface LocalStartScriptOptions {
  /** Defaults to PowerShell on Windows and sh elsewhere. */
  shell?: LocalStartScriptShell;
  timeoutMs?: number;
  /** Test seams. */
  platform?: NodeJS.Platform;
  spawnProcess?: SpawnProcess;
}

export interface LocalStartScriptResult {
  ok: boolean;
  /** Parsed variables. The values are secrets: never log, print or serialize them. */
  env: Map<string, string>;
  /** Variable names, sorted; safe to log and show. */
  keys: string[];
  /** Printed names that are reserved for the sandbox itself, so they were dropped (names only). */
  reservedKeys: string[];
  /** Non-empty stdout lines that weren't KEY=VALUE (a count only, never their content). */
  skippedLines: number;
  exitCode: number | null;
  timedOut: boolean;
  /** Exit code, timeout or start failure plus the key count; never any script output. */
  failureSummary: string | null;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// Names that would override how the sandbox runs or authenticates; they never reach its env file.
const RESERVED_NAMES = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'BASH_ENV', 'ENV', 'IFS', 'GITHUB_TOKEN']);
const RESERVED_PREFIXES = ['LD_', 'GIT_', 'SSH_', 'PANE_', 'RUNPANE_', 'CLAUDE_', 'ANTHROPIC_', 'GH_'];

function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some(prefix => name.startsWith(prefix));
}

function shellName(shell: LocalStartScriptShell): string {
  return shell === 'powershell' ? 'PowerShell' : shell;
}

/** The sandbox's owner-only env file: `export KEY='value'` lines that sh and bash can source safely. */
export function formatLocalEnvFile(env: Map<string, string>): string {
  return [...env.keys()].sort().map(key => `export ${key}='${(env.get(key) ?? '').replace(/'/g, `'\\''`)}'\n`).join('');
}

/** Read `KEY=VALUE` lines from the script's stdout; other lines are ignored and the last value wins. */
export function parseLocalStartScriptEnv(stdout: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const rawLine of stdout.split('\n')) {
    const match = ENV_LINE.exec(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    if (match) env.set(match[1], match[2]);
  }
  return env;
}

function scriptFile(shell: LocalStartScriptShell, script: string): ScriptFile {
  if (shell === 'powershell') return { name: 'start.ps1', contents: script };
  if (shell === 'cmd') return { name: 'start.cmd', contents: `@echo off\r\n${script}` };
  return { name: 'start.sh', contents: script };
}

function shellCommand(shell: LocalStartScriptShell, file: string): ShellCommand {
  if (shell === 'powershell') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] };
  }
  if (shell === 'cmd') return { command: 'cmd.exe', args: ['/d', '/q', '/c', file] };
  return { command: '/bin/sh', args: [file] };
}

function countKeys(count: number): string {
  return `${count} ${count === 1 ? 'key' : 'keys'} read`;
}

function killTree(child: LocalStartChild, platform: NodeJS.Platform, spawnProcess: SpawnProcess): void {
  if (child.pid === undefined) return;
  try {
    if (platform === 'win32') {
      spawnProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // The script runs in its own process group, so its children (doppler, sleep…) die with it.
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

function countSkippedLines(stdout: string): number {
  return stdout.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() && !ENV_LINE.test(line)).length;
}

function result(
  parsed: Map<string, string>,
  skippedLines: number,
  exitCode: number | null,
  timedOut: boolean,
  failureSummary: string | null,
): LocalStartScriptResult {
  const env = new Map([...parsed].filter(([name]) => !isReservedName(name)));
  const reservedKeys = [...parsed.keys()].filter(isReservedName).sort();
  return { ok: failureSummary === null, env, keys: [...env.keys()].sort(), reservedKeys, skippedLines, exitCode, timedOut, failureSummary };
}

export async function runLocalStartScript(scriptText: string, options: LocalStartScriptOptions = {}): Promise<LocalStartScriptResult> {
  if (!scriptText.trim()) return result(new Map(), 0, null, false, null);

  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? (platform === 'win32' ? 'powershell' : 'sh');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? spawn;
  const dir = await fs.mkdtemp(join(tmpdir(), 'pane-local-start-'));

  try {
    const file = scriptFile(shell, scriptText);
    const filePath = join(dir, file.name);
    await fs.writeFile(filePath, file.contents, { mode: 0o600 });
    const { command, args } = shellCommand(shell, filePath);

    return await new Promise<LocalStartScriptResult>(resolve => {
      let stdout = '';
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (exitCode: number | null, failure: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const env = timedOut || failure ? new Map<string, string>() : parseLocalStartScriptEnv(stdout);
        const keyCount = parseLocalStartScriptEnv(stdout).size;
        resolve(result(env, countSkippedLines(stdout), exitCode, timedOut, failure && `${failure} (${countKeys(keyCount)}).`));
      };

      let child: LocalStartChild;
      try {
        child = spawnProcess(command, args, {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: platform !== 'win32',
        });
      } catch {
        finish(null, `Couldn't start ${shellName(shell)} for the local start script`);
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, platform, spawnProcess);
        finish(null, `Local start script timed out after ${Math.round(timeoutMs / 1000)} s`);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8');
      });
      // stderr is drained so the script can't block on a full pipe, and then dropped.
      child.stderr?.resume();
      child.on('error', () => finish(null, `Couldn't start ${shellName(shell)} for the local start script`));
      child.on('close', exitCode => finish(exitCode, exitCode === 0 ? null : `Local start script exited with code ${exitCode ?? 'unknown'}`));
    });
  } finally {
    // The script file can hold secrets too; on Windows a killed tree may hold it open briefly.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
