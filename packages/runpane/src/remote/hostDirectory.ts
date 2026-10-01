import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary, type BoundarySchema } from '../boundaryDecoder';
import type { RemoteHostProfile } from './remoteDaemonClient';

/** Where a saved profile's cloud Session lives. Written by `runpane cloud` (single writer). */
interface CloudHostRef {
  provider: string;
  sandboxId: string;
  sessionId: string;
  hostname?: string;
  nodeId?: string;
  version?: number;
}

export interface CoordinatorRef {
  baseUrl: string;
  token: string;
}

interface DirectoryHost extends RemoteHostProfile {
  cloud?: CloudHostRef;
}

/** A resolved `--host` / `--thread` target. */
export interface DaemonTarget {
  host: DirectoryHost;
  /** Present when the host came from a directory file that names a coordinator. */
  coordinator?: CoordinatorRef;
  /** Where the target was found, for error messages. */
  source: string;
}

interface HostDirectory {
  coordinator?: CoordinatorRef;
  hosts: DirectoryHost[];
}

const PAIRING_PREFIX = 'pane-remote://';

const cloudRefSchema: BoundarySchema<CloudHostRef> = boundary.object({
  provider: boundary.nonEmptyString,
  sandboxId: boundary.nonEmptyString,
  sessionId: boundary.nonEmptyString,
  hostname: boundary.optional(boundary.string),
  nodeId: boundary.optional(boundary.string),
  version: boundary.optional(boundary.number),
});

const directoryHostSchema = boundary.object({
  id: boundary.nonEmptyString,
  label: boundary.nonEmptyString,
  baseUrl: boundary.nonEmptyString,
  token: boundary.nonEmptyString,
  cloud: boundary.optional(cloudRefSchema),
});

const coordinatorSchema: BoundarySchema<CoordinatorRef> = boundary.object({
  baseUrl: boundary.nonEmptyString,
  token: boundary.nonEmptyString,
});

const directoryFileSchema = boundary.object({
  v: boundary.literal(1),
  coordinator: boundary.optional(coordinatorSchema),
  hosts: boundary.array(boundary.jsonObject),
});

const hostRecordSchema = boundary.object({
  profile: boundary.jsonObject,
});

const pairingPayloadSchema = boundary.object({
  label: boundary.nonEmptyString,
  baseUrl: boundary.nonEmptyString,
  token: boundary.nonEmptyString,
});

const desktopConfigSchema = boundary.object({
  remoteDaemon: boundary.optional(boundary.object({
    client: boundary.optional(boundary.object({
      profiles: boundary.optional(boundary.array(boundary.jsonObject)),
    })),
  })),
});

export interface ResolveTargetOptions {
  env?: NodeJS.ProcessEnv;
  paneDir?: string;
  /** `--thread` only matches cloud hosts. */
  cloudOnly?: boolean;
}

function cloudDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUNPANE_CLOUD_DIR?.trim() || path.join(os.homedir(), '.config', 'runpane-cloud');
}

/** The peers list the coordinator pushes into a cloud Session's sandbox. */
function peersFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUNPANE_PEERS_FILE?.trim() || path.join(cloudDirectory(env), 'peers.json');
}

/**
 * Inside a cloud Session: the coordinator and this Session's own caller token, from the peers list
 * `runpane cloud` writes there (0600). Null when this machine has no peers list or it names none.
 */
export function readSessionCoordinator(env: NodeJS.ProcessEnv = process.env): { coordinator: CoordinatorRef; source: string } | null {
  const source = peersFilePath(env);
  const directory = readDirectoryFile(source);
  return directory?.coordinator ? { coordinator: directory.coordinator, source } : null;
}

/**
 * Resolves `--host`/`--thread` to a daemon profile. Every run re-reads the
 * files, so a coordinator re-push after a re-enrol takes effect at once.
 */
export function resolveDaemonTarget(selector: string, options: ResolveTargetOptions = {}): DaemonTarget {
  const env = options.env ?? process.env;
  const wanted = selector.trim();
  if (!wanted) {
    throw new Error('--host needs a value: a saved host name, a cloud Session id, or a pane-remote:// code.');
  }

  if (!options.cloudOnly) {
    const pairing = readPairingSelector(wanted);
    if (pairing) {
      return { host: pairing, source: wanted.startsWith(PAIRING_PREFIX) ? 'connection code' : wanted };
    }
  }

  const searched: string[] = [];
  for (const [source, directory] of loadDirectories(env)) {
    searched.push(source);
    const host = findHost(directory.hosts, wanted, options.cloudOnly ?? false);
    if (host) {
      return directory.coordinator
        ? { host, coordinator: directory.coordinator, source }
        : { host, source };
    }
  }

  if (!options.cloudOnly) {
    const configPath = path.join(options.paneDir ?? env.PANE_DIR ?? path.join(os.homedir(), '.pane'), 'config.json');
    const profiles = readDesktopProfiles(configPath);
    if (profiles) {
      searched.push(configPath);
      const host = findHost(profiles, wanted, false);
      if (host) return { host, source: configPath };
    }
  }

  const where = searched.length > 0 ? searched.join(', ') : 'no host directory files were found';
  const kind = options.cloudOnly ? 'cloud Session' : 'host';
  throw new Error(`No ${kind} named "${wanted}" (searched: ${where}).`);
}

