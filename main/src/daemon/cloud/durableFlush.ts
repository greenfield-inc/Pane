import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { CloudDurableFlushResult, CloudWalCheckpoint } from '../../../../shared/types/cloudDaemon';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

const SYNC_TIMEOUT_MS = 30_000;

/** `not-installed`: no tailnet-state guard on this machine (not a cloud sandbox), so nothing to back up. */
export type TailnetStateBackup = 'backed-up' | 'not-installed' | 'failed';

export interface DurableFlushDependencies {
  /** Folds the SQLite WAL into the main database file. */
  checkpointWal(): CloudWalCheckpoint | null;
  /** The Pane directory: config and the JSON stores live at its top level, usually sessions.db too. */
  paneDirectory: string;
  /** The SQLite database file; it and its `-wal` file are fsynced wherever they live. */
  databaseFile: string;
  /** Flushes the whole filesystem holding `directory` (worktrees, agent transcripts). */
  syncFilesystem?(directory: string): Promise<boolean>;
  /**
   * Refreshes the in-place copy of tailscaled.state that cloud bootstrap keeps (rp-tailscale-state):
   * a resume can lose the state file itself, and a logged-out node can't be reached to repair it.
   */
  backupTailnetState?(): Promise<TailnetStateBackup>;
  now?: () => number;
}

/** Installed by runpane cloud bootstrap on cloud sandboxes; absent anywhere else. */
const TAILNET_STATE_GUARD = '/usr/local/sbin/rp-tailscale-state';

/**
 * Makes everything the daemon has written durable on disk: checkpoint the WAL, fsync the database,
 * its WAL, every file at the top of the Pane directory and the directory itself, then sync the filesystem.
 * `synchronous = NORMAL` leaves WAL commits unsynced until a checkpoint, so a power-off right
 * after the last commit can drop it; this closes that window before a planned stop.
 *
 * Every step runs even after one fails (a stop the user forces still gets what could be flushed),
 * but `durable` is true only when all of them succeeded; `failures` says what did not. A busy
 * checkpoint still counts: the frames a reader held stay in the `-wal` file, which is fsynced.
 */
export async function flushDurableState(dependencies: DurableFlushDependencies): Promise<CloudDurableFlushResult> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const failures: string[] = [];

  let walCheckpoint: CloudWalCheckpoint | null = null;
  try {
    walCheckpoint = dependencies.checkpointWal();
    if (!walCheckpoint) failures.push('the SQLite WAL was not checkpointed');
  } catch (error) {
    failures.push(`WAL checkpoint failed: ${describeError(error)}`);
  }

  const databaseFile = dependencies.databaseFile;
  const walFile = `${databaseFile}-wal`;
  // A missing WAL is fine once the checkpoint folded it in; frames a reader held must be on disk.
  const requiredFiles = new Set([databaseFile]);
  if (walCheckpoint === null || walCheckpoint.busy > 0) requiredFiles.add(walFile);

  const fsynced: string[] = [];
  const topLevelFiles = listTopLevelFiles(dependencies.paneDirectory, failures);
  for (const entry of [...new Set([...topLevelFiles, databaseFile, walFile])].sort()) {
    const outcome = fsyncPath(entry);
    if (outcome === 'synced') fsynced.push(entry);
    else if (outcome === 'missing') {
      // A top-level file removed since the listing is not a failure; the database is.
      if (requiredFiles.has(entry)) failures.push(`${entry} is missing`);
    } else failures.push(`fsync ${entry} failed: ${outcome.error}`);
  }
  const directoryOutcome = fsyncPath(dependencies.paneDirectory);
  if (directoryOutcome === 'synced') fsynced.push(dependencies.paneDirectory);
  else failures.push(`fsync ${dependencies.paneDirectory} failed: ${directoryOutcome === 'missing' ? 'missing' : directoryOutcome.error}`);

  if (await (dependencies.backupTailnetState ?? backupTailnetStateWithGuard)() === 'failed') {
    failures.push('backing up the tailscaled state failed');
  }

  const syncFilesystem = dependencies.syncFilesystem ?? syncFilesystemWithCoreutils;
  const syncedFilesystem = await syncFilesystem(dependencies.paneDirectory);
  if (!syncedFilesystem) failures.push(`syncing the filesystem holding ${dependencies.paneDirectory} failed`);

  return { walCheckpoint, fsynced, syncedFilesystem, durable: failures.length === 0, failures, durationMs: now() - startedAt };
}

function listTopLevelFiles(directory: string, failures: string[]): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join(directory, entry.name));
  } catch (error) {
    failures.push(`listing ${directory} failed: ${describeError(error)}`);
    return [];
  }
}

function fsyncPath(target: string): 'synced' | 'missing' | { error: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, 'r');
    fs.fsyncSync(fd);
    return 'synced';
  } catch (error) {
    return decodeOptionalBoundary(error, boundary.object({ code: boundary.literal('ENOENT') }))
      ? 'missing'
      : { error: describeError(error) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The guard is root-owned, so it runs through passwordless sudo, as upgrades do. */
function backupTailnetStateWithGuard(): Promise<TailnetStateBackup> {
  if (process.platform !== 'linux' || !fs.existsSync(TAILNET_STATE_GUARD)) return Promise.resolve('not-installed');
  return new Promise(resolve => {
    execFile('sudo', ['-n', TAILNET_STATE_GUARD, 'backup'], { timeout: SYNC_TIMEOUT_MS }, error => resolve(error ? 'failed' : 'backed-up'));
  });
}

/** `sync -f` syncs the one filesystem (syncfs); older coreutils fall back to a full `sync`. */
function syncFilesystemWithCoreutils(directory: string): Promise<boolean> {
  if (process.platform === 'win32') return Promise.resolve(false);
  return runSync(['-f', directory]).then(ok => ok || runSync([]));
}

function runSync(args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    execFile('sync', args, { timeout: SYNC_TIMEOUT_MS }, error => resolve(!error));
  });
}
