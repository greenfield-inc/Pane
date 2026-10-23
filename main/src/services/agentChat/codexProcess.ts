import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { Socket } from 'net';
import type { DuplexOptions } from 'stream';
import { PaneError } from '../../../../shared/paneError';
import { ArchiveProcessTracker, type ArchiveProcessIdentity } from '../archiveProcessTracker';
import { providerCommand } from './hostCommand';
import { CodexSession, type CodexSessionOptions } from './codexSession';
import { CodexNativeConnection } from './codexNativeConnection';
import type { AgentChatStartAttempt } from '../../../../shared/types/agentChat';

export const CODEX_TOKEN_ENV = 'PANE_CODEX_CHAT_TOKEN';
export interface CodexProcessOptions extends CodexSessionOptions {
  executable: string;
  configArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  directory: string;
  /** Borrowed provider owner; only the proxy child belongs to Pane. */
  socketPath?: string;
  remote?: { endpoint: string; authTokenEnv?: string };
  generation: number;
  save: (identities: ArchiveProcessIdentity[]) => void;
  onNativeState?: (id?: string) => void;
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
  private observing = false;
  private observationError?: Error;
  private releasePromise?: Promise<void>;
  private spawnError?: Error;
  private nativeConnection?: CodexNativeConnection;
  private nativeEndpoint?: string;

  constructor(private readonly options: CodexProcessOptions) {
    this.tracker = new ArchiveProcessTracker([], options.save);
  }

  get session(): CodexSession {
    if (!this.connection) throw new PaneError('CHAT_CODEX_NOT_CONNECTED', 'The Codex host connection is not ready.', 'Wait for setup or inspect the startup error.');
    return this.connection;
  }

  async start(): Promise<void> {
    if (this.options.remote) {
      this.endpoint = this.options.remote.endpoint;
      const socket = await this.connect();
      if (!socket) throw new PaneError('CHAT_CODEX_CONNECT_FAILED', 'The original remote Codex server could not be reached.', 'Check its existing connection and authentication, then retry identification.');
      this.connection = new CodexSession(socket, this.options.generation, this.options);
      this.options.save([]);
      return;
    }
    if (this.options.socketPath) {
      const socket = await this.proxySocket(this.options.socketPath);
      this.endpoint = `unix://${this.options.socketPath}`;
      this.connection = new CodexSession(socket, this.options.generation, this.options);
      return;
    }
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
      const match = banner.match(/(?:^|\n)[ \t]*listening on: (ws:\/\/127\.0\.0\.1:(\d+))\r?\n/);
      if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) this.endpoint = match[1];
    });
    if (!this.child.pid) throw new PaneError('CHAT_CODEX_START_FAILED', 'Codex could not start its conversation server.', 'Check the installed Codex executable and retry.');
    await this.tracker.capture([this.child.pid]);
    this.timer = setInterval(() => {
      // Windows process snapshots can outlast this cadence. Keep one in flight
      // so release waits for current evidence, not a growing queue of snapshots.
      if (this.observing) return;
      this.observing = true;
      this.observation = this.tracker.refresh().catch(error => { this.observationError = error instanceof Error ? error : new Error(String(error)); }).finally(() => { this.observing = false; });
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

  private async proxySocket(socketPath: string): Promise<WebSocket> {
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
    return socket;
  }

  async prepareNative(): Promise<string> {
    if (this.nativeEndpoint) return this.nativeEndpoint;
    this.nativeConnection = new CodexNativeConnection(this.token, async () => {
      const socket = this.options.socketPath ? await this.proxySocket(this.options.socketPath) : await this.connect();
      if (!socket) throw new PaneError('CHAT_NATIVE_CONNECT_FAILED', 'The native client could not connect to the recorded Codex server.', 'Retry the Terminal switch.');
      return socket;
    }, this.options.onNativeState);
    this.nativeEndpoint = await this.nativeConnection.start();
    return this.nativeEndpoint;
  }

  nativeConfirms(id: string): boolean { return this.nativeConnection?.confirms(id) ?? false; }

  async reconcileStart(threadId: string, attempt: AgentChatStartAttempt): Promise<string> {
    if (!this.connection?.isConnected()) {
      await this.connection?.close();
      const socket = this.options.socketPath ? await this.proxySocket(this.options.socketPath) : await this.connect();
      if (!socket) throw new PaneError('CHAT_CODEX_CONNECT_FAILED', 'The original Codex owner could not be reached for delivery recovery.', 'Restore its connection and retry; no prompt was replayed.');
      this.connection = new CodexSession(socket, this.options.generation, this.options);
      await this.connection.initialize();
    }
    const status = await this.connection.readStartOutcome(threadId, attempt);
    // Only positive correlation permits attaching/subscribing again. An absent
    // marker never counts as rejection or permission to replay the old send.
    await this.connection.load({ sessionId: threadId, cwd: this.options.cwd, mcpServers: [] });
    return status;
  }

  private connect(): Promise<WebSocket | undefined> {
    const authEnv = this.options.remote?.authTokenEnv;
    const token = this.options.remote ? (authEnv ? this.options.env[authEnv] : undefined) : this.token;
    if (authEnv && !token) throw new PaneError('CHAT_CODEX_AUTH_MISSING', 'The original remote Codex authentication environment is unavailable.', 'Restore this tab’s launch environment and retry; no alternate server was started.');
    return new Promise(resolve => {
      const socket = new WebSocket(this.endpoint, { headers: token ? { Authorization: `Bearer ${token}` } : {}, handshakeTimeout: 5000 });
      socket.once('open', () => resolve(socket));
      socket.once('error', () => { socket.terminate(); resolve(undefined); });
    });
  }

  release(cancel = true): Promise<void> {
    this.releasePromise ??= this.releaseOnce(cancel).catch(error => { this.releasePromise = undefined; throw error; });
    return this.releasePromise;
  }

  private async releaseOnce(cancel: boolean): Promise<void> {
    let cancelError: unknown;
    if (this.connection) {
      try { if (cancel && this.connection.isConnected()) await this.connection.cancel(); }
      catch (error) { cancelError = error; }
      finally { await this.connection.close(); }
    }
    await this.nativeConnection?.close();
    if (this.timer) clearInterval(this.timer);
    await this.observation;
    await this.tracker.refresh();
    await this.tracker.terminateSurvivors();
    await this.tracker.verifyExited(5000);
    if (this.observationError) throw this.observationError;
    // Killing the owned server confirms its work stopped. Closing a borrowed
    // proxy cannot establish that for the externally owned daemon.
    if ((this.options.socketPath || this.options.remote) && (cancelError || (cancel && this.connection?.hasUnconfirmedStart()))) {
      throw cancelError ?? new PaneError('CHAT_START_UNCONFIRMED', 'The borrowed provider still has an unconfirmed turn start.', 'Inspect or stop that conversation in its original native terminal before recovery.');
    }
  }
}
