import type { Terminal } from '@xterm/xterm';
import type { MissionControlSnapshotRequest, MissionControlSnapshotResult } from '../../../shared/types/missionControl';

/** How often a shown read-only terminal checks whether its owner resized it. */
export const OWNER_GRID_CHECK_MS = 10_000;

type ReadSnapshots = (request: MissionControlSnapshotRequest) => Promise<MissionControlSnapshotResult | undefined>;

const desktopSnapshots: ReadSnapshots = async (request) => (await window.electronAPI.missionControl.snapshots(request)).data;

/** A terminal's size on the computer that runs it; null when it isn't running or that computer didn't answer. */
async function readOwnerGrid(panelId: string, read: ReadSnapshots): Promise<{ cols: number; rows: number } | null> {
  const result = await read({ panelIds: [panelId], maxLines: 1 }).catch(() => undefined);
  const snapshot = result?.snapshots.find((candidate) => candidate.panelId === panelId);
  return snapshot?.cols && snapshot.rows ? { cols: snapshot.cols, rows: snapshot.rows } : null;
}

/**
 * A read-only viewer never resizes the owner's terminal, and its output only lines up at the owner's
 * size: draws at that size instead of fitting this window. True when the grid changed.
 */
export async function adoptOwnerGrid(panelId: string, terminal: Terminal, read: ReadSnapshots = desktopSnapshots): Promise<boolean> {
  const grid = await readOwnerGrid(panelId, read);
  if (!grid || (terminal.cols === grid.cols && terminal.rows === grid.rows)) return false;
  terminal.resize(grid.cols, grid.rows);
  return true;
}

/** Whether the owner's terminal has another size than this one draws at. */
export async function ownerGridChanged(panelId: string, terminal: Terminal, read: ReadSnapshots = desktopSnapshots): Promise<boolean> {
  const grid = await readOwnerGrid(panelId, read);
  return grid !== null && (terminal.cols !== grid.cols || terminal.rows !== grid.rows);
}
