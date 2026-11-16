import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

/** What device_run reports about a command. */
export interface DeviceJobResult {
  jobId: string;
  owner: string;
  state: 'running' | 'exited';
  exitCode?: number;
  /** The last lines of combined output. */
  logTail: string;
}

const TAIL_BYTES = 16 * 1024;

interface Job {
  id: string;
  owner: string;
  child: ChildProcess;
  tail: string;
  exitCode?: number;
  exited: Promise<void>;
}

/**
 * Commands device_run starts (a build, Metro). Each belongs to one owner (a Pane, or a linked
 * computer's Pane), keeps a log tail and its exit code, and stops with its owner.
 */
export class DeviceJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly options: { shell: () => { executable: string; args: (command: string) => string[] } }) {}

  /** Starts `command` in `cwd` and waits up to `waitMs` for it to exit. */
  async start(owner: string, command: string, cwd: string, waitMs: number, env: NodeJS.ProcessEnv = {}): Promise<DeviceJobResult> {
    const shell = this.options.shell();
    const child = spawn(shell.executable, shell.args(command), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const job: Job = { id: randomUUID(), owner, child, tail: '', exited: Promise.resolve() };
    const append = (chunk: Buffer) => {
      job.tail = (job.tail + chunk.toString('utf8')).slice(-TAIL_BYTES);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    job.exited = new Promise<void>((resolve) => {
      child.once('error', (error) => { append(Buffer.from(`\n${error.message}\n`)); job.exitCode = 127; resolve(); });
      child.once('exit', (code, signal) => { job.exitCode = code ?? (signal ? 128 : 1); resolve(); });
    });
    this.jobs.set(job.id, job);
    return this.wait(owner, job.id, waitMs);
  }

  /** The job's state after waiting up to `waitMs` for it to exit. */
  async wait(owner: string, jobId: string, waitMs: number): Promise<DeviceJobResult> {
    const job = this.jobs.get(jobId);
    if (!job || job.owner !== owner) throw new Error(`No device job ${jobId} for this Pane`);
    if (waitMs > 0) await Promise.race([job.exited, new Promise((resolve) => setTimeout(resolve, waitMs).unref())]);
    return this.describe(job);
  }

  /** Stops every job `owner` started. */
  async stopAll(owner: string): Promise<number> {
    const mine = [...this.jobs.values()].filter(job => job.owner === owner);
    await Promise.all(mine.map(job => this.stop(job)));
    return mine.length;
  }

  running(owner?: string): DeviceJobResult[] {
    return [...this.jobs.values()].filter(job => job.exitCode === undefined && (owner === undefined || job.owner === owner)).map(job => this.describe(job));
  }

  private describe(job: Job): DeviceJobResult {
    const result: DeviceJobResult = { jobId: job.id, owner: job.owner, state: job.exitCode === undefined ? 'running' : 'exited', logTail: job.tail };
    if (job.exitCode !== undefined) result.exitCode = job.exitCode;
    return result;
  }

  private async stop(job: Job): Promise<void> {
    this.jobs.delete(job.id);
    if (job.exitCode !== undefined || job.child.pid === undefined) return;
    try {
      // The job's whole process group: Metro and build tools start children of their own.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(job.child.pid), '/t', '/f'], { windowsHide: true });
      else process.kill(-job.child.pid, 'SIGTERM');
    } catch {
      job.child.kill('SIGTERM');
    }
    await Promise.race([job.exited, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    if (job.exitCode === undefined && process.platform !== 'win32') {
      try { process.kill(-job.child.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}
