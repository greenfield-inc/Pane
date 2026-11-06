import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile, spawn } from 'child_process';
import { HOST_PLACEMENT_CHANNELS, type HostPlacementResult, type HostPlacementStatus, type HostWorkspacePlacement } from '../../../../shared/types/conductorMove';
import type { ImportSessionResult } from '../../../../shared/types/sessionImport';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry, PaneCommandValue } from '../../daemon/commandRegistry';
import { ChunkedUploadStore, type UploadStart } from '../chunkedUploadStore';
import { placeSessions, type PlacementPort } from './place';
import type { ScannedSession } from './scan';
import { findClaudeTranscript, findCodexTranscript } from './sources/common';
import { detectProjectConfig } from '../projectConfigDetector';

const GIT_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 15 * 60_000;
const SAFE_NAME = /[^A-Za-z0-9._-]+/gu;
const NEXT = 'Fix that, then press Move again: workspaces already on the machine are skipped.';
/** A moved chat's transcript can be large; the bundle is usually small. */
const MOVE_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
/** A finished placement's answer is kept this long for the Mac to collect. */
const PLACEMENT_RESULT_MS = 60 * 60_000;

const uploadStartSchema: BoundarySchema<UploadStart> = boundary.object({
  uploadId: boundary.nonEmptyString,
  sessionId: boundary.string,
  fileName: boundary.string,
  mimeType: boundary.string,
  size: boundary.number,
  md5: boundary.string,
});
const uploadChunkSchema = boundary.object({ uploadId: boundary.nonEmptyString, offset: boundary.number, base64: boundary.string });
const placementFileSchema = boundary.object({ upload: boundary.nonEmptyString, path: boundary.nonEmptyString });
const placementSchema: BoundarySchema<HostWorkspacePlacement> = boundary.object({
  name: boundary.nonEmptyString,
  repo: boundary.object({ name: boundary.nonEmptyString, remoteUrl: boundary.nonEmptyString }),
  branch: boundary.nonEmptyString,
  head: boundary.nonEmptyString,
  upstreamBranch: boundary.optional(boundary.string),
  defaultBranch: boundary.optional(boundary.string),
  bundle: boundary.optional(boundary.object({ upload: boundary.nonEmptyString, thin: boundary.boolean })),
  wip: boundary.boolean,
  chats: boundary.array(boundary.object({
    agent: boundary.enumeration('claude', 'codex'),
    sessionId: boundary.nonEmptyString,
    title: boundary.optional(boundary.string),
    files: boundary.array(placementFileSchema),
  })),
  origin: boundary.object({ machine: boundary.string, folder: boundary.string }),
});


/** This machine's Pane, as placing a moved workspace drives it. */
export interface HostPlacementPort extends PlacementPort {
  /** Where `~/pane/repos` and `~/pane/workspaces` go. */
  home: string;
  machineName: string;
  stores: { claudeConfigDir: string; codexHome: string };
  paneDir: string;
  /** Saved repositories. */
  repos(): Array<{ id: number; path: string; buildScript?: string | null }>;
  /** Clones into `destDir/<repo name>` and returns the clone's path. */
  cloneRepo(url: string, destDir: string): Promise<string>;
  /** A Pane on the checkout with one agent tab that isn't started: for a workspace with no chats left. */
  adoptWithoutChat(repoId: number, checkout: string, name: string): Promise<{ paneId: string }>;
  /** The committed file for one upload. */
  uploadedFile(upload: string): Promise<string>;
  onStep?(step: string): void;
}

class PlacementFailure extends Error {}

/**
 * The commands another computer calls to move a workspace here: its files arrive as chunked
 * uploads, then one placement job rebuilds it; the caller polls the job, since a remote request
 * must answer within seconds.
 */
