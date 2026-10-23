import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { Socket } from 'net';
import type { DuplexOptions } from 'stream';
import { PaneError } from '../../../../shared/paneError';
import { ArchiveProcessTracker, type ArchiveProcessIdentity } from '../archiveProcessTracker';
import { providerCommand } from './hostCommand';
import { CodexSession, type CodexSessionOptions } from './codexSession';

export const CODEX_TOKEN_ENV = 'PANE_CODEX_CHAT_TOKEN';
export interface CodexProcessOptions extends CodexSessionOptions {
  executable: string;
  configArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  directory: string;
  /** Borrowed provider owner; only the proxy child belongs to Pane. */
  socketPath?: string;
  generation: number;
  save: (identities: ArchiveProcessIdentity[]) => void;
}

/** A per-tab provider owner, shared by its Chat and native TUI clients. It never
 * adopts or terminates the user's shared Codex daemon. */
export class CodexProcess {
  endpoint = '';
  readonly token = randomBytes(32).toString('base64url');
  private child?: ChildProcessWithoutNullStreams;
  private tracker: ArchiveProcessTracker;
  private connection?: CodexSession;
  private timer?: ReturnType<typeof setInterval>;
  private observation = Promise.resolve();
  private observationError?: Error;
  private releasePromise?: Promise<void>;
  private spawnError?: Error;

  constructor(private readonly options: CodexProcessOptions) {
    this.tracker = new ArchiveProcessTracker([], options.save);
  }

  get session(): CodexSession {
    if (!this.connection) throw new PaneError('CHAT_CODEX_NOT_CONNECTED', 'The Codex host connection is not ready.', 'Wait for setup or inspect the startup error.');
    return this.connection;
  }

  async start(): Promise<void> {
    if (this.options.socketPath) return this.attachProxy(this.options.socketPath);
    const digest = createHash('sha256').update(this.token).digest('hex');
    const command = providerCommand(this.options.executable, [...this.options.configArgs, 'app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token', '--ws-token-sha256', digest], 'codex');
    const env = { ...this.options.env };
    if (command.executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
    this.child = spawn(command.executable, command.args, { cwd: this.options.cwd, env, windowsVerbatimArguments: command.windowsVerbatimArguments, windowsHide: true, stdio: 'pipe' });
    this.child.on('error', error => { this.spawnError = error; });
    this.child.stdout.resume();
    let banner = '';
    this.child.stderr.on('data', (data: Buffer) => {
      banner = (banner + data.toString('utf8')).slice(-16_384);
      const match = banner.match(/(?:^|\n)listening on: (ws:\/\/127\.0\.0\.1:(\d+))\r?\n/);
      if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) this.endpoint = match[1];
    });
    if (!this.child.pid) throw new PaneError('CHAT_CODEX_START_FAILED', 'Codex could not start its conversation server.', 'Check the installed Codex executable and retry.');
    await this.tracker.capture([this.child.pid]);
    this.timer = setInterval(() => {
      this.observation = this.observation.then(() => this.tracker.refresh()).catch(error => { this.observationError = error instanceof Error ? error : new Error(String(error)); });
    }, 200);
    this.timer.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (this.spawnError) throw this.spawnError;
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new PaneError('CHAT_CODEX_START_FAILED', 'Codex exited before opening its authenticated conversation server.', 'Check that this CLI supports app-server WebSocket authentication and inspect its launch configuration.');
      const socket = this.endpoint ? await this.connect() : undefined;
      if (socket) { this.connection = new CodexSession(socket, this.options.generation, this.options); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new PaneError('CHAT_CODEX_CONNECT_FAILED', 'Codex did not open its authenticated conversation server.', 'Check the CLI installation and local network policy, then retry.');
  }

  private async attachProxy(socketPath: string): Promise<void> {
    const command = providerCommand(this.options.executable, ['app-server', 'proxy', '--socket', socketPath], 'codex');
    const env = { ...this.options.env };
    if (command.executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
    this.child = spawn(command.executable, command.args, { cwd: this.options.cwd, env, windowsVerbatimArguments: command.windowsVerbatimArguments, windowsHide: true, stdio: 'pipe' });
    this.child.on('error', error => { this.spawnError = error; });
    this.child.stderr.resume();
    if (!this.child.pid) throw new PaneError('CHAT_CODEX_START_FAILED', 'The connection to the existing Codex server could not start.', 'Check the server shown by /status in this tab.');
    await this.tracker.capture([this.child.pid]);
    const child = this.child;
    // HTTP Upgrade needs a Socket-shaped duplex. Its bytes travel through the
    // native proxy rather than a TCP connection or a Node Windows pipe guess.
    const streamOptions: DuplexOptions = {
      allowHalfOpen: false,
      read() { child.stdout.resume(); },
      write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
      writev(chunks, callback) {
        const buffers = chunks.map(({ chunk }) => {
          if (!Buffer.isBuffer(chunk)) throw new Error('The Codex proxy requires byte frames');
          return chunk;
        });
        child.stdin.write(Buffer.concat(buffers), callback);
      },
      final(callback) { child.stdin.end(callback); },
      destroy(error, callback) { child.stdout.destroy(); child.stdin.destroy(); callback(error); },
    };
    const connection = new Socket(streamOptions);
    child.stdout.on('data', (data: Buffer) => { if (!connection.push(data)) child.stdout.pause(); });
    child.stdout.on('end', () => connection.push(null));
    child.stdout.on('error', error => connection.destroy(error));
    child.stdin.on('error', error => connection.destroy(error));
    const socket = new WebSocket('ws://localhost/', { createConnection: () => connection, handshakeTimeout: 5000 });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    this.endpoint = `unix://${socketPath}`;
    this.connection = new CodexSession(socket, this.options.generation, this.options);
  }

  private connect(): Promise<WebSocket | undefined> {
    return new Promise(resolve => {
      const socket = new WebSocket(this.endpoint, { headers: { Authorization: `Bearer ${this.token}` }, handshakeTimeout: 1000 });
      socket.once('open', () => resolve(socket));
      socket.once('error', () => { socket.terminate(); resolve(undefined); });
    });
  }

  release(cancel = true): Promise<void> {
    this.releasePromise ??= this.releaseOnce(cancel).catch(error => { this.releasePromise = undefined; throw error; });
    return this.releasePromise;
  }

  private async releaseOnce(cancel: boolean): Promise<void> {
    if (this.connection) {
      if (cancel) await this.connection.cancel();
      await this.connection.close();
    }
    if (this.timer) clearInterval(this.timer);
    await this.observation;
    await this.tracker.refresh();
    await this.tracker.terminateSurvivors();
    await this.tracker.verifyExited(5000);
    if (this.observationError) throw this.observationError;
  }
}
