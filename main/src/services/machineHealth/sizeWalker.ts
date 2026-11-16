import { lstatSync, opendirSync } from 'fs';
import { availableParallelism } from 'os';
import * as path from 'path';
import { isMainThread, parentPort, Worker } from 'worker_threads';
import { PANE_SCRATCH_FOLDER } from '../../../../shared/constants/paneFolders';
import { PaneError } from '../../../../shared/paneError';

/** A folder to size; with `split`, its node_modules and ignored folders are counted apart. */
export interface SizeRequest {
  path: string;
  /** Folders (relative, `/`-separated) whose bytes count as build outputs: git's ignored directories. */
  ignoredDirs?: string[];
}

export interface SizeResult {
  path: string;
  /** Logical bytes of every file under the path (symlinks are not followed). */
  totalBytes: number;
  dependencyBytes: number;
  buildOutputBytes: number;
  scratchBytes: number;
  /** Newest modification time of anything under the path. */
  newestMs: number;
  exists: boolean;
}

const DEPENDENCY_DIRS = new Set(['node_modules', '.pnpm-store', '.venv', 'venv', 'Pods', 'vendor']);

function walk(root: string, request: SizeRequest): SizeResult {
  const result: SizeResult = { path: root, totalBytes: 0, dependencyBytes: 0, buildOutputBytes: 0, scratchBytes: 0, newestMs: 0, exists: true };
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return { ...result, exists: false };
  }
  result.newestMs = rootStat.mtimeMs;
  if (!rootStat.isDirectory()) {
    result.totalBytes = rootStat.size;
    return result;
  }
  const ignored = new Set((request.ignoredDirs ?? []).map(dir => dir.replace(/\/+$/u, '')));
  type Bucket = 'plain' | 'dependency' | 'build' | 'scratch';
  const stack: Array<{ dir: string; rel: string; bucket: Bucket }> = [{ dir: root, rel: '', bucket: 'plain' }];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { dir, rel, bucket } = next;
    let handle;
    try {
      handle = opendirSync(dir);
    } catch {
      continue;
    }
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        const full = path.join(dir, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          let next: Bucket = bucket;
          if (bucket === 'plain') {
            if (childRel === PANE_SCRATCH_FOLDER) next = 'scratch';
            // A folder on the way to scratch (`.pane`) stays plain even when git ignores it.
            else if (PANE_SCRATCH_FOLDER.startsWith(`${childRel}/`)) next = 'plain';
            else if (DEPENDENCY_DIRS.has(entry.name)) next = 'dependency';
            else if (ignored.has(childRel)) next = 'build';
          }
          try {
            const stat = lstatSync(full);
            if (stat.mtimeMs > result.newestMs) result.newestMs = stat.mtimeMs;
          } catch {
            continue;
          }
          stack.push({ dir: full, rel: childRel, bucket: next });
          continue;
        }
        let size = 0;
        try {
          const stat = lstatSync(full);
          size = stat.size;
          if (stat.mtimeMs > result.newestMs) result.newestMs = stat.mtimeMs;
        } catch {
          continue;
        }
        result.totalBytes += size;
        if (bucket === 'dependency') result.dependencyBytes += size;
        else if (bucket === 'build') result.buildOutputBytes += size;
        else if (bucket === 'scratch') result.scratchBytes += size;
      }
    } finally {
      handle.closeSync();
    }
  }
  return result;
}

/** Size folders on this thread. Callers on the main thread use measureSizes, which runs this in a worker. */
export function measureSizesHere(requests: readonly SizeRequest[]): SizeResult[] {
  return requests.map(request => walk(request.path, request));
}

function measureInWorker(requests: readonly SizeRequest[]): Promise<SizeResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename);
    worker.once('message', (results: SizeResult[]) => {
      resolve(results);
      void worker.terminate();
    });
    worker.once('error', reject);
    // Runs after a result too (terminate), when rejecting no longer changes the settled promise.
    worker.once('exit', code => reject(new PaneError('ERR_STORAGE_SCAN_WORKER_EXIT',
      `The disk size worker stopped (exit code ${code}) before it reported sizes.`, 'Run the storage scan again.')));
    worker.postMessage(requests);
  });
}

/**
 * Size folders in worker threads so a walk of millions of files never blocks
 * the main process. Folders are dealt round-robin to up to four workers: the
 * walk is bound by file-system metadata reads, which an SSD serves in parallel.
 */
export async function measureSizes(requests: readonly SizeRequest[], workers = Math.max(1, Math.min(4, availableParallelism() - 1))): Promise<SizeResult[]> {
  if (requests.length === 0) return [];
  const lanes = Array.from({ length: Math.min(workers, requests.length) }, (_, lane) => requests.filter((_request, index) => index % workers === lane));
  const laneResults = await Promise.all(lanes.map(measureInWorker));
  return requests.map((_request, index) => laneResults[index % workers][Math.floor(index / workers)]);
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.once('message', (requests: SizeRequest[]) => port.postMessage(measureSizesHere(requests)));
}