export function registerHostPlacementCommands(
  registry: Pick<PaneCommandRegistry, 'register'>,
  uploadDir: string,
  port: Omit<HostPlacementPort, 'uploadedFile' | 'onStep'>,
): void {
  const uploads = new ChunkedUploadStore({ dir: uploadDir, maxBytes: MOVE_UPLOAD_MAX_BYTES });
  const placements = new Map<string, HostPlacementStatus>();

  registry.register(HOST_PLACEMENT_CHANNELS.uploadStart, (input: PaneCommandValue) => uploads.start(decodeBoundary(input, uploadStartSchema)));
  registry.register(HOST_PLACEMENT_CHANNELS.uploadChunk, (uploadId: PaneCommandValue, offset: PaneCommandValue, base64: PaneCommandValue) => {
    const chunk = decodeBoundary({ uploadId, offset, base64 }, uploadChunkSchema);
    return uploads.append(chunk.uploadId, chunk.offset, chunk.base64);
  });
  registry.register(HOST_PLACEMENT_CHANNELS.place, (request: PaneCommandValue) => {
    const placement = decodeBoundary(request, placementSchema);
    const jobId = randomUUID();
    const landed: string[] = [];
    placements.set(jobId, { state: 'running', step: 'Starting' });
    void placeMovedWorkspace(placement, {
      ...port,
      onStep: step => placements.set(jobId, { state: 'running', step }),
      async uploadedFile(upload) {
        const { filePath } = await uploads.commit(upload, async (record, bytes) => {
          const target = path.join(uploadDir, 'files', record.uploadId);
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.writeFile(target, bytes);
          return target;
        });
        landed.push(filePath);
        return filePath;
      },
    }).then(result => {
      placements.set(jobId, { state: 'done', result });
    }).finally(() => {
      for (const file of landed) fs.rmSync(file, { force: true });
      setTimeout(() => placements.delete(jobId), PLACEMENT_RESULT_MS).unref();
    });
    return { jobId };
  });
  registry.register(HOST_PLACEMENT_CHANNELS.status, (jobId: PaneCommandValue): HostPlacementStatus => {
    const status = placements.get(decodeBoundary(jobId, boundary.nonEmptyString));
    if (!status) {
      throw new PaneError('ERR_SESSION_IMPORT_PLACEMENT_UNKNOWN', 'This machine has no record of that placement: Pane may have restarted while it ran.', 'Check this machine\'s Panes, then move the workspace again; one that arrived is skipped.');
    }
    return status;
  });
}

/**
 * Rebuild one Conductor workspace from the Mac on this machine: its repository (reused or
 * cloned), its branch with the unpushed commits from the bundle, a worktree with the uncommitted
 * files put back, the repository's setup script run once, and its chats resumed by id as tabs of
 * one adopted Pane. Nothing is pushed anywhere. A branch already checked out here is left alone.
 */
