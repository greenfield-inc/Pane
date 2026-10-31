import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { RunpaneError } from './errors';

// Electron virtualizes app.asar as a directory. Capacity and snapshots concern
// physical files; the staged standalone Node helper has these semantics too.
// SAFETY: Electron's built-in original-fs exposes the unchanged Node fs API.
const fs: typeof nodeFs = process.versions.electron
  ? createRequire(__filename)('original-fs') as typeof nodeFs
  : nodeFs;

/**
 * Top-level folders of Pane data that hold Pane's own state. The recovery
 * snapshot copies these and every top-level file (config, databases, journals).
 */
export const PANE_STATE_FOLDERS = [
  'agent-chat', 'artifacts', 'images', 'logs', 'mcp', 'migrate-to-pane', 'notes',
  'prompts', 'remote-daemon', 'sessions', 'skills', 'uploads',
] as const;

/** Top-level folders Pane writes that the snapshot leaves out. */
export const PANE_UNSNAPSHOTTED_FOLDERS = [
  // Rebuilt by Pane at startup or on demand.
  '.claude', '.codex', '.cursor', 'agent-adapters', 'bin', 'claude-prompts', 'shell', 'tools',
  // Live IPC endpoints, and the update operations themselves.
  'sockets', 'updates',
  // Repositories Pane clones for the person; no update migrates them.
  'projects',
] as const;

const stateFolders = new Set<string>(PANE_STATE_FOLDERS);
const knownFolders = new Set<string>([...PANE_STATE_FOLDERS, ...PANE_UNSNAPSHOTTED_FOLDERS]);

/** .git is a folder in a clone and a file in a worktree. */
function isCheckout(directory: string): boolean {
  return fs.existsSync(path.join(directory, '.git'));
}

function inUpdateSnapshot(file: string): boolean {
  if (path.basename(file).startsWith('Singleton')) return false;
  const stat = fs.lstatSync(file);
  if (stat.isSocket()) return false;
  return !stat.isDirectory() || !isCheckout(file);
}

/**
 * What the snapshot takes from `source`. Pane data keeps only top-level files
 * and Pane's state folders: anything else there (a repository, someone's
 * backups) is not Pane's, and opening every file of it kept preflight silent
 * for minutes behind antivirus scans. The Electron profile is copied whole.
 */
function snapshotEntries(source: string, paneData: boolean): string[] {
  return fs.readdirSync(source).map(entry => path.join(source, entry)).filter(file =>
    inUpdateSnapshot(file) && (!paneData || !fs.lstatSync(file).isDirectory() || stateFolders.has(path.basename(file))));
}

/** Folders in Pane data the snapshot skips that Pane does not know, and repositories inside its state folders. */
export function updateSnapshotSkips(paneDir: string): string[] {
  const skipped: string[] = [];
  const findCheckouts = (directory: string) => {
    for (const entry of fs.readdirSync(directory)) {
      const file = path.join(directory, entry);
      if (!fs.lstatSync(file).isDirectory()) continue;
      if (isCheckout(file)) skipped.push(file);
      else findCheckouts(file);
    }
  };
  for (const entry of fs.readdirSync(paneDir)) {
    const file = path.join(paneDir, entry);
    if (!fs.lstatSync(file).isDirectory()) continue;
    if (!knownFolders.has(entry)) skipped.push(file);
    else if (stateFolders.has(entry)) findCheckouts(file);
  }
  return skipped;
}

/** Copy the snapshot of `source` into `target`; `paneData` selects Pane data's rule over the profile's. */
export function copyUpdateSnapshot(source: string, target: string, paneData: boolean): void {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of snapshotEntries(source, paneData)) {
    fs.cpSync(file, path.join(target, path.basename(file)), { recursive: true, verbatimSymlinks: true, filter: inUpdateSnapshot });
  }
}

/** Live Chromium files may be exclusively locked until clean shutdown on Windows. */
function filesBytes(files: string[], liveProfile: boolean): number {
  let total = 0;
  for (const file of files) {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) total += filesBytes(fs.readdirSync(file).map(entry => path.join(file, entry)).filter(inUpdateSnapshot), liveProfile);
    else if (stat.isSymbolicLink()) { fs.readlinkSync(file); total += stat.size; }
    else if (stat.isFile()) {
      try { const fd = fs.openSync(file, 'r'); fs.closeSync(fd); }
      catch (error) {
        // A sharing violation is not an ACL denial. Count the physical size
        // now; the post-quiescence snapshot must read/copy it before install.
        if (!(liveProfile && process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EBUSY')) throw error;
      }
      total += stat.size;
    } else throw new RunpaneError('ERR_UPDATE_SNAPSHOT_ENTRY', `The recovery snapshot cannot copy ${file}. Pane remains running.`, 'Move the unsupported special file outside Pane data and retry.');
  }
  return total;
}

const snapshotSize = (source: string, paneData: boolean, liveProfile = false) => filesBytes(snapshotEntries(source, paneData), liveProfile);

export function assertUpdateCapacity(paneDir: string, host: { paneDir: string; userData: string } | null, install: string, cliPrefix?: string): void {
  const GiB = 1024 ** 3;
  const installBytes = host ? (fs.statSync(install).isDirectory() ? snapshotSize(install, false) : fs.statSync(install).size) : 0;
  const snapshotBytes = host ? snapshotSize(host.paneDir, true) + snapshotSize(host.userData, false, true) : 0;
  const requirements = [
    { directory: paneDir, bytes: snapshotBytes * 1.2 + (host ? installBytes * 3 : 0) + 2 * GiB },
    ...(host ? [{ directory: path.dirname(install), bytes: installBytes * 2 }] : []),
    ...(cliPrefix ? [{ directory: cliPrefix, bytes: GiB }] : []),
  ];
  const volumes = new Map<number, { directory: string; bytes: number }>();
  for (const requirement of requirements) {
    const device = fs.statSync(requirement.directory).dev;
    const prior = volumes.get(device);
    volumes.set(device, { directory: requirement.directory, bytes: (prior?.bytes ?? 0) + requirement.bytes });
  }
  for (const { directory, bytes } of volumes.values()) {
    const disk = fs.statfsSync(directory);
    if (disk.bavail * disk.bsize < bytes) throw new RunpaneError('ERR_UPDATE_DISK_SPACE', `The volume containing ${directory} needs at least ${(bytes / GiB).toFixed(1)} GiB free for staging, replacement and recovery. Pane remains running.`, 'Free space on that volume and retry.');
  }
}
