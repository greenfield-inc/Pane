import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { hashDirectory } from '../skillCacheManager';
import type { OrchestrationSessionRecord } from '../../../../shared/types/orchestrationSession';

/**
 * A Session's Agent Farm snapshot (T-110): a frozen copy of every plugin Pane's Agent Farm had
 * installed, which the Session's agents read until Reload profile takes a new one. Agent Farm
 * writes it under `<Session folder>/.agent-farm/snapshots/<digest>/` (CONFIGURATION.md, "Session
 * snapshots"), where a Session move carries it. Pane keeps its path relative to the Session folder.
 */
export interface SessionSnapshot {
  /** Relative to the Session folder, with `/`: `.agent-farm/snapshots/<digest>`. */
  path: string;
  digest: string;
  /** The plugins it holds, by name, with their versions. */
  plugins: Record<string, string>;
}

/** Agent Farm's variable for the snapshot a launch resolves from, inherited by everything it starts. */
export const AGENT_FARM_SNAPSHOT_ENV = 'AGENT_FARM_SNAPSHOT';

/** Where Agent Farm keeps a launch directory's snapshots. */
export const SNAPSHOTS_FOLDER = '.agent-farm/snapshots';

const createdOutput = boundary.object({ path: boundary.nonEmptyString, digest: boundary.nonEmptyString, plugins: boundary.record(boundary.string) });

/**
 * Reads `agent-farm snapshot create --directory <Session folder> --json`. Throws a PaneError when
 * it is not that output, or names a folder outside the Session's snapshots.
 */
export function parseSnapshotCreated(stdout: string, sessionFolder: string): SessionSnapshot {
  let created;
  try { created = decodeBoundary(JSON.parse(stdout), createdOutput); }
  catch (error) { throw new PaneError('AGENT_FARM_SNAPSHOT_FAILED', `Agent Farm's snapshot create printed something Pane can't read: ${reasonOf(error)}.`, 'Restart Pane, which reinstalls its bundled Agent Farm, then try again.'); }
  const relative = path.relative(sessionFolder, path.resolve(sessionFolder, created.path)).split(path.sep).join('/');
  if (!relative.startsWith(`${SNAPSHOTS_FOLDER}/`) || relative.split('/').length !== 3) {
    throw new PaneError('AGENT_FARM_SNAPSHOT_FAILED', `Agent Farm saved the Session's snapshot at ${created.path}, outside its folder's ${SNAPSHOTS_FOLDER}.`, 'Update Pane, then try again.');
  }
  return { path: relative, digest: created.digest, plugins: created.plugins };
}

/** A snapshot's folder, from its path relative to the Session folder. */
export function snapshotLocation(sessionFolder: string, relative: string): string {
  return path.join(sessionFolder, ...relative.split('/'));
}

/**
 * Whether Agent Farm refused a launch because its snapshot can't be read (missing, failed its
 * checksum, or written by a newer Agent Farm). Agent Farm then never falls back to the installed
 * plugins, and Reload profile is the way on.
 */
export function snapshotRefused(output: string | undefined): boolean {
  return !!output && /Snapshot .+ will not fall back to the installed plugins/is.test(output);
}

const checksumsSchema = boundary.record(boundary.string);

/**
 * Checks a snapshot folder against its own checksums.json, as Agent Farm does before it reads one:
 * every file but checksums.json, by its path relative to the folder, with its SHA-256. Returns why
 * it fails, or undefined when it matches.
 */
export async function snapshotProblem(folder: string): Promise<string | undefined> {
  let expected: Record<string, string>;
  try { expected = decodeBoundary(JSON.parse(await fs.readFile(path.join(folder, 'checksums.json'), 'utf8')), checksumsSchema); }
  catch (error) { return `its checksums.json can't be read (${reasonOf(error)})`; }
  const found = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else found.set(path.relative(folder, full), createHash('sha256').update(await fs.readFile(full)).digest('hex'));
    }
  };
  try { await visit(folder); }
  catch (error) { return `it can't be read (${reasonOf(error)})`; }
  found.delete('checksums.json');
  for (const [file, sha256] of Object.entries(expected)) {
    const actual = found.get(file);
    if (actual === undefined) return `${file} is missing`;
    if (actual !== sha256) return `${file} changed`;
    found.delete(file);
  }
  const extra = [...found.keys()][0];
  return extra === undefined ? undefined : `${extra} was added`;
}

/** The snapshots in a Session folder that fail their checksums, each with why; empty when all match or there are none. */
export async function unreadableSnapshots(sessionFolder: string): Promise<Array<{ path: string; problem: string }>> {
  const root = snapshotLocation(sessionFolder, SNAPSHOTS_FOLDER);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const failed: Array<{ path: string; problem: string }> = [];
  // Agent Farm builds in `.building-*` and renames; one left by a killed launch is not a snapshot.
  for (const entry of entries.filter(item => item.isDirectory() && !item.name.startsWith('.'))) {
    const problem = await snapshotProblem(path.join(root, entry.name));
    if (problem) failed.push({ path: `${SNAPSHOTS_FOLDER}/${entry.name}`, problem });
  }
  return failed;
}

/**
 * The content hash (hashDirectory, as Pane hashes an installed plugin) of each plugin folder in a
 * snapshot, by plugin name. A snapshot never changes once written, so callers may keep the result.
 */
export async function snapshotPluginHashes(folder: string): Promise<Record<string, string>> {
  const plugins = path.join(folder, 'plugins');
  let names: string[];
  try { names = (await fs.readdir(plugins, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return {}; }
  const hashes: Record<string, string> = {};
  for (const name of names.sort()) hashes[name] = await hashDirectory(path.join(plugins, name));
  return hashes;
}

/** What of a Session record finds the snapshot a tab in its Panes gets. */
export type SnapshotHolder = Pick<OrchestrationSessionRecord, 'id' | 'internalSessionId' | 'associations' | 'agentFarmSnapshot' | 'archived'>;

/**
 * The snapshot folder a new tab in Pane `paneId` gets (T-110, D-4): its Session's, whether the tab is
 * the Session's own (its lead, or any tab in the Session's Pane) or in a Pane the Session holds.
 * Undefined outside a Session, or for a Session without a snapshot. `folderOf` is a Session's folder.
 */
export function sessionSnapshotForTab(sessions: readonly SnapshotHolder[], tab: { paneId: string; orchestrationSessionId?: string }, folderOf: (sessionId: string) => string): string | undefined {
  const session = sessions.find(item => item.archived !== true && (item.id === tab.orchestrationSessionId || item.internalSessionId === tab.paneId))
    ?? sessions.find(item => item.archived !== true && item.associations.some(association => association.paneId === tab.paneId && !association.machine));
  return session?.agentFarmSnapshot ? snapshotLocation(folderOf(session.id), session.agentFarmSnapshot) : undefined;
}

/**
 * A tab's environment with AGENT_FARM_SNAPSHOT set to `snapshot` (T-110), so an `agent-farm run` in it
 * reads its Session's files. With Profiles off the environment is left as it is; on, an inherited
 * value never leaks into a tab outside a Session.
 */
export function withSnapshotEnv(env: Readonly<Record<string, string>>, snapshot: string | undefined, profiles: boolean) {
  if (!profiles) return { ...env };
  const { [AGENT_FARM_SNAPSHOT_ENV]: _inherited, ...rest } = env;
  return snapshot ? { ...rest, [AGENT_FARM_SNAPSHOT_ENV]: snapshot } : rest;
}