async function placeMovedWorkspace(placement: HostWorkspacePlacement, port: HostPlacementPort): Promise<HostPlacementResult> {
  const chats: ImportSessionResult[] = [];
  const base = { name: placement.name, chats };
  try {
    const step = (text: string) => port.onStep?.(text);
    await checkBranchName(placement.branch);

    step('Finding the repository');
    const repo = await findOrCloneRepo(placement, port);
    const remote = repo.remote;

    const existing = await worktreeOnBranch(repo.path, placement.branch);
    if (existing) {
      const pane = port.paneForCheckout(existing);
      if (pane) return { ...base, outcome: 'already there', paneId: pane.paneId, paneName: pane.name, worktreePath: existing };
      throw new PlacementFailure(`${placement.branch} is already checked out at ${existing} on ${port.machineName}, outside Pane. Open that folder in Pane there, or remove that worktree and press Move again.`);
    }

    step('Fetching');
    // The remote may be unreachable; a thin bundle then reports what it is missing.
    const fetched = await git(repo.path, ['fetch', '--quiet', remote]).then(() => true, () => false);

    let tip: string;
    if (placement.bundle) {
      const bundle = await port.uploadedFile(placement.bundle.upload);
      if (!(await git(repo.path, ['bundle', 'verify', '--quiet', bundle]).then(() => true, () => false))) {
        if (placement.bundle.thin) return { ...base, outcome: 'not moved', needsFullBundle: true };
        throw new PlacementFailure(`The git bundle for ${placement.branch} didn't arrive intact. ${NEXT}`);
      }
      const refspecs = [`refs/heads/${placement.branch}:refs/pane-import/head`, ...(placement.wip ? ['refs/pane-import/wip:refs/pane-import/wip'] : [])];
      await git(repo.path, ['fetch', '--quiet', '--no-write-fetch-head', bundle, ...refspecs]);
      tip = await git(repo.path, ['rev-parse', '--verify', 'refs/pane-import/head^{commit}']);
    } else {
      const tracked = `refs/remotes/${remote}/${placement.upstreamBranch ?? placement.branch}`;
      const found = await git(repo.path, ['rev-parse', '--verify', '--quiet', `${tracked}^{commit}`]).catch(() => '');
      if (!found) {
        throw new PlacementFailure(`${placement.branch} isn't on ${remote}${fetched ? '' : ` (${port.machineName} couldn't fetch from it)`}, and the Mac sent no commits for it. ${NEXT}`);
      }
      tip = found;
    }
    if (tip !== placement.head) throw new PlacementFailure(`${placement.branch} arrived at ${tip.slice(0, 7)}, not the Mac's ${placement.head.slice(0, 7)}. ${NEXT}`);

    step('Creating the worktree');
    const createdBranch = await placeBranch(repo.path, placement.branch, tip, port.machineName);
    if (placement.upstreamBranch && await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${placement.upstreamBranch}`]).then(() => true, () => false)) {
      await git(repo.path, ['branch', `--set-upstream-to=${remote}/${placement.upstreamBranch}`, placement.branch]);
    }
    const worktree = freePath(path.join(port.home, 'pane', 'workspaces', safeName(placement.repo.name), safeName(placement.name)));
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    await git(repo.path, ['worktree', 'add', '--quiet', worktree, placement.branch]);
    try {
      if (placement.wip) {
        const patch = await gitBuffer(repo.path, ['diff', '--binary', placement.branch, 'refs/pane-import/wip']);
        if (patch.length > 0) await gitWithInput(worktree, ['apply', '--binary', '--whitespace=nowarn'], patch);
      }
    } catch (error) {
      await git(repo.path, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
      if (createdBranch) await git(repo.path, ['branch', '-D', placement.branch]).catch(() => undefined);
      throw new PlacementFailure(`Pane couldn't put the uncommitted files back on ${port.machineName}: ${reasonOf(error)}. Nothing was left there. ${NEXT}`);
    } finally {
      await git(repo.path, ['update-ref', '-d', 'refs/pane-import/head']).catch(() => undefined);
      await git(repo.path, ['update-ref', '-d', 'refs/pane-import/wip']).catch(() => undefined);
    }

    step('Running the setup script');
    const setup = await runSetup(repo, worktree, placement);

    step('Resuming the chats');
    const staging = fs.mkdtempSync(path.join(port.paneDir, 'session-import-staging-'));
    try {
      const sessions = await stageChats(placement, staging, worktree, repo.path, port);
      const placed = await placeSessions({
        sessions, port, stores: port.stores, paneDir: port.paneDir,
        retryNext: `Its transcript is on ${port.machineName}: open its Pane there and resume it from a new tab.`,
      });
      let pane = placed.results.find(result => result.paneId && result.outcome !== 'not continued');
      if (!pane) {
        const adopted = await port.adoptWithoutChat(repo.id, worktree, path.basename(worktree));
        pane = { key: '', source: 'conductor', agent: 'claude', outcome: 'continued', paneId: adopted.paneId, paneName: path.basename(worktree) };
      }
      return { ...base, outcome: 'moved', paneId: pane.paneId, paneName: pane.paneName, worktreePath: worktree, setup, chats: placed.results };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    const reason = error instanceof PlacementFailure ? error.message : `${port.machineName} couldn't place it: ${reasonOf(error)}. ${NEXT}`;
    return { ...base, outcome: 'not moved', reason };
  }
}

interface HostRepo {
  id: number;
  path: string;
  remote: string;
  buildScript?: string | null;
}

/** The saved repository whose remote is the workspace's, else a clone of it under `~/pane/repos`. */
async function findOrCloneRepo(placement: HostWorkspacePlacement, port: HostPlacementPort): Promise<HostRepo> {
  const wanted = repoIdentity(placement.repo.remoteUrl);
  if (!wanted) throw new PlacementFailure(`Pane can't read the remote ${placement.repo.remoteUrl}. ${NEXT}`);
  for (const saved of port.repos()) {
    const remote = await matchingRemote(saved.path, wanted);
    if (remote) return { ...saved, remote };
  }
  const reposDir = path.join(port.home, 'pane', 'repos');
  const target = path.join(reposDir, safeName(placement.repo.name));
  let clone: string;
  if (fs.existsSync(target)) {
    if (!(await matchingRemote(target, wanted))) {
      throw new PlacementFailure(`${target} on ${port.machineName} holds another repository, so Pane didn't clone ${placement.repo.name} there. Move that folder, then press Move again.`);
    }
    clone = target;
  } else {
    fs.mkdirSync(reposDir, { recursive: true });
    try {
      clone = await port.cloneRepo(placement.repo.remoteUrl, reposDir);
    } catch (error) {
      throw new PlacementFailure(`${port.machineName} couldn't clone ${placement.repo.remoteUrl}: ${reasonOf(error)}. Sign in to GitHub on ${port.machineName} (in its terminal: gh auth login), then press Move again.`);
    }
  }
  const remote = await matchingRemote(clone, wanted) ?? 'origin';
  const id = await port.addRepo(clone);
  return { id, path: clone, remote, buildScript: port.repos().find(saved => saved.id === id)?.buildScript };
}

/** `host/owner/name`, lowercased, for comparing remote URLs written different ways. */
function repoIdentity(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/u, '').replace(/\.git$/u, '');
  const scp = /^[^@/]+@([^:/]+):(.+)$/u.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'file:') return `file:${path.resolve(parsed.pathname)}`;
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return path.isAbsolute(trimmed) ? `file:${path.resolve(trimmed)}` : undefined;
  }
}

