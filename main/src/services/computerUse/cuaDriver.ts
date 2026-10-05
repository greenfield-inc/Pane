import { execFile, spawn, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { getPaneDaemonSocketDirectory } from '../../daemon/socketPath';
import { getAppDirectory } from '../../utils/appDirectory';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import type { ComputerUseEngine, EngineImage, EngineResult, EngineStatus } from './engine';

const execFileAsync = promisify(execFile);

/**
 * The pinned upstream Cua Driver release. To move the pin, copy the new
 * archive hashes from the release's SHA256SUMS (whose Sigstore bundle
 * verifies against trycua/cua's release workflow).
 */
export const CUA_DRIVER_VERSION = '0.33.3';
const RELEASE_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}`;
const ARCHIVES = new Map<string, { file: string; sha256: string }>(Object.entries({
  'darwin-arm64': { file: 'darwin-universal.tar.gz', sha256: 'e4d5a6c2f8b1dff776bc7260717b723d753c3deeb020469a6eb85eacf862bfca' },
  'darwin-x64': { file: 'darwin-universal.tar.gz', sha256: 'e4d5a6c2f8b1dff776bc7260717b723d753c3deeb020469a6eb85eacf862bfca' },
  'linux-x64': { file: 'linux-x86_64.tar.gz', sha256: 'ec3e2816bc0321ba6c606b59b9cfc1eb6d08ce51029e9169114058d1131de420' },
  'linux-arm64': { file: 'linux-arm64.tar.gz', sha256: 'ae0697ed784e042707eba80d854d5e68372ead545f83ad5f04ef1ca987daa4c2' },
  'win32-x64': { file: 'windows-x86_64.zip', sha256: 'a0ccee0acc027ea95f639c125fde671e0934a60cf3e2c5e2bbfaf7fc35afdd29' },
  'win32-arm64': { file: 'windows-arm64.zip', sha256: '021969f2947570ada5d75d8f09bd2ec2ccfd8ef12c32cca523802f6af7899090' },
}));

/** Cua AI's Apple Developer ID team, and the Authenticode signer on Windows. */
const MAC_TEAM_ID = 'YCK386LBJ7';
const WINDOWS_SIGNER = /^CN="?Cua AI, Inc\."?(,|$)/;

/** Upstream defaults these on; Pane pins the version and keeps usage local. */
const DAEMON_ENV = {
  DO_NOT_TRACK: '1',
  CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
  CUA_DRIVER_RS_UPDATE_CHECK: '0',
};

const START_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const PERMISSION_REQUEST_TIMEOUT_MS = 180_000;
/** macOS caches a denied Screen Recording answer per process, so a helper waiting on a grant is relaunched this often. */
const PERMISSION_RECHECK_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;

interface CuaDriverOptions {
  appDirectory?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  releaseUrl?: string;
}

interface Layout {
  platform: NodeJS.Platform;
  arch: string;
  root: string;
  versionDir: string;
  app: string | null;
  executable: string;
  endpoint: string;
  pidFile: string;
  log: string;
}

function resolveLayout(options: CuaDriverOptions = {}): Layout {
  const appDirectory = path.resolve(options.appDirectory ?? getAppDirectory());
  const platform = options.platform ?? process.platform;
  const root = path.join(appDirectory, 'computer-use', 'cua-driver');
  const versionDir = path.join(root, CUA_DRIVER_VERSION);
  const app = platform === 'darwin' ? path.join(versionDir, 'CuaDriver.app') : null;
  const executable = app
    ? path.join(app, 'Contents', 'MacOS', 'cua-driver')
    : path.join(versionDir, platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
  const hash = createHash('sha256').update(platform === 'win32' ? appDirectory.toLowerCase() : appDirectory).digest('hex').slice(0, 16);
  // Unix socket paths must stay under ~104 bytes, so reuse the Pane daemon's short private directory.
  const socketDirectory = getPaneDaemonSocketDirectory(appDirectory, platform);
  const endpoint = socketDirectory ? path.posix.join(socketDirectory, 'cua-driver.sock') : `\\\\.\\pipe\\pane-cua-driver-${hash}`;
  return {
    platform,
    arch: options.arch ?? process.arch,
    root,
    versionDir,
    app,
    executable,
    endpoint,
    pidFile: path.join(root, 'cua-driver.pid'),
    log: path.join(root, 'cua-driver.log'),
  };
}

function hasDesktopSession(layout: Layout): boolean {
  if (layout.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// ---------------------------------------------------------------------------
// Install and verify

/**
 * Installs the pinned Cua Driver release under Pane's directory, or re-verifies
 * an existing install. Idempotent. Throws an Error with a user-readable message.
 */
export function installCuaDriver(options: CuaDriverOptions = {}): Promise<void> {
  const layout = resolveLayout(options);
  let install = installsInFlight.get(layout.root);
  if (!install) {
    install = installOnce(layout, options.releaseUrl ?? RELEASE_URL).finally(() => installsInFlight.delete(layout.root));
    installsInFlight.set(layout.root, install);
  }
  return install;
}

const installsInFlight = new Map<string, Promise<void>>();

async function installOnce(layout: Layout, releaseUrl: string): Promise<void> {
  const archive = ARCHIVES.get(`${layout.platform}-${layout.arch}`);
  if (!archive) {
    throw new Error(`Cua Driver has no release for ${layout.platform} ${layout.arch}.`);
  }

  if (fs.existsSync(layout.executable)) {
    try {
      await verifySignature(layout, layout.versionDir);
      return;
    } catch (error) {
      console.warn(`[computer-use] Reinstalling Cua Driver ${CUA_DRIVER_VERSION}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  fs.mkdirSync(layout.root, { recursive: true });
  const staging = path.join(layout.root, `.staging-${randomUUID()}`);
  fs.mkdirSync(staging);
  try {
    const fileName = `cua-driver-rs-${CUA_DRIVER_VERSION}-${archive.file}`;
    const archivePath = path.join(staging, fileName);
    await download(`${releaseUrl}/${fileName}`, archivePath, archive.sha256);

    const extracted = path.join(staging, 'extracted');
    fs.mkdirSync(extracted);
    await extract(layout.platform, archivePath, extracted);
    const [topLevel] = fs.readdirSync(extracted);
    const unpacked = path.join(extracted, topLevel ?? '');
    if (!topLevel || !fs.existsSync(path.join(unpacked, path.relative(layout.versionDir, layout.executable)))) {
      throw new Error('The Cua Driver download is missing its program.');
    }
    await verifySignature(layout, unpacked);

    // A running helper locks its files on Windows and would keep the replaced binary on the others.
    await shutdownHelper(layout);
    try {
      fs.rmSync(layout.versionDir, { recursive: true, force: true });
      fs.renameSync(unpacked, layout.versionDir);
    } catch (error) {
      throw new Error(`Couldn't replace the installed Cua Driver: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  removeOtherVersions(layout);
}

async function download(url: string, target: string, expectedSha256: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'pane-computer-use' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Couldn't download Cua Driver: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`Couldn't download Cua Driver: HTTP ${response.status}.`);
  }
  const hash = createHash('sha256');
  // SAFETY: fetch's web ReadableStream is the stream Readable.fromWeb accepts; only the DOM and node typings differ.
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, fs.createWriteStream(target));
  const actual = hash.digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(`The Cua Driver download failed its checksum (expected ${expectedSha256}, got ${actual}).`);
  }
}

