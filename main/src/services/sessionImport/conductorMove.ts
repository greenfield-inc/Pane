import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import {
  HOST_PLACEMENT_CHANNELS,
  type ConductorMoveProgress,
  type ConductorMoveResult,
  type ConductorMoveScan,
  type HostPlacementResult,
  type HostPlacementStatus,
  type HostWorkspacePlacement,
  type MovableWorkspace,
  type MovedWorkspaceResult,
  type PlacementFile,
} from '../../../../shared/types/conductorMove';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { locateNativeSession } from '../../../../packages/runpane/src/nativeSession';
import { readConductorWorkspaces, type ConductorWorkspace } from './sources/conductor';
import type { ReaderContext } from './sources/types';
import { writeRecordEntry } from './record';

const GIT_TIMEOUT_MS = 120_000;
/** Raw bytes per upload request; each request must finish inside the remote client's 15 s. */
const CHUNK_BYTES = 1024 * 1024;
const POLL_MS = 1_000;
const PLACEMENT_TIMEOUT_MS = 30 * 60_000;
const WIP_REF = 'refs/pane-import/wip';

/** The chosen machine, reached through its saved connection. */
export interface MoveTarget {
  label: string;
  invoke(channel: string, args: unknown[]): Promise<unknown>;
}

/** A workspace with what packing it needs, beyond what the dialog shows. */
interface InspectedWorkspace {
  view: MovableWorkspace;
  conductor: ConductorWorkspace;
  git?: GitFacts;
}

interface GitFacts {
  root: string;
  branch: string;
  head: string;
  remote: string;
  remoteUrl: string;
  upstreamBranch?: string;
  defaultBranch?: string;
  upstreamHasHead: boolean;
}

export interface ConductorMoveScanOutcome {
  scan: ConductorMoveScan;
  workspaces: Map<string, InspectedWorkspace>;
}

/** Reads Conductor's workspaces on this Mac and the git state of each; changes nothing. */
export async function scanConductorMove(context: ReaderContext): Promise<ConductorMoveScanOutcome> {
  const read = await readConductorWorkspaces(context);
  if (read.status !== 'ok') {
    return { scan: { status: read.status, reason: read.reason, storePaths: read.storePaths, workspaces: [] }, workspaces: new Map() };
  }
  const inspected = await Promise.all(read.workspaces.map(inspect));
  return {
    scan: { status: 'ok', storePaths: read.storePaths, workspaces: inspected.map(item => item.view) },
    workspaces: new Map(inspected.map(item => [item.view.key, item])),
  };
}

