import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { terminateProcessTrees } from '../utils/processTree';
import { getShellPath } from '../utils/shellPath';
import { ShellDetector } from '../utils/shellDetector';
import {
  getDefaultWSLDistribution,
  linuxToUNCPath,
  listWSLDistributions,
  parseWSLPath,
  windowsPathToWSLMount,
  wslMountToWindowsPath,
} from '../utils/wslUtils';

/** The machine a workspace request runs on, as far as path forms are concerned. */
export interface MachinePathHost {
  platform: NodeJS.Platform;
  homeDir: string;
  /** Pane runs inside WSL (Linux host only). */
  isWsl?: boolean;
  /** The WSL distribution that holds Linux paths: the default one on Windows, the current one inside WSL. */
  wslDistro?: string;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:([\\/]|$)/;

/**
 * Turns any path form an agent might hold (`C:\...`, `/mnt/c/...`, `\\wsl.localhost\<distro>\...`,
 * `/home/...`, `~/...`) into the path this machine opens.
 */
export function resolveMachinePath(input: string, host: MachinePathHost): string {
  const value = input.trim();
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    const rest = value.slice(1).replace(/^[\\/]+/, '');
    return host.platform === 'win32' ? path.win32.join(host.homeDir, rest) : path.posix.join(host.homeDir, rest);
  }

  const wslPath = parseWSLPath(value);
  if (host.platform === 'win32') {
    if (wslPath) return value;
    if (WINDOWS_DRIVE_PATH.test(value)) return path.win32.normalize(value);
    if (/^\/mnt\/[a-z](\/|$)/.test(value)) return wslMountToWindowsPath(value);
    if (value.startsWith('/')) {
      if (!host.wslDistro) {
        throw new Error(`"${value}" is a Linux path, and this Windows machine has no WSL distribution to read it from.`);
      }
      return linuxToUNCPath(path.posix.normalize(value), host.wslDistro);
    }
    throw new Error(`Path must be absolute: "${value}".`);
  }

  if (wslPath) {
    if (!host.isWsl) throw new Error(`"${value}" is a WSL path on Windows; this machine runs ${machineOs(host.platform)}.`);
    if (host.wslDistro && wslPath.distro.toLowerCase() !== host.wslDistro.toLowerCase()) {
      throw new Error(`"${value}" is in the ${wslPath.distro} distribution; Pane here runs in ${host.wslDistro}. Name the Windows machine instead.`);
    }
    return path.posix.normalize(wslPath.linuxPath);
  }
  if (WINDOWS_DRIVE_PATH.test(value)) {
    if (!host.isWsl) throw new Error(`"${value}" is a Windows path; this machine runs ${machineOs(host.platform)}.`);
    return windowsPathToWSLMount(path.win32.normalize(value));
  }
  if (!value.startsWith('/')) throw new Error(`Path must be absolute: "${value}".`);
  return path.posix.normalize(value);
}


type MachineOs = 'macOS' | 'Windows' | 'Linux';

export interface MachineInfo {
  hostname: string;
  os: MachineOs;
  isWsl: boolean;
  shell: string;
  homeDir: string;
  wslDistros: string[];
}

export interface MachineReadResult {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
  bytes: number;
}

export interface MachineWriteResult {
  path: string;
  bytes: number;
}

export interface MachineExecResult {
  os: MachineOs;
  shell: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when a timeout could not stop the command's process tree. */
  stillRunning?: true;
  stdout: string;
  stderr: string;
}

const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_TIMEOUT_MS = 9 * 60_000;
const OUTPUT_DRAIN_MS = 500;
/** How long a timed-out command's tree gets to die before the request answers anyway. */
const STOP_TIMEOUT_MS = 1_500;

export async function describeMachine(preferredShell?: string): Promise<MachineInfo> {
  const wslDistros = process.platform === 'win32' ? await listWSLDistributions().catch(() => []) : [];
  return {
    hostname: os.hostname(),
    os: machineOs(process.platform),
    isWsl: isWsl(),
    shell: ShellDetector.getDefaultShell(preferredShell).name,
    homeDir: os.homedir(),
    wslDistros,
  };
}