async function extract(platform: NodeJS.Platform, archivePath: string, into: string): Promise<void> {
  // Windows' own bsdtar reads zip; a Git-for-Windows tar earlier on PATH would not.
  const tar = platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  try {
    await execFileAsync(tar, ['-xf', archivePath, '-C', into], { windowsHide: true });
  } catch (error) {
    throw new Error(`Couldn't unpack Cua Driver: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Checks the vendor signature: Developer ID on macOS, Authenticode on every
 * Windows binary. Linux ships unsigned binaries, so there the pinned checksum
 * at download is the only check and an existing install is trusted like any
 * other file in Pane's directory.
 */
async function verifySignature(layout: Layout, dir: string): Promise<void> {
  if (layout.platform === 'darwin') {
    const app = path.join(dir, 'CuaDriver.app');
    const requirement = `=anchor apple generic and identifier "com.trycua.driver" and certificate leaf[subject.OU] = "${MAC_TEAM_ID}"`;
    try {
      await execFileAsync('codesign', ['--verify', '--deep', '--strict', `-R${requirement}`, app]);
    } catch (error) {
      throw new Error(`Cua Driver's macOS signature didn't verify as Cua AI (${MAC_TEAM_ID}): ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (layout.platform === 'win32') {
    const literal = dir.replace(/'/g, "''");
    const script = [
      `Get-ChildItem -LiteralPath '${literal}' -File | Where-Object { $_.Extension -in '.exe', '.dll', '.node' } | ForEach-Object {`,
      '  $s = Get-AuthenticodeSignature -LiteralPath $_.FullName',
      '  "$($_.Name)|$($s.Status)|$($s.SignerCertificate.Subject)"',
      '}',
    ].join('\n');
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const { stdout } = await execFileAsync(
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      // A PowerShell 7 module path inherited from the parent hides Get-AuthenticodeSignature from Windows PowerShell 5.1.
      { windowsHide: true, env: { ...process.env, PSModulePath: '' } },
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.some((line) => line.startsWith('cua-driver.exe|'))) {
      throw new Error(`Couldn't check Cua Driver's Windows signature (${stdout.trim() || 'no output'}).`);
    }
    for (const line of lines) {
      const [name, status, subject = ''] = line.split('|');
      if (status !== 'Valid' || !WINDOWS_SIGNER.test(subject)) {
        throw new Error(`Cua Driver's ${name} isn't validly signed by Cua AI, Inc. (${status}, ${subject}).`);
      }
    }
  }
}

function removeOtherVersions(layout: Layout): void {
  for (const entry of fs.readdirSync(layout.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === CUA_DRIVER_VERSION) continue;
    try {
      fs.rmSync(path.join(layout.root, entry.name), { recursive: true, force: true });
    } catch {
      // A running old helper on Windows locks its files; the next install retries.
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon protocol: one JSON line per request and per response.

const daemonResponseSchema = boundary.object({
  ok: boundary.boolean,
  result: boundary.optional(boundary.json),
  error: boundary.optional(boundary.string),
});
type DaemonResponse = ReturnType<typeof daemonResponseSchema.decode>;

const metadataSchema = boundary.object({ driver_version: boundary.string, pid: boundary.number });
type DaemonMetadata = ReturnType<typeof metadataSchema.decode>;

const toolResultSchema = boundary.object({
  content: boundary.optional(
    boundary.array(
      boundary.object({
        type: boundary.string,
        text: boundary.optional(boundary.string),
        data: boundary.optional(boundary.string),
        mimeType: boundary.optional(boundary.string),
      }),
    ),
  ),
  structuredContent: boundary.optional(boundary.jsonObject),
  isError: boundary.optional(boundary.boolean),
});

const toolErrorSchema = boundary.object({ code: boundary.optional(boundary.string) });

const grantsSchema = boundary.object({
  accessibility: boundary.optional(boundary.boolean),
  screen_recording: boundary.optional(boundary.boolean),
  source: boundary.optional(boundary.object({ attribution: boundary.optional(boundary.string) })),
});

function sendRequest(endpoint: string, request: JsonObject, timeoutMs = CALL_TIMEOUT_MS): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Cua Driver didn't answer within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    const finish = (error: Error | null, response?: DaemonResponse) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
    };
    const settle = () => {
      try {
        finish(null, decodeBoundary(JSON.parse(Buffer.concat(chunks).toString('utf8')), daemonResponseSchema));
      } catch (error) {
        finish(new Error(`Cua Driver sent an unreadable reply: ${error instanceof Error ? error.message : String(error)}`));
      }
    };
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        chunks.push(chunk);
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      settle();
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      if (chunks.length === 0) {
        finish(new Error('Cua Driver closed the connection without replying.'));
        return;
      }
      // Like Cua's own client, treat EOF after data as the end of the reply.
      settle();
    });
  });
}