async function matchingRemote(repoPath: string, wanted: string): Promise<string | undefined> {
  const lines = await git(repoPath, ['remote', '-v']).catch(() => '');
  for (const line of lines.split('\n')) {
    const [name, url] = line.split(/\s+/u);
    if (name && url && repoIdentity(url) === wanted) return name;
  }
  return undefined;
}

async function checkBranchName(branch: string): Promise<void> {
  if (branch.startsWith('-') || !(await git(process.cwd(), ['check-ref-format', '--branch', branch]).then(() => true, () => false))) {
    throw new PlacementFailure(`"${branch}" isn't a branch name git accepts, so nothing was placed.`);
  }
}

/** The worktree that has `branch` checked out, if any. */
async function worktreeOnBranch(repoPath: string, branch: string): Promise<string | undefined> {
  const listing = await git(repoPath, ['worktree', 'list', '--porcelain']);
  let current: string | undefined;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return undefined;
}

/** Points the local branch at `tip`, creating it or moving it forward; returns whether it was created. */
async function placeBranch(repoPath: string, branch: string, tip: string, machine: string): Promise<boolean> {
  const current = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '');
  if (!current) {
    await git(repoPath, ['branch', '--no-track', branch, tip]);
    return true;
  }
  if (current === tip) return false;
  const behind = await git(repoPath, ['merge-base', '--is-ancestor', current, tip]).then(() => true, () => false);
  if (!behind) {
    throw new PlacementFailure(`${machine} already has a ${branch} with commits the Mac's doesn't, so Pane left it alone. Rename one of them, then press Move again.`);
  }
  await git(repoPath, ['update-ref', `refs/heads/${branch}`, tip, current]);
  return false;
}

