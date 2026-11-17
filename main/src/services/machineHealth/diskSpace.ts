import { stat, statfs } from 'fs/promises';
import type { DiskVolume, VolumeRole } from '../../../../shared/types/machineHealth';

/** A volume as read, before the thresholds give it a level. */
export type VolumeReading = Omit<DiskVolume, 'level'>;

/** A volume read slower than this (a hung network mount) is skipped for this sample. */
const VOLUME_READ_TIMEOUT_MS = 3_000;
/** Paths whose last read has not settled: each hung read holds a libuv thread, so none is stacked on it. */
const pendingReads = new Set<string>();

/** `read(path)`, or null when it fails, takes over VOLUME_READ_TIMEOUT_MS, or an earlier read of `path` is still hung. */
async function readVolume<T>(path: string, read: (path: string) => Promise<T>): Promise<T | null> {
  if (pendingReads.has(path)) return null;
  pendingReads.add(path);
  const result = read(path).finally(() => pendingReads.delete(path));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), VOLUME_READ_TIMEOUT_MS); });
  try {
    return await Promise.race([result, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface VolumePath {
  path: string;
  role: VolumeRole;
}

/**
 * Free space on each distinct volume behind `paths`. Paths on one device share
 * one entry carrying every role. Free space counts only blocks available to
 * this user (bavail), and on macOS leaves purgeable space out, so it errs low.
 */
export async function readDiskVolumes(paths: readonly VolumePath[]): Promise<VolumeReading[]> {
  const byDevice = new Map<number, VolumeReading>();
  for (const { path, role } of paths) {
    // Missing folders (a project on an unplugged drive) and hung mounts are skipped.
    const device = (await readVolume(path, p => stat(p)))?.dev;
    if (device === undefined) continue;
    const existing = byDevice.get(device);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      continue;
    }
    // Null when statfs is unsupported on this path: nothing to report.
    const fsStats = await readVolume(path, p => statfs(p));
    if (!fsStats) continue;
    const freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
    const totalBytes = Number(fsStats.blocks) * Number(fsStats.bsize);
    byDevice.set(device, { path, roles: [role], totalBytes, freeBytes });
  }
  return [...byDevice.values()];
}
