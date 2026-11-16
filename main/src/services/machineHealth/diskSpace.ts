import { stat, statfs } from 'fs/promises';
import type { DiskVolume, HealthLevel, VolumeRole } from '../../../../shared/types/machineHealth';

export interface DiskThresholds {
  warningBytes: number;
  criticalBytes: number;
}

function diskLevel(freeBytes: number, thresholds: DiskThresholds): HealthLevel {
  if (freeBytes < thresholds.criticalBytes) return 'critical';
  if (freeBytes < thresholds.warningBytes) return 'warning';
  return 'ok';
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
export async function readDiskVolumes(paths: readonly VolumePath[], thresholds: DiskThresholds): Promise<DiskVolume[]> {
  const byDevice = new Map<number, DiskVolume>();
  for (const { path, role } of paths) {
    let device: number;
    try {
      device = (await stat(path)).dev;
    } catch {
      continue; // Missing folders (a project on an unplugged drive) are skipped.
    }
    const existing = byDevice.get(device);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      continue;
    }
    try {
      const fsStats = await statfs(path);
      const freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
      const totalBytes = Number(fsStats.blocks) * Number(fsStats.bsize);
      byDevice.set(device, { path, roles: [role], totalBytes, freeBytes, level: diskLevel(freeBytes, thresholds) });
    } catch {
      // statfs is unsupported on this path; nothing to report.
    }
  }
  return [...byDevice.values()];
}