/**
 * The directories in lookup order: the peers list (inside a sandbox), then the
 * user's `runpane cloud` host records (`hosts/<hostname>.json`, one profile each)
 * with the coordinator from `coordinator.json`.
 */
function loadDirectories(env: NodeJS.ProcessEnv): Array<[string, HostDirectory]> {
  const directories: Array<[string, HostDirectory]> = [];
  const peersPath = peersFilePath(env);
  const peers = readDirectoryFile(peersPath);
  if (peers) directories.push([peersPath, peers]);

  const hostsDir = path.join(cloudDirectory(env), 'hosts');
  const hosts = readHostRecords(hostsDir);
  if (hosts.length > 0) {
    const coordinator = readCoordinatorFile(path.join(cloudDirectory(env), 'coordinator.json'));
    directories.push([hostsDir, coordinator ? { hosts, coordinator } : { hosts }]);
  }
  return directories;
}

function readHostRecords(hostsDir: string): DirectoryHost[] {
  let names: string[];
  try {
    names = fs.readdirSync(hostsDir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const profiles: unknown[] = [];
  for (const name of names) {
    try {
      const record = decodeBoundary(JSON.parse(readTextFile(path.join(hostsDir, name)) ?? 'null'), hostRecordSchema);
      profiles.push(record.profile);
    } catch {
      continue;
    }
  }
  return decodeHosts(profiles);
}

function readCoordinatorFile(filePath: string): CoordinatorRef | null {
  const raw = readTextFile(filePath);
  if (raw === null) return null;
  try {
    return decodeBoundary(JSON.parse(raw), coordinatorSchema);
  } catch (error) {
    throw new Error(`Coordinator file ${filePath} is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readDirectoryFile(filePath: string): HostDirectory | null {
  const raw = readTextFile(filePath);
  if (raw === null) return null;
  let decoded;
  try {
    decoded = decodeBoundary(JSON.parse(raw), directoryFileSchema);
  } catch (error) {
    throw new Error(`Host directory ${filePath} is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const directory: HostDirectory = { hosts: decodeHosts(decoded.hosts) };
  if (decoded.coordinator) directory.coordinator = decoded.coordinator;
  return directory;
}

function readDesktopProfiles(configPath: string): DirectoryHost[] | null {
  const raw = readTextFile(configPath);
  if (raw === null) return null;
  try {
    const config = decodeBoundary(JSON.parse(raw), desktopConfigSchema);
    return decodeHosts(config.remoteDaemon?.client?.profiles ?? []);
  } catch {
    // A desktop config we cannot read is not a host directory; skip it.
    return null;
  }
}

/** Skips entries that are not usable profiles instead of failing the whole file. */
function decodeHosts(entries: unknown[]): DirectoryHost[] {
  const hosts: DirectoryHost[] = [];
  for (const entry of entries) {
    try {
      const decoded = decodeBoundary(entry, directoryHostSchema);
      const host: DirectoryHost = { id: decoded.id, label: decoded.label, baseUrl: decoded.baseUrl, token: decoded.token };
      if (decoded.cloud) host.cloud = decoded.cloud;
      hosts.push(host);
    } catch {
      continue;
    }
  }
  return hosts;
}

function findHost(hosts: DirectoryHost[], wanted: string, cloudOnly: boolean): DirectoryHost | undefined {
  const candidates = cloudOnly ? hosts.filter((host) => host.cloud) : hosts;
  const lower = wanted.toLowerCase();
  return candidates.find((host) => host.id === wanted || host.cloud?.sessionId === wanted)
    ?? candidates.find((host) => host.label.toLowerCase() === lower || host.cloud?.hostname?.toLowerCase() === lower)
    ?? candidates.find((host) => urlHostMatches(host.baseUrl, lower));
}

function urlHostMatches(baseUrl: string, wanted: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === wanted || hostname.split('.')[0] === wanted;
  } catch {
    return false;
  }
}

/** A literal pane-remote:// code, or a file (such as a 0600 pairing file) holding one. */
function readPairingSelector(selector: string): DirectoryHost | null {
  if (selector.startsWith(PAIRING_PREFIX)) {
    return decodePairingCode(selector);
  }
  if (!selector.includes('/') && !selector.includes(path.sep)) return null;
  const raw = readTextFile(selector);
  if (raw === null || !raw.trim().startsWith(PAIRING_PREFIX)) return null;
  return decodePairingCode(raw.trim());
}

function decodePairingCode(code: string): DirectoryHost {
  const encoded = code.trim().slice(PAIRING_PREFIX.length);
  if (!encoded) throw new Error('The pane-remote:// connection code is empty.');
  let payload;
  try {
    const json = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    payload = decodeBoundary(JSON.parse(json), pairingPayloadSchema);
  } catch {
    throw new Error('The pane-remote:// connection code is not valid.');
  }
  const baseUrl = payload.baseUrl.trim().replace(/\/+$/, '');
  return {
    id: `${payload.label}:${baseUrl}:${payload.token.slice(-8)}`,
    label: payload.label,
    baseUrl,
    token: payload.token.trim(),
  };
}

function readTextFile(filePath: string): string | null {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  return stat?.isFile() ? fs.readFileSync(filePath, 'utf8') : null;
}
