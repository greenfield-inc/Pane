import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { CloudUpgradeRequest, CloudUpgradeResult } from '../../../../shared/types/cloudDaemon';
import {
  CLOUD_PANE_PIN_FILE,
  isPinnablePaneVersion,
  MIN_CLOUD_PIN_PANE_VERSION,
  type CloudPanePin,
} from './panePin';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { SYSTEMD_UNIT_NAME } from '../remoteDaemonService';
import type { PaneCommandValue } from '../commandRegistry';

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+~-]{0,63}$/u;
const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9@_.-]+\.service$/u;

export class CloudUpgradeError extends Error {
  constructor(readonly code: string, message: string) {
    // The code leads the message: /invoke forwards only the message to the caller.
    super(`${code}: ${message}`);
    this.name = 'CloudUpgradeError';
  }
}

export interface CloudUpgradeDependencies {
  currentVersion: string;
  /** The pin the laptop wrote into this Session (`readPanePinFile`), or null when there is none. */
  readPin(): CloudPanePin | null;
  /** Where downloaded packages are kept (inside the Pane directory, so snapshots keep them). */
  downloadDirectory: string;
  /** The systemd user unit running this daemon, or null when it runs outside systemd. */
  resolveServiceUnit(): string | null;
  download(url: string, destination: string): Promise<void>;
  /** Runs the install-and-restart script outside this daemon's cgroup, so the restart cannot kill it. */
  runDetached(unitSuffix: string, script: string): Promise<void>;
}

const upgradeRequestSchema = boundary.object({
  version: boundary.nonEmptyString,
  url: boundary.optional(boundary.string),
  debUrl: boundary.optional(boundary.string),
  sha256: boundary.nonEmptyString,
});

export function parseCloudUpgradeRequest(value: PaneCommandValue): CloudUpgradeRequest {
  let decoded: ReturnType<typeof upgradeRequestSchema.decode>;
  try {
    decoded = decodeBoundary(value, upgradeRequestSchema);
  } catch (error) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_BAD_REQUEST', `Invalid upgrade request: ${error instanceof Error ? error.message : String(error)}`);
  }
  const url = decoded.url ?? decoded.debUrl;
  if (!url || !url.startsWith('https://')) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_BAD_REQUEST', 'An https:// package url is required');
  }
  const sha256 = decoded.sha256.toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_BAD_REQUEST', 'sha256 must be 64 hex characters');
  }
  if (!VERSION_PATTERN.test(decoded.version)) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_BAD_REQUEST', 'version has unexpected characters');
  }
  return { version: decoded.version, url, sha256 };
}

/**
 * The Session's pin, written by the laptop CLI as root (`rp-bootstrap.sh pin-pane`). Null when none was
 * written. A pin this daemon's user could have written is refused: the daemon would install it as root.
 */
export function readPanePinFile(
  file: string = CLOUD_PANE_PIN_FILE,
  statFile: (file: string) => { uid: number; mode: number } = fs.statSync,
): CloudPanePin | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (decodeOptionalBoundary(error, boundary.object({ code: boundary.literal('ENOENT') }))) return null;
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_PIN_INVALID', `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const stat = statFile(file);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_PIN_UNSAFE', `${file} must be owned by root and writable only by root`);
  }
  try {
    return parseCloudUpgradeRequest(JSON.parse(text));
  } catch (error) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_PIN_INVALID', `${file} is not a valid pin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function samePin(request: CloudUpgradeRequest, pin: CloudPanePin): boolean {
  return request.version === pin.version && request.url === pin.url && request.sha256 === pin.sha256;
}

/**
 * Upgrade-on-wake: headless daemons never update themselves (bootstrap only runs the version
 * checker on the desktop), so after a wake the coordinator asks the daemon to install the pinned
 * .deb. The Session, not the caller, decides what that is: only a request equal to the pin the
 * laptop wrote into the Session (`readPin`) is installed, and never a pin older than the first Pane
 * that enforces client scopes. The package is verified against the pin's sha256, then a detached job
 * installs it with `sudo -n apt-get` and restarts this daemon's systemd unit. The caller polls
 * `/health` until `version` matches.
 */
