import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
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
const AGENT_FARM_SNAPSHOT_ENV = 'AGENT_FARM_SNAPSHOT';

/** Where Agent Farm keeps a launch directory's snapshots. */
const SNAPSHOTS_FOLDER = '.agent-farm/snapshots';

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

const receiptSchema = boundary.object({ checksums: boundary.record(boundary.string) });

/**
 * The content hash of an installed plugin as a snapshot holds it (review r2): only the files its
 * Agent Farm receipt (`.plugins/<plugin>.json`) lists, read as they are now, so an edit in place
 * counts and a cache, virtualenv or `.DS_Store` left beside them doesn't. A listed file that is gone
 * counts as a change. Undefined when the plugin has no readable receipt in `configRoot`.
 */
export async function receiptFilesHash(configRoot: string, plugin: string): Promise<string | undefined> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(plugin)) return undefined;
  let listed: string[];
  try { listed = Object.keys(decodeBoundary(JSON.parse(await fs.readFile(path.join(configRoot, '.plugins', `${plugin}.json`), 'utf8')), receiptSchema).checksums).sort(); }
  catch { return undefined; }
  const hash = createHash('sha256');
  const folder = path.join(configRoot, 'plugins', plugin);
  for (const relative of listed) {
    const content = await fs.readFile(path.join(folder, ...relative.split('/'))).catch(() => undefined);
    hash.update(`${relative}\0`).update(content === undefined ? '\0missing' : `${content.length}\0`);
    if (content) hash.update(content);
  }
  return hash.digest('hex');
}

/**
 * Each plugin's receiptFilesHash in a snapshot folder, which reads as a config root, by plugin name.
 * A snapshot never changes once written, so callers may keep the result.
 */
export async function snapshotPluginHashes(folder: string): Promise<Record<string, string>> {
  let receipts: string[];
  try { receipts = (await fs.readdir(path.join(folder, '.plugins'))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length)); }
  catch { return {}; }
  const hashes: Record<string, string> = {};
  for (const plugin of receipts.sort()) {
    const hash = await receiptFilesHash(folder, plugin);
    if (hash) hashes[plugin] = hash;
  }
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

/**
 * Whether a snapshot can run `name` (`plugin/name`, or a bare name through its `default_plugin`):
 * its plugin folder has that profile or agent, and the snapshot passes its checksums, as Agent Farm
 * needs before it reads one. A Session move counts a profile it holds as present (T-110, D-3).
 */
export async function snapshotHoldsProfile(folder: string, name: string): Promise<boolean> {
  if (await snapshotProblem(folder)) return false;
  const [named, profile] = name.includes('/') ? name.split('/', 2) : [undefined, name];
  let plugin = named;
  if (!plugin) {
    try { plugin = decodeBoundary(JSON.parse(await fs.readFile(path.join(folder, 'settings.json'), 'utf8')), boundary.object({ default_plugin: boundary.optional(boundary.string) })).default_plugin; }
    catch { return false; }
  }
  const safe = /^[a-z0-9][a-z0-9_-]*$/i;
  if (!plugin || !safe.test(plugin) || !safe.test(profile)) return false;
  const root = path.join(folder, 'plugins', plugin);
  for (const file of [path.join(root, 'profiles', `${profile}.yaml`), path.join(root, 'agents', `${profile}.md`)]) {
    if (await fs.stat(file).then(stat => stat.isFile(), () => false)) return true;
  }
  return false;
}
