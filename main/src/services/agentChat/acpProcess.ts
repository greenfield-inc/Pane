import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Readable, Writable } from 'stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { ArchiveProcessTracker, readArchiveProcesses, type ArchiveProcessIdentity } from '../archiveProcessTracker';
import { AcpSession, type AcpSessionOptions } from './acpSession';

export interface AcpProcessOptions extends AcpSessionOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  generation: number;
  save: (identities: ArchiveProcessIdentity[]) => void;
}

/** One upstream stdio adapter on the owning host. It survives viewer detach. */
export class AcpProcess {
  readonly session: AcpSession;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly tracker: ArchiveProcessTracker;
  private identities: ArchiveProcessIdentity[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private observation: Promise<void> = Promise.resolve();
  private observing = false;
  private observationError?: unknown;
  private releasePromise?: Promise<void>;
  private startupError?: Error;

  constructor(private readonly options: AcpProcessOptions) {
    this.child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, stdio: 'pipe', windowsHide: true });
    this.child.on('error', error => { this.startupError = error; });
    // Always drain stderr so a verbose adapter cannot block its protocol.
    this.child.stderr.resume();
    this.tracker = new ArchiveProcessTracker([], identities => {
      if (JSON.stringify(identities) === JSON.stringify(this.identities)) return;
      this.identities = structuredClone(identities);
      options.save(this.identities);
    });
    // SAFETY: Node and DOM declare the same web stream contract with different
    // iterator overloads. stdout is a byte stream, never an object-mode stream.
    const readable = Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>;
    this.session = new AcpSession(ndJsonStream(Writable.toWeb(this.child.stdin), readable), options.generation, options);
  }

  async start(): Promise<void> {
    if (this.startupError) throw this.startupError;
    if (!this.child.pid) throw new PaneError('CHAT_ADAPTER_START_FAILED', 'The adapter process could not be started.', 'Install the pinned adapter and check its executable path.');
    await this.tracker.capture([this.child.pid]);
    if (this.identities.length === 0) throw new PaneError('CHAT_PROCESS_IDENTITY_UNVERIFIED', 'The adapter exited before its process identity could be verified.', 'Inspect the stopped runtime before recovering the conversation.');
    this.timer = setInterval(() => {
      if (this.observing) return;
      this.observing = true;
      this.observation = this.tracker.refresh().catch(error => { this.observationError = error; }).finally(() => { this.observing = false; });
    }, 200);
    this.timer.unref();
  }

  release(): Promise<void> {
    this.releasePromise ??= this.releaseOnce().catch(error => { this.releasePromise = undefined; throw error; });
    return this.releasePromise;
  }

  private async releaseOnce(): Promise<void> {
    let protocolError: unknown;
    try {
      try { await this.session.close(); } catch (error) { protocolError = error; }
      this.child.stdin.end();
      const deadline = Date.now() + 1500;
      while (this.child.exitCode === null && this.child.signalCode === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await this.tracker.refresh();
        const root = this.identities.find(identity => identity.pid === this.child.pid);
        const current = (await readArchiveProcesses()).find(identity => identity.pid === this.child.pid);
        if (root && current?.started === root.started && !current.exited) this.child.kill('SIGTERM');
      }
    } finally { if (this.timer) clearInterval(this.timer); }
    await this.observation;
    await this.tracker.refresh();
    await this.tracker.terminateSurvivors();
    await this.tracker.verifyExited(5000);
    if (this.observationError) throw new PaneError('CHAT_PROCESS_OBSERVATION_FAILED', `Process ownership observation failed: ${reasonOf(this.observationError)}.`, 'Verify the stopped conversation before explicitly recovering it.');
    if (protocolError) throw new PaneError('CHAT_CLOSE_UNCONFIRMED', `The adapter exited, but did not acknowledge session close: ${reasonOf(protocolError)}.`, 'Recover the exact conversation explicitly after inspecting its state.');
  }
}
