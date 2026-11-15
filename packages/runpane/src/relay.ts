import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { RunpaneError } from './errors';
import { runForwardingSignals } from './forwardedChild';
import { runRelayInit } from './relayInit';
import { getWrapperVersion } from './version';

const SELF_HOSTED_RELAY_DOCS = 'https://github.com/greenfield-inc/Pane/blob/main/docs/SELF_HOSTED_RELAY.md';
/** Platforms each release builds pane-relay for (scripts/runpane-relay-packages.js TARGETS). */
const RELEASED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
/** The release asset listing every pane-relay binary's SHA-256, written by .github/workflows/build.yml. */
const CHECKSUMS_ASSET = 'pane-relay-sha256.txt';

/**
 * `runpane relay [pane-relay flags...]` runs this platform's prebuilt `pane-relay`: the one npm
 * installed as runpane's optional dependency `@runpane/relay-<platform>-<arch>`, or else the one
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
      `Delete ${binary} so runpane downloads it again, or run the container: ${SELF_HOSTED_RELAY_DOCS}`,
    );
  }
  if (ended.signal) process.kill(process.pid, ended.signal);
  return ended.status ?? 1;
}

const platform = () => `${process.platform}-${process.arch}`;
const binaryName = () => (process.platform === 'win32' ? 'pane-relay.exe' : 'pane-relay');

function installedBinary(): string | null {
  try {
    const manifest = createRequire(__filename).resolve(`@runpane/relay-${platform()}/package.json`);
    return path.join(path.dirname(manifest), 'bin', binaryName());
  } catch {
    return null;
  }
}

/** The release's binary for this platform, from the cache or downloaded and verified into it. */
async function downloadedBinary(): Promise<string> {
  const version = getWrapperVersion();
  if (!RELEASED_PLATFORMS.includes(platform())) {
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

  const sums = await fetchBytes(`${base}/${CHECKSUMS_ASSET}`).catch((cause: unknown) => { throw unavailable(`${CHECKSUMS_ASSET}: ${reasonOf(cause)}`); });
  const expected = sums.toString('utf8').split(/\r?\n/u)
    .map((line) => /^([0-9a-f]{64})\s+\*?(\S+)$/iu.exec(line.trim()))
    .find((match) => match?.[2] === asset)?.[1].toLowerCase();
  if (!expected) throw unavailable(`${CHECKSUMS_ASSET} lists no ${asset}`);

  process.stderr.write(`runpane relay: downloading pane-relay ${version} for ${process.platform} ${process.arch} from ${base}/${asset}\n`);
  const binary = await fetchBytes(`${base}/${asset}`).catch((cause: unknown) => { throw unavailable(`${asset}: ${reasonOf(cause)}`); });
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) {
    throw new RunpaneError(
      'ERR_RELAY_CHECKSUM_MISMATCH',
      `runpane relay downloaded ${base}/${asset}, but its SHA-256 is ${actual} and ${CHECKSUMS_ASSET} lists ${expected}. It was deleted without running.`,
      `Run it again; if it still differs, report it at https://github.com/greenfield-inc/Pane/issues and use the container image ghcr.io/greenfield-inc/pane-relay meanwhile.`,
    );
  }
  // Written beside its final name and renamed, so a cached binary is always a complete, verified one.
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  fs.writeFileSync(partial, binary, { mode: 0o755 });
  fs.renameSync(partial, cached);
  process.stderr.write(`runpane relay: SHA-256 matches the release; saved ${cached}\n`);
  return cached;
}

function cacheRoot(): string {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return path.join(os.homedir(), '.cache');
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'runpane-relay' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function reasonOf(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const detail = cause.cause instanceof Error ? ` (${cause.cause.message})` : '';
  return `${cause.message}${detail}`;
}
