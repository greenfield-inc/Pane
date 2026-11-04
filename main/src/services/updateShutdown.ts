import path from 'node:path';
import { writeUpdateJson } from '../../../packages/runpane/src/updateOperation';

let pending: { directory: string; id: string; bootId: string } | undefined;
export function beginUpdateShutdown(directory: string, id: string, bootId: string): void {
  pending = { directory, id, bootId };
}
/** Called only after terminal persistence and all daemon storage cleanup succeeded. */
export function acknowledgeUpdateQuiescence(): void {
  if (pending) writeUpdateJson(path.join(pending.directory, 'quiesced.json'), {
    id: pending.id, bootId: pending.bootId, pid: process.pid, completedAt: new Date().toISOString(),
  });
}
