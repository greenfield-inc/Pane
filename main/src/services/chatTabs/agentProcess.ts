import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { Readable, Writable } from 'stream';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { PaneError } from '../../../../shared/paneError';

export interface AgentCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

export interface AgentExit { code: number | null; signal: NodeJS.Signals | null; error?: Error }

const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * One chat tab's adapter process. It is the leader of its own process group
 * (POSIX), so stopping it also ends the claude or codex process the adapter
 * started. Pane learns about exits from the child's own events: there is no
 * polling of the process table (a 200 ms `ps` poll cost ~11% of a core per tab).
 */
export class AgentProcess {
  readonly stream: Stream;
  readonly exited: Promise<AgentExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = '';
  private exit?: AgentExit;

  constructor(command: AgentCommand) {
    this.child = spawn(command.executable, command.args, {
      cwd: command.cwd, env: command.env, stdio: 'pipe', windowsHide: true,
      detached: process.platform !== 'win32', windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    this.exited = new Promise(resolve => {
      this.child.once('error', error => { this.exit ??= { code: null, signal: null, error }; resolve(this.exit); });
      this.child.once('exit', (code, signal) => { this.exit ??= { code, signal }; resolve(this.exit); });
    });
    // Always drain stderr so a verbose adapter cannot block; keep a tail for error messages.
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES); });
    // A write after the adapter exits must not crash the host.
    this.child.stdin.on('error', () => undefined);
    // SAFETY: Node and DOM declare the same web stream contract with different
    // iterator overloads. stdout is a byte stream, never an object-mode stream.
    const readable = Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>;
    this.stream = ndJsonStream(Writable.toWeb(this.child.stdin), readable);
  }

  get pid(): number | undefined { return this.child.pid; }
  get running(): boolean { return !this.exit; }
  stderrTail(): string { return this.stderr.trim(); }

  /** Resolves once the process exists, or rejects with why it could not start. */
  async started(): Promise<void> {
    if (this.child.pid) return;
    const exit = await Promise.race([this.exited, new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)))]);
    if (exit?.error || !this.child.pid) {
      throw new PaneError('CHAT_ADAPTER_START_FAILED', `The agent adapter could not start: ${exit?.error?.message ?? 'no process was created'}.`, 'Check that the adapter is installed, then press Restart.');
    }
  }

  /** Ends the adapter and everything it started. Closing stdin first lets it save its session. */
  async stop(graceMs = 1500): Promise<void> {
    if (this.exit) { this.killGroup('SIGKILL'); return; }
    this.child.stdin.end();
    if (await this.waitExit(graceMs)) { this.killGroup('SIGTERM'); return; }
    this.killGroup('SIGTERM');
    if (await this.waitExit(3000)) return;
    this.killGroup('SIGKILL');
    await this.waitExit(2000);
  }

  private async waitExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([this.exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    if (timer) clearTimeout(timer);
    return exited;
  }

  /** The group outlives its leader when the agent left children running; signal it either way. */
  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      return;
    }
    try { process.kill(-pid, signal); } catch { /* The group already ended. */ }
  }
}