async function readMetadata(endpoint: string): Promise<DaemonMetadata | null> {
  try {
    const response = await sendRequest(endpoint, { method: 'metadata' }, 2_000);
    return response.ok ? decodeBoundary(response.result, metadataSchema) : null;
  } catch {
    return null;
  }
}

/** Maps a daemon reply to the engine contract. Cua reports tool failures as `isError` results with a `code`. */
function toEngineResult(response: DaemonResponse): EngineResult {
  if (!response.ok) {
    const message = response.error ?? 'Cua Driver failed without a message.';
    const code = /^([a-z]+(?:_[a-z]+)+): /.exec(message)?.[1] ?? 'engine_error';
    return { ok: false, error: { code, message } };
  }
  const result = decodeBoundary(response.result ?? {}, toolResultSchema);
  const content = result.content ?? [];
  const text = content.flatMap((item) => (item.type === 'text' && item.text ? [item.text] : [])).join('\n');
  const images: EngineImage[] = content.flatMap((item) =>
    item.type === 'image' && item.data ? [{ mime: item.mimeType ?? 'image/png', base64: item.data }] : [],
  );
  const engineResult: EngineResult = { ok: !result.isError };
  const data = result.structuredContent ?? text;
  if (data) engineResult.data = data;
  if (images.length > 0) engineResult.images = images;
  if (result.isError) {
    const code = decodeBoundary(result.structuredContent ?? {}, toolErrorSchema).code ?? 'tool_error';
    engineResult.error = { code, message: text || code };
  }
  return engineResult;
}

