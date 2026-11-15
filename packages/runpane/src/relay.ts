import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { downloadToFile, parseChecksum } from './download';
import { RunpaneError } from './errors';
import { runForwardingSignals } from './forwardedChild';
import { detectPlatform } from './platform';
import { runRelayInit } from './relayInit';
import { getWrapperVersion } from './version';

const SELF_HOSTED_RELAY_DOCS = 'https://github.com/greenfield-inc/Pane/blob/main/docs/SELF_HOSTED_RELAY.md';
/** The release asset listing every pane-relay binary's SHA-256, written by .github/workflows/build.yml. */
const CHECKSUMS_ASSET = 'pane-relay-sha256.txt';

/**
 * `runpane relay [pane-relay flags...]` runs this platform's prebuilt `pane-relay`: the one npm
 * installed as runpane's optional dependency `@pane/relay-<platform>-<arch>`, or else the one
 * the GitHub release for runpane's version carries, downloaded once, checked against the release's
 * SHA-256 list and cached. Flags, stdio, signals and the exit code pass through unchanged.
 * `runpane relay init` prints and checks what a new relay needs (relayInit.ts).
 */
export async function runRelay(args: string[]): Promise<number> {
  if (args[0] === 'init') return runRelayInit(args.slice(1));
  const binary = installedBinary() ?? await downloadedBinary();
  const ended = await runForwardingSignals(binary, args);
  if ('error' in ended) {
    throw new RunpaneError(
      'ERR_RELAY_START_FAILED',
      `runpane relay could not start ${binary} (${ended.error}). Nothing was started.`,
      installedBinary() === binary
        ? `Reinstall runpane so npm writes the relay binary again (npm install -g runpane@latest), or run the container: ${SELF_HOSTED_RELAY_DOCS}`
        : `Delete ${binary} so runpane downloads it again, or run the container: ${SELF_HOSTED_RELAY_DOCS}`,
    );
  }
  if (ended.signal) process.kill(process.pid, ended.signal);
  return ended.status ?? 1;
}

const platform = () => `${process.platform}-${process.arch}`;
const binaryName = () => (process.platform === 'win32' ? 'pane-relay.exe' : 'pane-relay');

function installedBinary(): string | null {
  try {
    const manifest = createRequire(__filename).resolve(`@pane/relay-${platform()}/package.json`);
    return path.join(path.dirname(manifest), 'bin', binaryName());
  } catch {
    return null;
  }
}

/** The release's binary for this platform, from the cache or downloaded and verified into it. */
async function downloadedBinary(): Promise<string> {
  const version = getWrapperVersion();
  try {
    detectPlatform();
  } catch {
    throw new RunpaneError(
      'ERR_RELAY_UNSUPPORTED_PLATFORM',
      `runpane relay has no prebuilt pane-relay for ${process.platform} ${process.arch}. Nothing was started.`,
      `Run the container image ghcr.io/greenfield-inc/pane-relay, or build pane-relay from relay/: ${SELF_HOSTED_RELAY_DOCS}`,
    );
  }
  const cached = path.join(cacheRoot(), 'runpane', 'relay', version, binaryName());
  if (fs.existsSync(cached)) return cached;

  const asset = `pane-relay-${platform()}${process.platform === 'win32' ? '.exe' : ''}`;
  const base = (process.env.RUNPANE_RELAY_RELEASE_URL ?? `https://github.com/greenfield-inc/Pane/releases/download/v${version}`).replace(/\/+$/u, '');
  const unavailable = (why: string) => new RunpaneError(
    'ERR_RELAY_DOWNLOAD_FAILED',
    `runpane relay could not download pane-relay ${version} for ${process.platform} ${process.arch} from ${base}: ${why}. Nothing was started or saved.`,
    `Check your connection and run it again, use the latest release with npx --yes runpane@latest relay, or run the container image ghcr.io/greenfield-inc/pane-relay: ${SELF_HOSTED_RELAY_DOCS}`,
  );

  // Both files land beside the final name; only a verified binary is renamed onto it.
  const partial = `${cached}.${process.pid}.partial`;
  const sumsFile = `${partial}.sha256`;
  try {
    try {
      fs.mkdirSync(path.dirname(cached), { recursive: true });
    } catch (cause) {
      throw cacheUnwritable(path.dirname(cached), cause);
    }
    await downloadToFile(`${base}/${CHECKSUMS_ASSET}`, sumsFile, false).catch((cause: unknown) => { throw unavailable(`${CHECKSUMS_ASSET}: ${reasonOf(cause)}`); });
    const expected = parseChecksum(fs.readFileSync(sumsFile, 'utf8'), asset)?.toLowerCase();
    if (!expected) throw unavailable(`${CHECKSUMS_ASSET} lists no ${asset}`);

    process.stderr.write(`runpane relay: downloading pane-relay ${version} for ${process.platform} ${process.arch} from ${base}/${asset}\n`);
    await downloadToFile(`${base}/${asset}`, partial, false).catch((cause: unknown) => {
      throw isFileError(cause) ? cacheUnwritable(path.dirname(cached), cause) : unavailable(`${asset}: ${reasonOf(cause)}`);
    });
    const actual = createHash('sha256').update(fs.readFileSync(partial)).digest('hex');
    if (actual !== expected) {
      throw new RunpaneError(
        'ERR_RELAY_CHECKSUM_MISMATCH',
        `runpane relay downloaded ${base}/${asset}, but its SHA-256 is ${actual} and ${CHECKSUMS_ASSET} lists ${expected}. Nothing was saved or run.`,
        `Run it again; if it still differs, report it at https://github.com/greenfield-inc/Pane/issues and use the container image ghcr.io/greenfield-inc/pane-relay meanwhile.`,
      );
    }
    try {
      fs.chmodSync(partial, 0o755);
      fs.renameSync(partial, cached);
    } catch (cause) {
      throw cacheUnwritable(path.dirname(cached), cause);
    }
  } finally {
    fs.rmSync(partial, { force: true });
    fs.rmSync(sumsFile, { force: true });
  }
  process.stderr.write(`runpane relay: SHA-256 matches the release; saved ${cached}\n`);
  return cached;
}

function isFileError(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT'].includes(String(cause.code));
}

function cacheUnwritable(folder: string, cause: unknown): RunpaneError {
  return new RunpaneError(
    'ERR_RELAY_CACHE_UNWRITABLE',
    `runpane relay could not save pane-relay in ${folder} (${reasonOf(cause)}). Nothing was saved or run.`,
    'Free some disk space or fix that folder\'s permissions, or set XDG_CACHE_HOME to a folder you can write, and run it again.',
  );
}

function cacheRoot(): string {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return path.join(os.homedir(), '.cache');
}


function reasonOf(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const detail = cause.cause instanceof Error ? ` (${cause.cause.message})` : '';
  return `${cause.message}${detail}`;
}