export async function readMachineFile(request: { path: string }): Promise<MachineReadResult> {
  const target = resolveMachinePath(request.path, await currentHost());
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const content = entries.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name).sort().join('\n');
    return { path: target, encoding: 'utf8', content: content ? `${content}\n` : '', bytes: 0 };
  }
  if (!stat.isFile()) {
    throw new Error(`${target} is not a regular file or directory.`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`${target} is ${stat.size} bytes; workspace read returns files up to ${MAX_READ_BYTES} bytes.`);
  }
  const buffer = await fs.readFile(target);
  const text = decodeUtf8(buffer);
  return text === null
    ? { path: target, encoding: 'base64', content: buffer.toString('base64'), bytes: buffer.length }
    : { path: target, encoding: 'utf8', content: text, bytes: buffer.length };
}

export async function writeMachineFile(request: {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}): Promise<MachineWriteResult> {
  const target = resolveMachinePath(request.path, await currentHost());
  const buffer = Buffer.from(request.content, request.encoding ?? 'utf8');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  return { path: target, bytes: buffer.length };
}

export async function execOnMachine(
  request: { command: string; cwd?: string; timeoutMs?: number },
  preferredShell?: string,
): Promise<MachineExecResult> {
  const cwd = request.cwd ? resolveMachinePath(request.cwd, await currentHost()) : os.homedir();
  const timeoutMs = Math.min(request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);
  const { shell, args } = ShellDetector.getShellCommandArgs(request.command, preferredShell);
  const env = process.platform === 'win32' ? process.env : { ...process.env, PATH: getShellPath() };

  return new Promise((resolve, reject) => {
    // Its own process group on POSIX, so a timeout can stop everything the command started.
    const child = spawn(shell, args, {
      cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = new OutputCollector();
    const stderr = new OutputCollector();
    let timedOut = false;
    let settled = false;
    const result = (fields: Pick<MachineExecResult, 'exitCode' | 'signal'> & { stillRunning?: true }): MachineExecResult => ({
      os: machineOs(process.platform),
      shell: path.basename(shell),
      cwd,
      ...fields,
      timedOut,
      stdout: stdout.text(),
      stderr: stderr.text(),
    });
    const settle = (value: MachineExecResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void stopProcessTree(child.pid).then((stopped) => {
        if (!stopped) settle(result({ exitCode: null, signal: null, stillRunning: true }));
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    // A background job (`server &`) keeps the pipes open after the shell exits; answer at exit
    // and stop waiting for output shortly after.
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      const finish = () => settle(result({ exitCode, signal }));
      const drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      }, OUTPUT_DRAIN_MS);
      child.once('close', () => {
        clearTimeout(drain);
        finish();
      });
    });
  });
}

/** Whether the command and everything it started are gone. Never throws. */
async function stopProcessTree(pid: number | undefined): Promise<boolean> {
  if (!pid) return true;
  if (process.platform !== 'win32') {
    // The group also reaches background jobs whose parent shell already exited.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group already exited.
    }
  }
  return (await terminateProcessTrees([pid], { timeoutMs: STOP_TIMEOUT_MS })).length === 0;
}

class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  push(chunk: Buffer): void {
    if (this.size >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    const text = Buffer.concat(this.chunks).subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
    return this.truncated ? `${text}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]\n` : text;
  }
}

let defaultWslDistro: Promise<string | undefined> | null = null;

async function currentHost(): Promise<MachinePathHost> {
  if (process.platform === 'win32') {
    defaultWslDistro ??= getDefaultWSLDistribution();
  }
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    isWsl: isWsl(),
    wslDistro: process.platform === 'win32' ? await defaultWslDistro ?? undefined : process.env.WSL_DISTRO_NAME,
  };
}

function decodeUtf8(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function isWsl(): boolean {
  return process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function machineOs(platform: NodeJS.Platform): MachineOs {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
}