export async function runCloudUpgrade(
  dependencies: CloudUpgradeDependencies,
  rawRequest: PaneCommandValue,
): Promise<CloudUpgradeResult> {
  const request = parseCloudUpgradeRequest(rawRequest);
  const from = dependencies.currentVersion;
  if (request.version === from) {
    return { ok: true, upgraded: false, from, to: request.version };
  }
  const pin = dependencies.readPin();
  if (!pin || !samePin(request, pin)) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_NOT_PINNED', pin
      ? `This Session is pinned to ${pin.version} (${pin.url}); the request does not match the pin`
      : 'This Session has no pinned Pane version; pin one from the laptop (runpane cloud coordinator deploy --pin-version ...)');
  }
  if (!isPinnablePaneVersion(pin.version)) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_TOO_OLD', `Pane ${pin.version} is older than ${MIN_CLOUD_PIN_PANE_VERSION}, the first Pane that enforces client scopes`);
  }
  if (process.platform !== 'linux') {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_UNSUPPORTED', 'Upgrade on wake installs a .deb and only runs on Linux');
  }
  const unit = dependencies.resolveServiceUnit();
  if (!unit) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_NO_SERVICE', 'This daemon does not run under a systemd user unit, so it cannot restart itself');
  }

  fs.mkdirSync(dependencies.downloadDirectory, { recursive: true, mode: 0o700 });
  const packagePath = path.join(dependencies.downloadDirectory, `pane-${request.version}.deb`);
  const partialPath = `${packagePath}.partial`;
  await dependencies.download(request.url, partialPath);
  const actual = await sha256File(partialPath);
  if (actual !== request.sha256) {
    fs.rmSync(partialPath, { force: true });
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_CHECKSUM', `Package sha256 ${actual} does not match ${request.sha256}`);
  }
  fs.renameSync(partialPath, packagePath);

  await dependencies.runDetached(request.version.replace(/[^A-Za-z0-9]/gu, '-'), buildUpgradeScript(packagePath, unit));
  return { ok: true, upgraded: 'scheduled', from, to: request.version, packagePath };
}

export function buildUpgradeScript(packagePath: string, unit: string): string {
  const deb = shellQuote(packagePath);
  return [
    'set -e',
    // Let the invoke response reach the caller before the daemon goes down.
    'sleep 1',
    // Downgrades are allowed only to a pin, and a pin is never older than MIN_CLOUD_PIN_PANE_VERSION.
    `sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades ${deb} || sudo -n dpkg -i ${deb}`,
    `systemctl --user restart ${shellQuote(unit)}`,
  ].join('\n');
}

/** The `*.service` this process runs in, from its cgroup path (cgroup v2 and v1). */
export function resolveSystemdUnitFromCgroup(cgroupText: string): string | null {
  for (const line of cgroupText.split('\n')) {
    const cgroupPath = line.split(':').slice(2).join(':');
    const segments = cgroupPath.split('/').reverse();
    const unit = segments.find(segment => SYSTEMD_UNIT_PATTERN.test(segment) && !segment.startsWith('user@'));
    if (unit) return unit;
  }
  return null;
}

/**
 * The systemd user unit whose main process is this daemon. Electron moves itself into an
 * `app-*.scope` cgroup on start, so the cgroup often names a scope, not the service; then the
 * managed daemon unit counts when systemd reports this process as its MainPID.
 */
export function resolveOwnSystemdUnit(
  readCgroup: () => string = () => fs.readFileSync('/proc/self/cgroup', 'utf8'),
  mainPidOf: (unit: string) => number | undefined = readUnitMainPid,
  pid: number = process.pid,
): string | null {
  try {
    const fromCgroup = resolveSystemdUnitFromCgroup(readCgroup());
    if (fromCgroup) return fromCgroup;
  } catch {
    // No /proc: fall through to asking systemd.
  }
  return mainPidOf(SYSTEMD_UNIT_NAME) === pid ? SYSTEMD_UNIT_NAME : null;
}

function readUnitMainPid(unit: string): number | undefined {
  const result = spawnSync('systemctl', ['--user', 'show', '--property=MainPID', '--value', unit], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const pid = Number(result.stdout?.trim());
  return result.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Streams the package to a 0600 file: a Pane .deb is 100+ MB, more than the daemon should hold in memory. */
export async function downloadToFile(url: string, destination: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_DOWNLOAD', `Download failed with HTTP ${response.status}`);
  }
  await pipeline(Readable.from(readResponseBody(response.body)), fs.createWriteStream(destination, { mode: 0o600 }));
}

async function* readResponseBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function runDetachedWithSystemd(unitSuffix: string, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('systemd-run', [
      '--user',
      '--collect',
      `--unit=pane-cloud-upgrade-${unitSuffix}-${Date.now()}`,
      'bash',
      '-c',
      script,
    ], { stdio: 'ignore' });
    child.on('error', error => reject(new CloudUpgradeError('ERR_CLOUD_UPGRADE_SPAWN', error.message)));
    child.on('close', code => (code === 0
      ? resolve()
      : reject(new CloudUpgradeError('ERR_CLOUD_UPGRADE_SPAWN', `systemd-run exited with ${code}`))));
  });
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
