import { open, readdir, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/** Enough of a rollout file to hold its first line, the thread's `session_meta`. */
const FIRST_LINE_BYTES = 1024 * 1024;
/** Rollouts' first line. A terminal's Codex records `codex-tui` (a chat tab's, `pane`); a subagent's thread has an object for its `source`, which does not decode here. */
const rolloutMeta = boundary.object({ payload: boundary.object({ id: boundary.string, cwd: boundary.string, originator: boundary.optional(boundary.string), source: boundary.optional(boundary.string) }) });

export type CodexThreadLookup = { id: string } | { problem: string };

/**
 * The Codex conversation a terminal is running, read from Codex's own records: a running Codex
 * prints its thread ID only as it exits, and nothing may be typed into it to ask. The thread is
 * the one interactive rollout in `cwd` written since the terminal launched. More than one means
 * two Codex terminals share the folder, so none is guessed.
 */
export async function findCodexThread(cwd: string, since: number, home = process.env.CODEX_HOME || path.join(homedir(), '.codex')): Promise<CodexThreadLookup> {
  const folder = await realpath(cwd).catch(() => cwd);
  const found: string[] = [];
  for (const file of await rolloutFiles(path.join(home, 'sessions'), since)) {
    const info = await stat(file).catch(() => undefined);
    if (!info || info.mtimeMs < since) continue;
    const meta = await sessionMeta(file);
    if (meta?.originator !== 'codex-tui') continue;
    if (await realpath(meta.cwd).catch(() => meta.cwd) === folder) found.push(meta.id);
  }
  if (found.length === 1) return { id: found[0] };
  return { problem: found.length ? `${found.length} Codex conversations in this folder were active since this terminal started, and Pane will not guess which is this one` : 'Codex has saved no conversation for this terminal yet' };
}

/** Rollouts live in sessions/YYYY/MM/DD; a day folder older than `since` cannot hold a thread started since then. */
async function rolloutFiles(root: string, since: number): Promise<string[]> {
  const firstDay = new Date(since - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const names = async (directory: string): Promise<string[]> => { try { return await readdir(directory); } catch { return []; } };
  const files: string[] = [];
  for (const year of await names(root)) {
    for (const month of await names(path.join(root, year))) {
      for (const day of await names(path.join(root, year, month))) {
        if (`${year}-${month}-${day}` < firstDay) continue;
        const directory = path.join(root, year, month, day);
        for (const name of await names(directory)) if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(path.join(directory, name));
      }
    }
  }
  return files;
}

async function sessionMeta(file: string) {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(FIRST_LINE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_BYTES, 0);
    return decodeOptionalBoundary(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]), rolloutMeta)?.payload;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