async function runSetup(repo: HostRepo, worktree: string, placement: HostWorkspacePlacement): Promise<HostPlacementResult['setup']> {
  const detected = repo.buildScript ? undefined : await detectProjectConfig(worktree, process.platform === 'darwin' ? 'macos' : 'linux');
  const script = repo.buildScript || detected?.setup;
  if (!script?.trim()) return undefined;
  const source = repo.buildScript ? 'Project Settings' : detected?.source ?? 'config';
  // Conductor's own variables, which its setup scripts read.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PANE_WORKSPACE_PATH: worktree,
    CONDUCTOR_WORKSPACE_NAME: placement.name,
    CONDUCTOR_WORKSPACE_PATH: worktree,
    CONDUCTOR_ROOT_PATH: repo.path,
  };
  if (placement.defaultBranch) env.CONDUCTOR_DEFAULT_BRANCH = placement.defaultBranch;
  const shell = process.env.SHELL || '/bin/sh';
  return new Promise(resolve => {
    execFile(shell, ['-c', script], { cwd: worktree, env, timeout: SETUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const tail = `${stdout}${stderr}`.trim().split('\n').slice(-5).join('\n');
      resolve(error ? { source, ok: false, detail: tail || reasonOf(error) } : { source, ok: true });
    });
  });
}

const STORE_PREFIX = { claude: 'projects/', codex: 'sessions/' } as const;

/**
 * Lays each chat's uploaded files out under `staging/<agent>/` as they sit in the agent's
 * store, so placement copies them into this machine's store at the same relative path. A chat
 * this machine already has keeps its own copy, since history may have continued here.
 */
async function stageChats(placement: HostWorkspacePlacement, staging: string, worktree: string, repoRoot: string, port: HostPlacementPort): Promise<ScannedSession[]> {
  const sessions: ScannedSession[] = [];
  for (const chat of placement.chats) {
    if (!/^[A-Za-z0-9._-]+$/u.test(chat.sessionId)) continue;
    const agentHome = path.join(staging, chat.agent);
    const store = chat.agent === 'claude' ? port.stores.claudeConfigDir : port.stores.codexHome;
    const already = chat.agent === 'claude' ? findClaudeTranscript(store, chat.sessionId) : findCodexTranscript(store, chat.sessionId);
    let main: string | undefined;
    for (const file of chat.files) {
      const relative = path.posix.normalize(file.path);
      if (!relative.startsWith(STORE_PREFIX[chat.agent]) || relative.split('/').includes('..') || path.isAbsolute(relative)) {
        throw new PlacementFailure(`A file for ${chat.agent} session ${chat.sessionId} would land outside its store (${file.path}), so nothing was placed.`);
      }
      const isMain = relative.endsWith(`${chat.sessionId}.jsonl`) && main === undefined;
      const uploaded = await port.uploadedFile(file.upload);
      if (isMain) {
        main = path.join(agentHome, ...relative.split('/'));
        fs.mkdirSync(path.dirname(main), { recursive: true });
        fs.copyFileSync(uploaded, main);
      } else if (!already) {
        // A subagent transcript beside the main one; placement copies only the main file.
        const destination = path.join(store, ...relative.split('/'));
        if (!fs.existsSync(destination)) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(uploaded, destination, fs.constants.COPYFILE_EXCL);
        }
      }
    }
    sessions.push({
      key: `${chat.agent}:${chat.sessionId}`,
      source: 'conductor',
      agent: chat.agent,
      sessionId: chat.sessionId,
      title: chat.title,
      branch: placement.branch,
      folder: worktree,
      checkout: worktree,
      repoRoot,
      lastActiveMs: 0,
      running: 'no',
      alreadyInPane: false,
      preselected: true,
      transcript: main ? { agentHome, path: main } : undefined,
    });
  }
  return sessions;
}

function safeName(name: string): string {
  return name.replace(SAFE_NAME, '-').replace(/^[-.]+/u, '') || 'workspace';
}

function freePath(wanted: string): string {
  let candidate = wanted;
  for (let index = 2; fs.existsSync(candidate); index += 1) candidate = `${wanted}-${index}`;
  return candidate;
}

function git(cwd: string, args: string[]): Promise<string> {
  return gitBuffer(cwd, args).then(output => output.toString('utf8').trim());
}

function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', timeout: GIT_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString('utf8').trim() || error.message));
      else resolve(stdout);
    });
  });
}

function gitWithInput(cwd: string, args: string[], input: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `git ${args[0]} exited ${code}`))));
    child.stdin.end(input);
  });
}