async function inspect(conductor: ConductorWorkspace): Promise<InspectedWorkspace> {
  const chats = conductor.chats.map(chat => ({
    key: `${chat.agent}:${chat.sessionId}`,
    agent: chat.agent,
    sessionId: chat.sessionId,
    title: chat.title,
    running: chat.running,
    unavailable: chat.unavailable,
  }));
  const view: MovableWorkspace = {
    key: conductor.folder,
    name: conductor.name,
    branch: conductor.branch,
    uncommitted: 0,
    unpushed: 0,
    chats,
    running: chats.some(chat => chat.running !== 'no'),
  };
  if (!fs.existsSync(conductor.folder)) return { view: { ...view, unavailable: 'its folder is no longer on this Mac' }, conductor };
  try {
    const root = await git(conductor.folder, ['rev-parse', '--show-toplevel']);
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD') return { view: { ...view, unavailable: 'it has no branch checked out (detached HEAD)' }, conductor };
    const remote = await git(root, ['config', `branch.${branch}.remote`]).catch(() => 'origin');
    const remoteUrl = await git(root, ['remote', 'get-url', remote]).catch(() => '');
    const head = await git(root, ['rev-parse', 'HEAD']);
    const merge = await git(root, ['config', `branch.${branch}.merge`]).catch(() => '');
    const upstreamBranch = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : undefined;
    const upstreamRef = `refs/remotes/${remote}/${upstreamBranch ?? branch}`;
    const upstreamHasHead = await git(root, ['merge-base', '--is-ancestor', head, upstreamRef]).then(() => true, () => false);
    const defaultBranch = (await git(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).replace(`${remote}/`, '') || undefined;
    const unpushed = Number(await git(root, ['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`]).catch(() => '0'));
    const uncommitted = (await git(root, ['status', '--porcelain', '-z'])).split('\0').filter(Boolean).length;
    const facts: GitFacts = { root, branch, head, remote, remoteUrl, upstreamBranch, defaultBranch, upstreamHasHead };
    const repoName = remoteUrl ? path.basename(remoteUrl.replace(/\/+$/u, '')).replace(/\.git$/u, '') : path.basename(root);
    return {
      view: {
        ...view,
        branch,
        repoName,
        uncommitted,
        unpushed,
        unavailable: remoteUrl ? undefined : `its repository has no "${remote}" remote, so the other machine can't get it`,
      },
      conductor,
      git: facts,
    };
  } catch (error) {
    return { view: { ...view, unavailable: `Pane couldn't read its git checkout: ${reasonOf(error)}` }, conductor };
  }
}

export interface MoveOptions {
  workspaces: InspectedWorkspace[];
  target: MoveTarget;
  /** This Mac's name, recorded on the machine as where the work came from. */
  machineName: string;
  paneDir: string;
  env?: NodeJS.ProcessEnv;
  tempDir?: string;
  onProgress?: (progress: ConductorMoveProgress) => void;
  now?: () => Date;
}

/** Moves each workspace in turn; a workspace that fails leaves the others going. */
export async function moveWorkspaces(options: MoveOptions): Promise<ConductorMoveResult> {
  const results: MovedWorkspaceResult[] = [];
  let recordError: string | undefined;
  const total = options.workspaces.length;
  for (const [index, workspace] of options.workspaces.entries()) {
    options.onProgress?.({ running: true, done: index, total, current: workspace.view.name });
    const result = await moveOne(workspace, options);
    results.push(result);
    try {
      recordMoved(workspace, result, options);
    } catch (error) {
      recordError ??= reasonOf(error);
    }
  }
  options.onProgress?.({ running: false, done: total, total });
  return { machine: options.target.label, results, recordError };
}

async function moveOne(workspace: InspectedWorkspace, options: MoveOptions): Promise<MovedWorkspaceResult> {
  const { view, git: facts } = workspace;
  const failed = (reason: string): MovedWorkspaceResult => ({ key: view.key, name: view.name, outcome: 'not moved', reason, chats: [] });
  if (!facts || view.unavailable) return failed(`It can't move: ${view.unavailable ?? 'Pane couldn\'t read it'}.`);
  if (view.running) return failed('A chat in it is still running. Quit it in Conductor, then press Check again.');

  const scratch = fs.mkdtempSync(path.join(options.tempDir ?? os.tmpdir(), 'pane-conductor-move-'));
  try {
    const wip = view.uncommitted > 0 ? await wipCommit(facts) : undefined;
    const chats = await packChats(workspace, options);
    const placement: HostWorkspacePlacement = {
      name: view.name,
      repo: { name: view.repoName ?? path.basename(facts.root), remoteUrl: facts.remoteUrl },
      branch: facts.branch,
      head: facts.head,
      upstreamBranch: facts.upstreamBranch,
      defaultBranch: facts.defaultBranch,
      wip: Boolean(wip),
      chats: [],
      origin: { machine: options.machineName, folder: view.key },
    };
    const needsBundle = Boolean(wip) || !facts.upstreamHasHead;
    let thin = true;
    for (;;) {
      if (needsBundle) {
        const bundle = path.join(scratch, `${thin ? 'thin' : 'full'}.bundle`);
        await createBundle(facts, wip, bundle, thin);
        placement.bundle = { upload: await upload(options.target, bundle), thin };
      }
      placement.chats = await Promise.all(chats.filter(chat => !chat.skipped).map(async chat => ({
        ...chat.placement,
        files: await Promise.all(chat.files.map(async file => ({ path: file.path, upload: await upload(options.target, file.absolute) } satisfies PlacementFile))),
      })));
      const result = await place(options.target, placement);
      if (result.needsFullBundle && thin) {
        thin = false;
        continue;
      }
      const { needsFullBundle: _full, ...rest } = result;
      return { key: view.key, ...rest, chats: [...rest.chats, ...chats.flatMap(chat => chat.skipped ? [chat.skipped] : [])] };
    }
  } catch (error) {
    return failed(`Pane couldn't send it to ${options.target.label}: ${reasonOf(error)}. Nothing on this Mac changed. Press Move to try again.`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The uncommitted files as one commit on top of HEAD, made with a separate index so the
 * person's staging area is untouched. Ignored files stay behind, as git leaves them.
 */
async function wipCommit(facts: GitFacts): Promise<string> {
  const indexFile = path.join(os.tmpdir(), `pane-move-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile, GIT_AUTHOR_NAME: 'Pane', GIT_AUTHOR_EMAIL: 'pane@localhost', GIT_COMMITTER_NAME: 'Pane', GIT_COMMITTER_EMAIL: 'pane@localhost' };
  try {
    await git(facts.root, ['read-tree', 'HEAD'], env);
    await git(facts.root, ['add', '-A'], env);
    const tree = await git(facts.root, ['write-tree'], env);
    return await git(facts.root, ['commit-tree', tree, '-p', 'HEAD', '-m', 'Uncommitted files moved by Pane'], env);
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

/**
 * A bundle of the branch and the uncommitted-files commit. A thin one leaves out commits the
 * remote already has; when that leaves nothing, it carries only HEAD on top of its parents.
 */
async function createBundle(facts: GitFacts, wip: string | undefined, file: string, thin: boolean): Promise<void> {
  const refs = [`refs/heads/${facts.branch}`, ...(wip ? [WIP_REF] : [])];
  // A bundle names refs, so the commit gets a ref of its own until the bundle is written.
  if (wip) await git(facts.root, ['update-ref', WIP_REF, wip]);
  try {
    if (!thin) {
      await git(facts.root, ['bundle', 'create', '--quiet', file, ...refs]);
      return;
    }
    const created = await git(facts.root, ['bundle', 'create', '--quiet', file, ...refs, '--not', `--remotes=${facts.remote}`]).then(() => true, () => false);
    if (created) return;
    const parents = (await git(facts.root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ').slice(1);
    await git(facts.root, ['bundle', 'create', '--quiet', file, ...refs, ...(parents.length ? ['--not', ...parents] : [])]);
  } finally {
    if (wip) await git(facts.root, ['update-ref', '-d', WIP_REF]).catch(() => undefined);
  }
}

interface PackedChat {
  placement: Omit<HostWorkspacePlacement['chats'][number], 'files'>;
  files: Array<{ absolute: string; path: string }>;
  skipped?: MovedWorkspaceResult['chats'][number];
}

/** Each chat's transcript files from the person's own Claude and Codex stores. */
async function packChats(workspace: InspectedWorkspace, options: MoveOptions): Promise<PackedChat[]> {
  const packed: PackedChat[] = [];
  for (const chat of workspace.conductor.chats) {
    const notContinued = (reason: string): PackedChat['skipped'] => ({ key: `${chat.agent}:${chat.sessionId}`, source: 'conductor', agent: chat.agent, title: chat.title, outcome: 'not continued', reason });
    if (chat.agent !== 'claude' && chat.agent !== 'codex') continue;
    if (chat.unavailable) {
      packed.push({ placement: { agent: chat.agent, sessionId: chat.sessionId, title: chat.title }, files: [], skipped: notContinued(`It can't come along: ${chat.unavailable}.`) });
      continue;
    }
    const located = await locateNativeSession(chat.agent, chat.sessionId, workspace.view.key, options.env ?? process.env).catch(() => undefined);
    if (!located) {
      packed.push({ placement: { agent: chat.agent, sessionId: chat.sessionId, title: chat.title }, files: [], skipped: notContinued('Its transcript isn\'t on this Mac, so there was nothing to copy.') });
      continue;
    }
    const prefix = `${located.storeDir}/`;
    packed.push({
      placement: { agent: chat.agent, sessionId: chat.sessionId, title: chat.title },
      files: located.files.map(file => ({ absolute: file.absolute, path: file.home.startsWith(prefix) ? file.home.slice(prefix.length) : file.home })),
    });
  }
  return packed;
}

const uploadReplySchema = boundary.object({ receivedBytes: boundary.number });

/** Sends one file in chunks, resuming from what the machine already has; returns its upload id. */
async function upload(target: MoveTarget, file: string): Promise<string> {
  const bytes = fs.readFileSync(file);
  const uploadId = randomUUID();
  const md5 = createHash('md5').update(bytes).digest('hex');
  let received = decodeBoundary(await target.invoke(HOST_PLACEMENT_CHANNELS.uploadStart, [{
    uploadId, sessionId: 'session-import', fileName: path.basename(file), mimeType: 'application/octet-stream', size: bytes.length, md5,
  }]), uploadReplySchema).receivedBytes;
  while (received < bytes.length) {
    const chunk = bytes.subarray(received, received + CHUNK_BYTES).toString('base64');
    received = decodeBoundary(await target.invoke(HOST_PLACEMENT_CHANNELS.uploadChunk, [uploadId, received, chunk]), uploadReplySchema).receivedBytes;
  }
  return uploadId;
}

const startReplySchema = boundary.object({ jobId: boundary.nonEmptyString });

async function place(target: MoveTarget, placement: HostWorkspacePlacement): Promise<HostPlacementResult> {
  const { jobId } = decodeBoundary(await target.invoke(HOST_PLACEMENT_CHANNELS.place, [placement]), startReplySchema);
  const deadline = Date.now() + PLACEMENT_TIMEOUT_MS;
  for (;;) {
    // SAFETY: the machine's place-status handler returns HostPlacementStatus.
    const status = await target.invoke(HOST_PLACEMENT_CHANNELS.status, [jobId]) as HostPlacementStatus;
    if (status.state === 'done') return status.result;
    if (Date.now() > deadline) {
      throw new PaneError('ERR_CONDUCTOR_MOVE_TIMEOUT', `${target.label} was still at "${status.step}" after 30 minutes`, `Check ${target.label} in Pane before pressing Move again.`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

/** The shared import record: chats now in Pane on the machine, so no import offers them again. */
function recordMoved(workspace: InspectedWorkspace, result: MovedWorkspaceResult, options: MoveOptions): void {
  const at = (options.now ?? (() => new Date()))().toISOString();
  for (const chat of result.chats) {
    if (chat.outcome === 'not continued' && !chat.paneId) continue;
    const [tool, ...rest] = chat.key.split(':');
    writeRecordEntry(options.paneDir, {
      tool, id: rest.join(':'), folder: workspace.view.key, paneId: chat.paneId ?? null, panelId: chat.panelId ?? null, forkId: null,
      result: chat.outcome === 'continued' ? 'continued' : 'pending', at, source: 'conductor', host: options.target.label,
    });
  }
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve(String(stdout).trim());
    });
  });
}