// ---------------------------------------------------------------------------
// Engine

/**
 * Stops whichever helper owns this Pane's socket: politely over the socket,
 * then by the pid it reported or wrote to its pid file. This also reaps a
 * helper that is still binding or no longer answers.
 */
async function shutdownHelper(layout: Layout): Promise<void> {
  const metadata = await readMetadata(layout.endpoint);
  if (metadata) {
    await sendRequest(layout.endpoint, { method: 'shutdown' }, 2_000).catch(() => undefined);
    const exited = await poll(async () => ((await readMetadata(layout.endpoint)) ? null : true), 3_000);
    if (exited) return;
  }
  const pid = metadata?.pid ?? readPidFile(layout);
  if (pid !== null && (await isCuaDriverProcess(pid))) {
    killQuietly(pid);
  }
}

function readPidFile(layout: Layout): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(layout.pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Guards against killing an unrelated process that reused a stale pid. */
async function isCuaDriverProcess(pid: number): Promise<boolean> {
  try {
    const { stdout } =
      process.platform === 'win32'
        ? await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
        : await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=']);
    return stdout.includes('cua-driver');
  } catch {
    return false;
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

/** Polls until `read` returns a value, or gives up with null. */
async function poll<T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

class CuaDriverEngine implements ComputerUseEngine {
  readonly id = 'cua-driver' as const;
  private starting: Promise<DaemonMetadata> | null = null;
  private child: ChildProcess | null = null;
  /** Bumped by stop(), so a call that was waiting on a start never acts after it. */
  private generation = 0;
  /** When the current helper started, while it is still missing a macOS permission. */
  private missingPermissionSince: number | null = null;

  constructor(private readonly options: CuaDriverOptions) {}

  /** Reports live state. It starts the helper when installed, since only the helper can read its own permissions. */
  async status(): Promise<EngineStatus> {
    const layout = resolveLayout(this.options);
    const desktopSession = hasDesktopSession(layout);
    if (!fs.existsSync(layout.executable)) {
      return { installed: false, permissions: {}, desktopSession, detail: 'Cua Driver is not installed.' };
    }
    if (!desktopSession) {
      return { installed: true, permissions: {}, desktopSession, detail: 'No desktop session (DISPLAY and WAYLAND_DISPLAY are unset).' };
    }
    const status: EngineStatus = { installed: true, permissions: {}, desktopSession };
    try {
      if (this.missingPermissionSince !== null && Date.now() - this.missingPermissionSince >= PERMISSION_RECHECK_MS) {
        // A fresh helper reads the grant the user may have just made in System Settings.
        await this.stop();
      }
      const metadata = await this.ensureDaemon();
      status.version = metadata.driver_version;
      if (layout.platform === 'darwin') {
        const check = toEngineResult(await sendRequest(layout.endpoint, { method: 'call', name: 'check_permissions', args: { prompt: false } }));
        const grants = check.ok ? decodeBoundary(check.data ?? {}, grantsSchema) : null;
        // Only the helper running as CuaDriver.app can answer for its own grants.
        if (grants?.source?.attribution === 'driver-daemon') {
          status.permissions = { accessibility: grants.accessibility === true, screenRecording: grants.screen_recording === true };
          const granted = status.permissions.accessibility && status.permissions.screenRecording;
          this.missingPermissionSince = granted ? null : (this.missingPermissionSince ?? Date.now());
        } else {
          status.detail = check.error?.message ?? 'Cua Driver could not read its own macOS permissions.';
        }
      }
    } catch (error) {
      status.detail = error instanceof Error ? error.message : String(error);
    }
    return status;
  }

  async call(tool: string, args: JsonObject): Promise<EngineResult> {
    const layout = resolveLayout(this.options);
    if (!hasDesktopSession(layout)) {
      return { ok: false, error: { code: 'no_desktop_session', message: 'This machine has no desktop session for computer use.' } };
    }
    const generation = this.generation;
    try {
      await this.ensureDaemon();
      if (generation !== this.generation) {
        return { ok: false, error: { code: 'engine_stopped', message: 'Computer use stopped before this action ran.' } };
      }
      return toEngineResult(await sendRequest(layout.endpoint, { method: 'call', name: tool, args }));
    } catch (error) {
      return { ok: false, error: { code: 'engine_unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.missingPermissionSince = null;
    // Let a start in progress finish binding, so the helper it launched is the one shut down.
    await this.starting?.catch(() => undefined);
    await shutdownHelper(resolveLayout(this.options));
    this.child?.kill();
    this.child = null;
  }

  /** Reuses a running helper of the pinned version, or starts one. */
  private ensureDaemon(): Promise<DaemonMetadata> {
    this.starting ??= this.startDaemon().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startDaemon(): Promise<DaemonMetadata> {
    const layout = resolveLayout(this.options);
    const running = await readMetadata(layout.endpoint);
    if (running?.driver_version === CUA_DRIVER_VERSION) return running;
    if (!fs.existsSync(layout.executable)) {
      throw new Error('Cua Driver is not installed.');
    }
    // Clears an old-version helper, or one that never answered, before a new one takes the socket.
    await shutdownHelper(layout);

    if (layout.endpoint.startsWith('/')) {
      fs.mkdirSync(path.dirname(layout.endpoint), { recursive: true, mode: 0o700 });
    }
    const serveArgs = ['serve', '--socket', layout.endpoint, '--pid-file', layout.pidFile];
    if (layout.app) {
      // Launch through LaunchServices so macOS attributes permissions to CuaDriver.app, not Pane.
      // Pane's status and settings own the permission flow, so Cua's own prompt panel stays off.
      const envArgs = Object.entries(DAEMON_ENV).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
      await execFileAsync('open', ['-n', '-g', '-a', layout.app, '--stdout', layout.log, '--stderr', layout.log, ...envArgs, '--args', ...serveArgs, '--no-permissions-gate']);
    } else {
      const log = fs.openSync(layout.log, 'a');
      try {
        const child = spawn(layout.executable, serveArgs, {
          env: { ...process.env, ...DAEMON_ENV },
          stdio: ['ignore', log, log],
          windowsHide: true,
        });
        child.on('error', (error) => console.warn(`[computer-use] Cua Driver failed to start: ${error.message}`));
        child.on('exit', () => {
          if (this.child === child) this.child = null;
        });
        child.unref();
        this.child = child;
      } finally {
        fs.closeSync(log);
      }
    }

    const metadata = await poll(() => readMetadata(layout.endpoint), START_TIMEOUT_MS);
    if (!metadata) {
      await shutdownHelper(layout);
      this.child?.kill();
      this.child = null;
      throw new Error(`Cua Driver didn't start within ${START_TIMEOUT_MS / 1000} s. See ${layout.log}.`);
    }
    return metadata;
  }
}

/**
 * macOS: asks for Accessibility and Screen Recording on behalf of CuaDriver.app,
 * which adds it to both lists in System Settings, and returns the current
 * grants. macOS prompts at most once per app; after that the user grants in
 * System Settings and status() picks it up. Cua only raises these prompts from a
 * LaunchServices-launched host that writes its answer to a file in the user's
 * private temp directory, never from the daemon socket.
 */
export async function requestCuaDriverPermissions(options: CuaDriverOptions = {}): Promise<EngineStatus['permissions']> {
  const layout = resolveLayout(options);
  if (!layout.app) return {};
  if (!fs.existsSync(layout.executable)) throw new Error('Cua Driver is not installed.');
  const { stdout } = await execFileAsync('getconf', ['DARWIN_USER_TEMP_DIR']);
  const resultFile = path.join(stdout.trim(), `cua-driver-permissions-${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(resultFile, '', { mode: 0o600 });
  try {
    await execFileAsync('open', ['-n', '-W', '-g', layout.app, '--args', '__permissions-host-request', '--result-file', resultFile], {
      timeout: PERMISSION_REQUEST_TIMEOUT_MS,
    });
    const text = fs.readFileSync(resultFile, 'utf8').trim();
    if (!text) throw new Error("Cua Driver didn't answer the permission request.");
    const grants = decodeBoundary(decodeBoundary(JSON.parse(text), toolResultSchema).structuredContent ?? {}, grantsSchema);
    return { accessibility: grants.accessibility === true, screenRecording: grants.screen_recording === true };
  } finally {
    fs.rmSync(resultFile, { force: true });
  }
}

export function createCuaDriverEngine(options: CuaDriverOptions = {}): ComputerUseEngine {
  return new CuaDriverEngine(options);
}

/** One harmless read that proves the helper answers tool calls. It needs no macOS permission, so check status() for those. */
export function selfTest(engine: ComputerUseEngine): Promise<EngineResult> {
  return engine.call('list_apps', {});
}
