import path from 'path';
import type { CommandRunner } from '../utils/commandRunner';
import { archiveFs, archivePathKey } from './archiveCleanupFilesystem';

const queues = new Map<string, Promise<void>>();

/** FIFO admission follows the owner's lifetime; waiting is not an I/O failure. */
export async function withArchiveRepositoryKey<T>(repository: string, action: () => Promise<T>): Promise<T> {
  const key = archivePathKey(repository);
  const previous = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>(resolve => { release = resolve; });
  queues.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

/** Share native Git mutation serialization with durable archive jobs. */
export async function withArchiveRepositoryLock<T>(project: string, runner: CommandRunner, action: () => Promise<T>): Promise<T> {
  if (runner.wslContext) return action();
  let key: string;
  try {
    const { stdout } = await runner.execFile('git', ['rev-parse', '--git-common-dir'], project, { silent: true, timeout: 30000 });
    key = archivePathKey(await archiveFs.realpath(path.resolve(project, stdout.trim())));
  } catch {
    key = archivePathKey(project);
  }
  return withArchiveRepositoryKey(key, action);
}
