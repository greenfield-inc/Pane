import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import type { SessionMoveCheck, SessionMoveFix, SessionMoveMark, SessionMoveRecord } from '../../../../shared/types/sessionMove';
import type { OrchestrationSessionRecord } from '../../../../shared/types/orchestrationSession';
import type { TerminalPausedMark, ToolPanel, ToolPanelType } from '../../../../shared/types/panels';
import { configuredAgent, isConfiguredAgent } from '../../../../shared/agents';
import { teammatePaneCaller, type PaneCommandRegistry } from '../../daemon/commandRegistry';
import type { AppServices } from '../../ipc/types';
import { getAppDirectory } from '../../utils/appDirectory';
import { getShellPath } from '../../utils/shellPath';
import { panelManager } from '../panelManager';
import { terminalPanelManager } from '../terminalPanelManager';
import { getChatTabManager } from '../chatTabs';
import { repositoryIdentityFromRemote } from '../repositoryIdentity';
import { sessionWorkspacePath } from '../sessionWorkspace';
import { thisMachineName } from '../approvals/approvalStore';
import { isBinaryFile } from '../../utils/binaryFile';
import { placeConversation, type PlacedConversation } from './conversations';
import { addWorktree, applySnapshot, deleteRefs, importBundle, MoveGitError, placeBranch, snapshotMatches } from './gitSnapshot';
import { moveManifestSchema, panelBuffersSchema, readTabFields, sessionMoveFixSchema, toJsonObject, type MoveManifest, type MovePane, type MoveRepo, type MoveTab } from './manifest';
import { buildPathMap, mapPath, rewriteText, type PathMap } from './pathMap';
import { MoveReceiver, type WriteRequest, type WriteResult } from './transfer';
import { isRegeneratedSessionFile, isTextFile } from './sessionFolder';
import { agentFarmProfileOf, movedLine } from './rules';

const run = promisify(execFile);

/** What the source sends before anything stops: the manifest without its package files. */
export const preflightRequestSchema = boundary.object({ manifest: moveManifestSchema });
export const moveIdRequestSchema = boundary.object({ moveId: boundary.nonEmptyString });
export const fixRequestSchema = boundary.object({ fix: sessionMoveFixSchema });

export interface FixResult {
  ok: true;
  message: string;
}

export interface TargetPreflight {
  machine: string;
  checks: SessionMoveCheck[];
  /** Each member Pane's branch tip here, when the branch exists, so the source can tell whether it diverged. */
  branchTips: Record<string, string>;
  home: string;
}

type TargetStage = 'receiving' | 'building' | 'built' | 'starting' | 'started' | 'failed' | 'aborted';

export interface TargetStatus {
  moveId: string;
  stage: TargetStage;
  detail?: string;
  /** Panes set up so far, of all. */
  panesDone: number;
  panesTotal: number;
  error?: { message: string; next: string };
  resumed?: number;
  failedTabs?: string[];
  approvals?: number;
  leftBehind?: string[];
  missingEnv?: string[];
  /** A failed start the source may ask for again. */
  retryable?: boolean;
}

interface Job {
  status: TargetStatus;
  /** When the source last wrote a chunk; a move left receiving this long without one is dropped. */
  lastWriteAt: number;
  manifest?: MoveManifest;
  map?: PathMap;
  /** Undo steps for everything this move made here, run in reverse on failure. */
  cleanup: Array<{ label: string; undo: () => Promise<void> }>;
  conversations: PlacedConversation[];
  /** Tabs to start, and their cwd here. */
  tabs: Array<{ paneId: string; tab: MoveTab; cwd: string }>;
  replacedSession?: OrchestrationSessionRecord;
  /** The build under way; abort waits for it to settle before undoing anything. */
  building?: Promise<void>;
  /** Set by abort: the build stops at its next step. */
  abortRequested?: boolean;
  /** Abort under way, so a second call waits for the same one. */
  aborting?: Promise<TargetStatus>;
  /** Start failed before any tab started; the source may ask again. */
  startFailed?: boolean;
}

/** The tabs the importer creates, replaces and releases: Pane's own panel and terminal managers, or a test's. */
export interface ImporterTabs {
  getPanel(panelId: string): ToolPanel | undefined;
  getPanelsForSession(paneId: string): ToolPanel[];
  createPanel(request: Parameters<typeof panelManager.createPanel>[0]): Promise<ToolPanel>;
  deletePanel(panelId: string): Promise<void>;
  isTerminalInitialized(panelId: string): boolean;
  destroyTerminal(panelId: string): Promise<void>;
  clearPaused(panelIds: string[]): Promise<void>;
  releaseChatMove(panelId: string): Promise<void>;
  /** Drops every tab of a Pane that is going away, permanent ones (Explorer, Diff) included. */
  forgetPaneTabs(paneId: string): Promise<void>;
}

const liveTabs: ImporterTabs = {
  getPanel: panelId => panelManager.getPanel(panelId),
  getPanelsForSession: paneId => panelManager.getPanelsForSession(paneId),
  createPanel: request => panelManager.createPanel(request),
  deletePanel: async panelId => { await panelManager.deletePanel(panelId); },
  isTerminalInitialized: panelId => terminalPanelManager.isTerminalInitialized(panelId),
  destroyTerminal: async panelId => { await terminalPanelManager.destroyTerminal(panelId); },
  clearPaused: async panelIds => { await terminalPanelManager.clearPaused(panelIds); },
  releaseChatMove: async panelId => { await getChatTabManager().releaseMove(panelId); },
  forgetPaneTabs: paneId => panelManager.cleanupSessionPanels(paneId),
};

const POSIX = new Set(['darwin', 'linux']);
/** How long a move may sit half-received with no new chunk before the target drops it. */
const RECEIVE_IDLE_MS = 10 * 60_000;

/** What failed and the next step, for the source's dialog. */
interface MoveFailure {
  message: string;
  next: string;
}

function moveError(error: Error | string): MoveFailure {
  if (error instanceof PaneError) return { message: error.message, next: error.next ?? 'Try again.' };
  return { message: reasonOf(error), next: 'Try again; if it repeats, check Pane on this machine.' };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, PATH: getShellPath() }, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try { return await git(cwd, args); } catch { return null; }
}

/** `<executable> --version`, or null when it isn't installed here. */
export async function cliVersion(executable: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const { stdout } = await run(executable, args, { env: { ...process.env, PATH: getShellPath() }, timeout: 15_000 });
    return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? (stdout.trim() || null);
  } catch {
    return null;
  }
}

/** Agent Farm profile versions from `agent-farm profiles list`, by qualified name. */
export async function agentFarmProfiles(): Promise<Record<string, string>> {
  try {
    const { stdout } = await run('agent-farm', ['profiles', 'list'], { env: { ...process.env, PATH: getShellPath() }, timeout: 20_000 });
    const profiles: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      const match = /^(\S+)\s.*\|\s*plugin\s+\S+\s+(\d[\w.-]*)/.exec(line.trim());
      if (match) profiles[match[1]] = match[2];
    }
    return profiles;
  } catch {
    return {};
  }
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}


/**
 * Sessions move only between one person's own machines: every move call, on the source and on the
 * target, refuses a teammate admitted through a shared tailnet.
 */
export function refuseTeammateMove(): void {
  const teammate = teammatePaneCaller();
  if (teammate) {
    throw new PaneError('ERR_MOVE_TEAMMATE', `${teammate} asked to move a Session on this machine, and Sessions move only between one person's own machines. Nothing was changed.`, 'Hand the work over with a note instead.');
  }
}

/** A Session-folder file that reads as UTF-8 text all the way through; anything else travels byte for byte. */
async function readTextFile(file: string, relative: string): Promise<string | null> {
  if (!isTextFile(relative) || await isBinaryFile(file)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await fs.promises.readFile(file));
  } catch {
    return null;
  }
}

const ABORTED = (): PaneError => new PaneError('ERR_MOVE_ABORTED', 'The move was cancelled while this machine set it up.', 'Nothing was kept here. Start the move again.');

function tabCommand(tab: MoveTab): string | undefined {
  return readTabFields(tab.state).launch;
}

/**
 * The target's side of a Session move. It checks a manifest, receives the package into its
 * staging folder, builds the Session as Arriving with no tab running, starts the tabs once the
 * source has frozen, and removes everything it made if the move fails before then.
 */
export class MoveImporter {
  private readonly jobs = new Map<string, Job>();
  readonly receiver: MoveReceiver;

  constructor(
    private readonly services: AppServices,
    private readonly registry: PaneCommandRegistry,
    private readonly root = path.join(getAppDirectory(), 'moves'),
    private readonly tabs: ImporterTabs = liveTabs,
  ) {
    this.receiver = new MoveReceiver(root);
    // Staging left by a move that was under way when Pane quit can't be finished: it goes.
    fs.rmSync(root, { recursive: true, force: true });
    setInterval(() => void this.dropAbandoned(), RECEIVE_IDLE_MS / 4).unref();
  }

  /** A source that stopped sending (contact lost mid-send) never comes back for this move; its staging goes. */
  private async dropAbandoned(now = Date.now()): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status.stage === 'receiving' && now - job.lastWriteAt > RECEIVE_IDLE_MS) {
        console.warn(`[SessionMove] Move ${job.status.moveId} stopped arriving; its staging folder was removed.`);
        await this.receiver.remove(job.status.moveId).catch(() => undefined);
        job.status = { ...job.status, stage: 'aborted', error: { message: 'The other machine stopped sending this move.', next: 'Start the move again.' } };
      }
    }
  }

  private refuseTeammate(): void {
    refuseTeammateMove();
  }

  private job(moveId: string): Job {
    const job = this.jobs.get(moveId);
    if (!job) throw new PaneError('ERR_MOVE_UNKNOWN', `This machine has no move ${moveId} in progress.`, 'Start the move again from the other machine.');
    return job;
  }

  private projects() {
    return this.services.databaseService.getAllProjects();
  }

  /** This machine's project for a repository: same remote identity, else the same remote URL, else (no remote) the same folder. */
  private async findProject(repo: Pick<MoveRepo, 'identity' | 'remote' | 'root'>) {
    for (const project of this.projects()) {
      const remote = await tryGit(project.path, ['remote', 'get-url', 'origin']);
      if (repo.identity && remote && repositoryIdentityFromRemote(remote) === repo.identity) return project;
      if (repo.remote && remote === repo.remote) return project;
      if (!repo.remote && project.path === repo.root) return project;
    }
    return undefined;
  }

  // ── Preflight ──────────────────────────────────────────────────────────

  async preflight(manifest: MoveManifest): Promise<TargetPreflight> {
    this.refuseTeammate();
    const machine = thisMachineName();
    const home = os.homedir();
    const checks: SessionMoveCheck[] = [];
    const branchTips: Record<string, string> = {};
    if (!POSIX.has(process.platform)) {
      checks.push({ id: 'platform', level: 'block', title: `${machine} runs ${process.platform}`, detail: 'A whole Session moves only between macOS and Linux machines. Hand it off with a note instead.' });
    }
    const sessionId = decodeOptionalBoundary(manifest.session.id, boundary.nonEmptyString) ?? '';
    const existing = (await this.services.orchestrationSessionManager?.list())?.sessions.find(session => session.id === sessionId);
    if (existing && existing.move?.state !== 'moved') {
      checks.push({ id: 'session', level: 'block', title: `${machine} already has this Session`, detail: `“${existing.name}” there has the same ID${existing.move?.state === 'arriving' ? ' and is arriving from another move' : ''}. Archive or remove it there, then move again.` });
    }

    // Repositories: matched by remote, else offered a clone to the same place under home.
    const repos = new Map<string, { pane: MovePane; found: boolean; path?: string }>();
    for (const pane of manifest.panes.filter(item => item.role === 'member' && item.repo)) {
      const repo = pane.repo!;
      const key = repo.identity ?? repo.root;
      if (repos.has(key)) continue;
      const project = await this.findProject(repo);
      repos.set(key, { pane, found: !!project, path: project?.path });
      if (!project) {
        const suggested = path.join(home, repo.relativeToHome ?? path.join('repos', repo.name));
        if (repo.remote) {
          checks.push({ id: `repo:${key}`, level: 'block', title: `${repo.identity ?? repo.name} isn't on ${machine}`, detail: `Pane “${pane.name}” uses it. Clone it to ${suggested.replace(home, '~')}, the same place as on ${manifest.source.machine}?`, fix: { kind: 'clone', label: 'Clone', remote: repo.remote, path: suggested } });
        } else {
          checks.push({ id: `repo:${key}`, level: 'block', title: `${repo.name} isn't on ${machine}`, detail: `Pane “${pane.name}” uses it, and it has no origin to clone from. Add it to Pane on ${machine} first.` });
        }
        continue;
      }
      checks.push({ id: `repo:${key}`, level: 'ok', title: `Repository ${repo.identity ?? repo.name} found` });
    }
    // Branches and worktree folders for each member Pane in a found repository.
    for (const pane of manifest.panes.filter(item => item.role === 'member' && item.repo)) {
      const found = repos.get(pane.repo!.identity ?? pane.repo!.root);
      if (!found?.found || !found.path) continue;
      if (pane.branch) {
        const tip = await tryGit(found.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${pane.branch}`]);
        if (tip) branchTips[pane.id] = tip;
        const list = await tryGit(found.path, ['worktree', 'list', '--porcelain']) ?? '';
        const checkedOut = list.split('\n\n').find(block => block.includes(`branch refs/heads/${pane.branch}\n`) || block.endsWith(`branch refs/heads/${pane.branch}`));
        if (checkedOut) {
          const at = /^worktree (.+)$/m.exec(checkedOut)?.[1] ?? 'another folder';
          checks.push({ id: `branch:${pane.id}`, level: 'block', title: `Branch ${pane.branch} is checked out on ${machine}`, detail: `It is checked out at ${at} there, so Pane “${pane.name}” can't get its own worktree. Switch that folder to another branch, then check again.` });
        }
      }
    }

    // Agents and Agent Farm profiles.
    const agents = new Set(manifest.panes.flatMap(pane => pane.tabs.flatMap(tab => readTabFields(tab.state).agentId ?? [])));
    const installed: string[] = [];
    for (const agent of agents) {
      if (!isConfiguredAgent(agent)) continue;
      const config = configuredAgent(agent);
      const version = await cliVersion(config.executables[0]);
      const theirs = manifest.source.agentVersions[agent];
      if (!version) {
        checks.push({ id: `agent:${agent}`, level: 'block', title: `${config.title} isn't installed on ${machine}`, detail: `Its tabs can't resume there. Install it with ${config.install.command}, then check again.` });
      } else if (theirs && compareVersions(version, theirs) < 0) {
        checks.push({ id: `agent:${agent}`, level: 'warning', title: `${config.title} is ${version} on ${machine}, ${theirs} on ${manifest.source.machine}`, detail: `An older ${config.title} may not read conversations the newer one wrote. Update it on ${machine} to match.` });
        installed.push(config.title);
      } else {
        installed.push(config.title);
      }
    }
    const wantedProfiles = Object.entries(manifest.source.profiles);
    if (wantedProfiles.length) {
      const here = await agentFarmProfiles();
      for (const [profile, version] of wantedProfiles) {
        if (!here[profile]) {
          checks.push({ id: `profile:${profile}`, level: 'block', title: `Agent Farm profile ${profile} isn't on ${machine}`, detail: `Tabs launched with it can't resume there. Install its plugin with agent-farm plugin install on ${machine}, then check again.` });
        } else if (version && here[profile] !== version) {
          checks.push({ id: `profile:${profile}`, level: 'warning', title: `${profile} is ${here[profile]} there, ${version} here`, detail: `Tabs resume with ${here[profile]}. Update Agent Farm on ${machine} to match.` });
        } else {
          installed.push(`Agent Farm ${profile}${version ? ` ${version}` : ''}`);
        }
      }
      // Agent Farm stops untrusted workspaces: each repository its tabs use must be trusted here.
      for (const found of repos.values()) {
        if (!found.found || !found.path) continue;
        if (!found.pane.tabs.some(tab => agentFarmProfileOf(tabCommand(tab)))) continue;
        const trust = await this.agentFarmTrust(found.path);
        if (trust === 'untrusted') {
          checks.push({ id: `trust:${found.path}`, level: 'block', title: `Agent Farm doesn't trust ${path.basename(found.path)} there`, detail: `Agent Farm stops untrusted workspaces. Trusting runs agent-farm workspace trust on ${machine}.`, fix: { kind: 'trust', label: 'Trust', path: found.path } });
        }
      }
    }
    if (installed.length) checks.push({ id: 'agents', level: 'ok', title: `Agents: ${installed.join(', ')}` });

    // Env var names set on the source that this machine's matching projects lack (values never travel).
    const missing = new Set<string>();
    for (const found of repos.values()) {
      if (!found.found || !found.path) continue;
      const project = this.projects().find(item => item.path === found.path);
      const here = new Set(project ? this.services.databaseService.getProjectEnvVars(project.id).map(variable => variable.key) : []);
      for (const name of manifest.source.envNames) if (!here.has(name)) missing.add(name);
    }
    if (missing.size) {
      checks.push({ id: 'env', level: 'warning', title: `${missing.size === 1 ? '1 env var isn\'t' : `${missing.size} env vars aren't`} set on ${machine}`, detail: `${[...missing].join(', ')}. Tabs that need them will see them missing.` });
    }
    return { machine, checks, branchTips, home };
  }

  private async agentFarmTrust(repoPath: string): Promise<'trusted' | 'untrusted' | 'unknown'> {
    try {
      const { stdout } = await run('agent-farm', ['workspace', 'show'], { cwd: repoPath, env: { ...process.env, PATH: getShellPath() }, timeout: 20_000 });
      const trust = /"trust":\s*"([a-z-]+)"/.exec(stdout)?.[1];
      return trust === 'trusted' ? 'trusted' : trust ? 'untrusted' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async fix(fix: SessionMoveFix): Promise<FixResult> {
    this.refuseTeammate();
    if (fix.kind === 'trust') {
      try {
        await run('agent-farm', ['workspace', 'trust'], { cwd: fix.path, env: { ...process.env, PATH: getShellPath() }, timeout: 60_000 });
      } catch (error) {
        throw new PaneError('ERR_MOVE_TRUST_FAILED', `agent-farm workspace trust didn't finish in ${fix.path}: ${reasonOf(error)}`, `Run agent-farm workspace trust in ${fix.path} on ${thisMachineName()}, then check again.`);
      }
      return { ok: true, message: `Trusted ${fix.path}.` };
    }
    const parent = path.dirname(fix.path);
    await fs.promises.mkdir(parent, { recursive: true });
    const cloned = decodeBoundary(await this.registry.invoke('git:clone-repo', [fix.remote, parent]), boundary.object({ success: boundary.boolean, data: boundary.optional(boundary.object({ clonedPath: boundary.string })), error: boundary.optional(boundary.string) }));
    if (!cloned.success || !cloned.data) {
      throw new PaneError('ERR_MOVE_CLONE_FAILED', `Cloning ${fix.remote} into ${parent} failed: ${(cloned.error ?? 'git clone failed').replace(/\.+$/, '')}`, 'Clone it by hand, add it to Pane, then check again.');
    }
    const created = decodeBoundary(await this.registry.invoke('projects:create', [{ name: path.basename(cloned.data.clonedPath), path: cloned.data.clonedPath }]), boundary.object({ success: boundary.boolean, error: boundary.optional(boundary.string) }));
    if (!created.success) {
      throw new PaneError('ERR_MOVE_PROJECT_FAILED', `Cloned ${fix.remote}, but adding it to Pane failed: ${created.error ?? 'unknown error'}`, `Add ${cloned.data.clonedPath} to Pane, then check again.`);
    }
    return { ok: true, message: `Cloned to ${cloned.data.clonedPath}.` };
  }

  // ── Receive ────────────────────────────────────────────────────────────

  async write(parsed: WriteRequest): Promise<WriteResult> {
    this.refuseTeammate();
    if (!this.jobs.has(parsed.moveId)) {
      this.jobs.set(parsed.moveId, { status: { moveId: parsed.moveId, stage: 'receiving', panesDone: 0, panesTotal: 0 }, lastWriteAt: Date.now(), cleanup: [], conversations: [], tabs: [] });
    }
    const job = this.job(parsed.moveId);
    job.lastWriteAt = Date.now();
    if (job.status.stage !== 'receiving') throw new PaneError('ERR_MOVE_STAGE', `Move ${parsed.moveId} is past receiving (${job.status.stage}).`, 'Start the move again.');
    return this.receiver.write(parsed);
  }

  async status(moveId: string): Promise<TargetStatus> {
    const job = this.jobs.get(moveId);
    if (job) return { ...job.status };
    // Pane restarted since: a Session this move started here says so in its moved.json.
    for (const session of (await this.services.orchestrationSessionManager?.list())?.sessions ?? []) {
      if (session.move?.state === 'arriving') continue;
      const record = await fs.promises.readFile(path.join(sessionWorkspacePath(session.id), 'moved.json'), 'utf8').catch(() => '');
      if (decodeOptionalBoundary(record ? JSON.parse(record) : null, boundary.object({ moveId: boundary.string }))?.moveId === moveId) {
        return { moveId, stage: 'started', panesDone: 0, panesTotal: 0, resumed: 0, failedTabs: [] };
      }
    }
    return { moveId, stage: 'aborted', panesDone: 0, panesTotal: 0, error: { message: 'This machine has no record of the move (Pane may have restarted).', next: 'Start the move again.' } };
  }

  // ── Build ──────────────────────────────────────────────────────────────

  /** Starts building in the background; the source polls status until built or failed. */
  build(moveId: string): TargetStatus {
    this.refuseTeammate();
    const job = this.job(moveId);
    if (job.status.stage !== 'receiving') return { ...job.status };
    job.status = { ...job.status, stage: 'building', detail: 'Checking the package' };
    job.building = this.runBuild(job).catch(async error => {
      if (job.abortRequested) return; // abort undoes it, once this settles
      console.error(`[SessionMove] Build of ${moveId} failed:`, error);
      await this.rollBack(job);
      job.status = { ...job.status, stage: 'failed', error: moveError(error) };
    });
    return { ...job.status };
  }

  private async runBuild(job: Job): Promise<void> {
    const moveId = job.status.moveId;
    const step = () => { if (job.abortRequested) throw ABORTED(); };
    const manifestPath = this.receiver.filePath(moveId, 'manifest.json');
    const manifest = decodeBoundary(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')), moveManifestSchema);
    job.manifest = manifest;
    for (const file of manifest.files) {
      if (!(await this.receiver.verify(moveId, file))) {
        throw new PaneError('ERR_MOVE_DIGEST_MISMATCH', `${file.path} is missing or doesn't match ${manifest.source.machine}'s copy.`, 'Nothing was set up here. Try the move again.');
      }
    }
    // Open approvals don't move yet (the source refuses them); a package with any is refused here too.
    if (manifest.approvals.length) {
      throw new PaneError('ERR_MOVE_APPROVALS_OPEN', `${manifest.approvals.length} open approval${manifest.approvals.length === 1 ? '' : 's'} came with the move, and approvals can't move yet.`, 'Answer them on the other machine, then move again.');
    }
    const members = manifest.panes.filter(pane => pane.role === 'member');
    job.status.panesTotal = members.length;
    const sessionsDb = this.services.databaseService;
    const record = manifest.session;
    const sessionId = decodeBoundary(record.id, boundary.nonEmptyString);

    // The path map: each worktree and repository, the Pane folder, then home.
    const entries: Array<{ from: string; to: string }> = [{ from: manifest.source.paneDir, to: getAppDirectory() }];
    const placements = new Map<string, { projectId: number; projectPath: string; worktreePath: string }>();
    for (const pane of members) {
      if (!pane.repo) continue;
      const project = await this.findProject(pane.repo);
      if (!project) throw new PaneError('ERR_MOVE_REPO_MISSING', `${pane.repo.identity ?? pane.repo.name} isn't on this machine.`, 'Clone it from the Move dialog, then move again.');
      const ctx = this.services.sessionManager.getProjectContextByProjectId(project.id);
      if (!ctx) throw new PaneError('ERR_MOVE_REPO_CONTEXT', `Pane can't open project ${project.name} here.`, 'Open the project in Pane once, then move again.');
      const worktreePath = this.services.worktreeManager.getWorktreePath(project.path, pane.worktreeName || path.basename(pane.worktreePath), project.worktree_folder || undefined, ctx.pathResolver);
      placements.set(pane.id, { projectId: project.id, projectPath: project.path, worktreePath });
      entries.push({ from: pane.worktreePath, to: worktreePath }, { from: pane.repo.root, to: project.path });
    }
    const sourceFolder = manifest.sessionFolder.root;
    const targetFolder = sessionWorkspacePath(sessionId);
    entries.push({ from: sourceFolder, to: targetFolder });
    const map = buildPathMap({ sourceHome: manifest.source.home, targetHome: os.homedir(), entries });
    job.map = map;

    // Panes: worktree on the same branch, uncommitted work reapplied and checked, then setup.
    const leftBehind: string[] = [];
    // Every Pane settles before the build goes on or fails, so clean-up never races a sibling still setting up.
    const settled = await Promise.allSettled(members.map(async pane => {
      step();
      const placement = placements.get(pane.id);
      if (!placement || !pane.bundle || !pane.snapshot) return;
      job.status.detail = `Setting up ${pane.name}`;
      const repo = placement.projectPath;
      const incomingPrefix = `refs/pane/move-incoming/${pane.id}`;
      job.cleanup.push({ label: `refs for ${pane.name}`, undo: () => deleteRefs(repo, incomingPrefix) });
      const bundle = this.receiver.filePath(moveId, pane.bundle);
      // Moving back: the snapshot an earlier move left here (for Restore) comes back if this one fails.
      const previousSnapshot = await tryGit(repo, ['rev-parse', '--verify', '--quiet', pane.snapshot.ref]);
      const imported = await importBundle(repo, bundle, { branch: pane.branch, snapshotRef: pane.snapshot.ref, incomingPrefix });
      job.cleanup.push({ label: `snapshot of ${pane.name}`, undo: async () => {
        if (previousSnapshot) await tryGit(repo, ['update-ref', pane.snapshot!.ref, previousSnapshot]);
        else await tryGit(repo, ['update-ref', '-d', pane.snapshot!.ref]);
      } });
      step();
      if (pane.branch && imported.branchHead) {
        const before = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${pane.branch}`]);
        try {
          await placeBranch(repo, pane.branch, `${incomingPrefix}/branch`);
        } catch (error) {
          if (error instanceof MoveGitError && error.code === 'ERR_MOVE_BRANCH_DIVERGED') {
            const extra = error.details.extraCommits ?? 0;
            throw new PaneError('ERR_MOVE_BRANCH_DIVERGED', `${thisMachineName()} couldn't create the worktree for Pane “${pane.name}”: branch ${pane.branch} already exists there with ${extra} commit${extra === 1 ? '' : 's'} ${manifest.source.machine} doesn't have.`, `Push or delete branch ${pane.branch} on ${thisMachineName()}, then try again.`);
          }
          throw error;
        }
        job.cleanup.push({ label: `branch ${pane.branch}`, undo: async () => {
          if (before) await tryGit(repo, ['update-ref', `refs/heads/${pane.branch}`, before]);
          else await tryGit(repo, ['branch', '-D', pane.branch!]);
        } });
      }
      if (fs.existsSync(placement.worktreePath)) {
        throw new PaneError('ERR_MOVE_WORKTREE_EXISTS', `${placement.worktreePath} already exists on ${thisMachineName()}, so Pane “${pane.name}” can't get its worktree there.`, 'Move or remove that folder, then try again.');
      }
      await addWorktree(repo, placement.worktreePath, pane.branch, imported.snapshot ? (await git(repo, ['rev-parse', `${imported.snapshot}^1`])) : (pane.head ?? 'HEAD'));
      job.cleanup.push({ label: `worktree ${placement.worktreePath}`, undo: async () => {
        await tryGit(repo, ['worktree', 'remove', '--force', placement.worktreePath]);
        await fs.promises.rm(placement.worktreePath, { recursive: true, force: true });
        await tryGit(repo, ['worktree', 'prune']);
      } });
      await applySnapshot(placement.worktreePath, imported.snapshot);
      // Checked right after reapplying and before setup, which may change tracked files itself.
      if (!(await snapshotMatches(placement.worktreePath, imported.snapshot))) {
        throw new PaneError('ERR_MOVE_SNAPSHOT_MISMATCH', `The uncommitted work of Pane “${pane.name}” didn't come out the same on ${thisMachineName()}.`, 'Nothing was kept here. Try the move again.');
      }
      for (const entry of pane.ignored) leftBehind.push(`${entry} in ${pane.name}`);
      step();
      // Moving a Session back: the archived Pane left here by the earlier move gives way to the
      // arriving one, and comes back, with its tabs, if this move fails.
      if (this.services.databaseService.getSession(pane.id)?.archived) await this.setAsideArchivedPane(job, pane.id);
      const created = this.services.sessionManager.createSessionWithId(
        pane.id, pane.name, placement.worktreePath,
        pane.record.prompt,
        pane.worktreeName,
        pane.record.permissionMode === 'approve' ? 'approve' : 'ignore',
        placement.projectId, false, undefined,
        pane.record.noTool ? 'none' : undefined,
        pane.baseCommit ?? undefined, pane.baseBranch ?? undefined, false,
      );
      job.cleanup.push({ label: `Pane ${pane.name}`, undo: () => this.removePane(created.id) });
      // Shown at once, the way a new Pane is (no reload), without taking focus; its own tabs follow.
      this.services.sessionManager.emitSessionCreated(created, { activateOnCreate: false, createDefaultTerminalOnCreate: false });
      if (pane.layout) sessionsDb.setSessionPanelLayout(pane.id, rewriteText(map, pane.layout));
      const ctx = this.services.sessionManager.getProjectContextByProjectId(placement.projectId);
      const project = this.projects().find(item => item.id === placement.projectId);
      if (ctx && project && this.services.taskQueue) {
        job.status.detail = `${pane.name}: setup`;
        await this.services.taskQueue.runWorktreeSetup(created, project, placement.worktreePath, ctx);
      }
      // Set up and waiting for its tabs, as a new Pane is once its setup ends.
      await this.services.sessionManager.updateSession(created.id, { status: 'stopped', statusMessage: undefined });
      job.status.panesDone += 1;
    }));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    step();

    // The Session folder: text files rewritten for this machine's paths, others byte for byte.
    job.status.detail = 'Restoring the Session folder';
    const hadFolder = fs.existsSync(targetFolder);
    const backup = `${targetFolder}.pane-move-${moveId}`;
    if (hadFolder) {
      await fs.promises.rename(targetFolder, backup);
      job.cleanup.push({ label: 'Session folder', undo: async () => { await fs.promises.rm(targetFolder, { recursive: true, force: true }); await fs.promises.rename(backup, targetFolder); } });
    } else {
      job.cleanup.push({ label: 'Session folder', undo: () => fs.promises.rm(targetFolder, { recursive: true, force: true }) });
    }
    for (const relative of manifest.sessionFolder.files) {
      if (isRegeneratedSessionFile(relative)) continue;
      const source = this.receiver.filePath(moveId, `session/${relative}`);
      const target = path.join(targetFolder, ...relative.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const text = await readTextFile(source, relative);
      if (text === null) await fs.promises.copyFile(source, target);
      else await fs.promises.writeFile(target, rewriteText(map, text));
    }
    const moved: SessionMoveRecord = {
      moveId, from: manifest.source.machine, to: thisMachineName(), at: new Date().toISOString(), paths: map.entries,
      working: manifest.panes.flatMap(pane => pane.tabs.filter(tab => tab.working).map(tab => tab.title)),
      interrupted: manifest.panes.flatMap(pane => pane.tabs.filter(tab => tab.interrupted).map(tab => tab.title)),
      leftBehind,
    };
    await fs.promises.mkdir(targetFolder, { recursive: true });
    await fs.promises.writeFile(path.join(targetFolder, 'moved.json'), `${JSON.stringify(moved, null, 2)}\n`);

    // The Session record, with the same ID, marked arriving; then its owner Pane.
    const manager = this.services.orchestrationSessionManager;
    if (!manager) throw new PaneError('ERR_MOVE_NO_SESSIONS', 'Sessions are not available on this machine.', 'Update Pane, then try again.');
    const existing = (await manager.list()).sessions.find(session => session.id === sessionId);
    if (existing?.move?.state === 'moved') job.replacedSession = existing;
    const arrivingMark: SessionMoveMark = { state: 'arriving', machine: manifest.source.machine, moveId, at: new Date().toISOString() };
    // SAFETY: the source's own OrchestrationSessionRecord with only its path strings rewritten; the store sanitises every field when it reads it back.
    const arriving = JSON.parse(rewriteText(map, JSON.stringify(record))) as OrchestrationSessionRecord;
    arriving.move = arrivingMark;
    arriving.associations = arriving.associations.filter(association => !association.machine);
    // Moving back: the copy that moved away keeps its owner Pane (archiving and recreating a live
    // Pane would let its teardown remove the arriving tabs); only its old tabs give way.
    step();
    if (existing) {
      for (const panel of this.tabs.getPanelsForSession(existing.internalSessionId)) await this.setAsidePanel(job, panel);
    }
    await manager.importArriving(arriving);
    job.cleanup.push({ label: 'Session record', undo: () => manager.removeArriving(sessionId, job.replacedSession) });

    // Tabs: the same IDs, titles, order and split, stopped and marked arriving; conversations filed here.
    job.status.detail = 'Filing conversations';
    const arrivingPause: TerminalPausedMark = { at: new Date().toISOString(), by: 'move', machine: manifest.source.machine, arriving: true };
    for (const pane of manifest.panes) {
      const paneId = pane.role === 'owner' ? arriving.internalSessionId : pane.id;
      const cwd = pane.role === 'owner' ? targetFolder : placements.get(pane.id)?.worktreePath;
      if (!cwd) continue;
      for (const tab of pane.tabs) {
        const state = decodeBoundary(JSON.parse(rewriteText(map, JSON.stringify(tab.state))), boundary.jsonObject);
        const paused: JsonObject = { at: arrivingPause.at, by: 'move', machine: manifest.source.machine, arriving: true };
        if (tab.type === 'terminal') {
          state.cwd = cwd;
          state.isInitialized = false;
          delete state.conversationReport;
          const { resumeDirectory } = readTabFields(state);
          if (resumeDirectory) state.resumeDirectory = mapPath(map, resumeDirectory) ?? cwd;
          if (tab.interrupted) paused.interrupted = true;
          state.paused = paused;
        } else if (tab.type === 'chat') {
          state.cwd = cwd;
          state.status = 'starting';
          delete state.problem;
          delete state.turn;
          state.paused = paused;
        }
        if (tab.buffers) {
          const buffers = decodeBoundary(JSON.parse(await fs.promises.readFile(this.receiver.filePath(moveId, tab.buffers), 'utf8')), panelBuffersSchema);
          if (buffers.scrollback) state.scrollbackBuffer = buffers.scrollback;
          if (buffers.serialized) state.serializedBuffer = buffers.serialized;
          if (buffers.alternate) state.alternateScreenBuffer = buffers.alternate;
        }
        if (tab.conversation) {
          const placed = await placeConversation(tab.conversation, packagePath => this.receiver.filePath(moveId, packagePath), cwd, { here: thisMachineName(), source: manifest.source.machine });
          job.conversations.push(placed);
          job.cleanup.push({ label: `conversation ${tab.conversation.id}`, undo: () => placed.undo() });
        }
        const existingPanel = this.tabs.getPanel(tab.id);
        if (existingPanel) await this.setAsidePanel(job, existingPanel);
        await this.tabs.createPanel({
          id: tab.id, sessionId: paneId,
          // SAFETY: the type is the source's own panel record's ToolPanelType, from a Pane of the same manifest version.
          type: tab.type as ToolPanelType,
          title: tab.title,
          initialState: { customState: state },
          metadata: tab.metadata,
          activate: false,
        });
        job.cleanup.push({ label: `tab ${tab.title}`, undo: async () => { await this.tabs.deletePanel(tab.id).catch(() => undefined); } });
        job.tabs.push({ paneId, tab, cwd });
      }
    }
    const owner = manifest.panes.find(pane => pane.role === 'owner');
    if (owner?.layout) sessionsDb.setSessionPanelLayout(arriving.internalSessionId, rewriteText(map, owner.layout));

    step();
    // The incoming refs did their job once the branches are placed; the snapshot refs stay for Restore.
    for (const pane of members) {
      const placement = placements.get(pane.id);
      if (placement) await deleteRefs(placement.projectPath, `refs/pane/move-incoming/${pane.id}`).catch(() => undefined);
    }
    job.status = { ...job.status, stage: 'built', detail: undefined, approvals: 0, leftBehind, missingEnv: manifest.source.envNames.filter(name => !this.envNamesHere().has(name)) };
  }

  private envNamesHere(): Set<string> {
    return new Set(this.projects().flatMap(project => this.services.databaseService.getProjectEnvVars(project.id).map(variable => variable.key)));
  }

  /** Removes a tab that gives way to an arriving one; a failed move puts it back as it was. */
  private async setAsidePanel(job: Job, panel: ToolPanel): Promise<void> {
    if (this.tabs.isTerminalInitialized(panel.id)) await this.tabs.destroyTerminal(panel.id).catch(() => undefined);
    await this.tabs.deletePanel(panel.id);
    job.cleanup.push({ label: `earlier tab ${panel.title}`, undo: () => this.putBackPanel(panel) });
  }

  private async putBackPanel(panel: ToolPanel): Promise<void> {
    await this.tabs.createPanel({
      id: panel.id, sessionId: panel.sessionId, type: panel.type, title: panel.title,
      initialState: { customState: panel.state.customState ?? {} },
      metadata: panel.metadata, activate: false,
    });
  }

  /**
   * Moving back: the archived Pane an earlier move left here (what Restore here brings back) gives
   * way to the arriving Pane of the same ID. A failed move recreates it, archived, with its tabs and
   * layout; its old output log does not come back.
   */
  private async setAsideArchivedPane(job: Job, paneId: string): Promise<void> {
    const db = this.services.databaseService;
    const row = db.getSession(paneId);
    if (!row) return;
    const panels = this.tabs.getPanelsForSession(paneId);
    const layout = db.getSessionPanelLayout(paneId);
    await this.removePane(paneId);
    job.cleanup.push({ label: `archived Pane ${row.name}`, undo: async () => {
      const recreated = this.services.sessionManager.createSessionWithId(
        row.id, row.name, row.worktree_path, row.initial_prompt ?? '', row.worktree_name,
        row.permission_mode === 'approve' ? 'approve' : 'ignore',
        row.project_id ?? undefined, false, row.folder_id ?? undefined,
        row.tool_type === 'none' ? 'none' : undefined,
        row.base_commit ?? undefined, row.base_branch ?? undefined, false,
      );
      for (const panel of panels) await this.putBackPanel(panel);
      if (layout) db.setSessionPanelLayout(recreated.id, layout);
      await this.services.sessionManager.archiveSession(recreated.id);
    } });
  }

  private async removePane(paneId: string): Promise<void> {
    const db = this.services.databaseService;
    // deletePanel keeps permanent tabs; left cached, they would stand in for the arriving Pane's own.
    await this.tabs.forgetPaneTabs(paneId).catch(error => console.warn(`[SessionMove] Pane ${paneId}'s tabs weren't cleared:`, error));
    if (this.services.sessionManager.getSession(paneId)) await this.services.sessionManager.archiveSession(paneId).catch(() => undefined);
    if (db.getSession(paneId) && !db.getSession(paneId)?.archived) db.archiveSession(paneId);
    db.deleteArchivedSessionPermanently(paneId);
  }

  private async rollBack(job: Job): Promise<void> {
    for (const step of [...job.cleanup].reverse()) {
      try {
        await step.undo();
      } catch (error) {
        console.error(`[SessionMove] Clean-up of ${step.label} failed:`, error);
      }
    }
    job.cleanup = [];
    await this.receiver.remove(job.status.moveId).catch(() => undefined);
  }

  /** Before start only: removes everything this move made here. */
  async abort(moveId: string): Promise<TargetStatus> {
    const job = this.jobs.get(moveId);
    if (!job) return { moveId, stage: 'aborted', panesDone: 0, panesTotal: 0 };
    if (job.status.stage === 'starting' || job.status.stage === 'started' || job.startFailed) {
      throw new PaneError('ERR_MOVE_STARTED', 'The Session already started here, so the move can no longer be undone.', 'Use the Session here.');
    }
    job.aborting ??= (async () => {
      // A build still running stops at its next step, and settles before anything is undone.
      job.abortRequested = true;
      await job.building;
      await this.rollBack(job);
      job.status = { ...job.status, stage: 'aborted', detail: undefined };
      return { ...job.status };
    })();
    return job.aborting;
  }

  // ── Start ──────────────────────────────────────────────────────────────

  /** After the source froze: shows the Session and starts every tab on its conversation. */
  start(moveId: string): TargetStatus {
    this.refuseTeammate();
    const job = this.job(moveId);
    // A start that failed before any tab started may be asked again (the source's Check again).
    const retry = job.startFailed && job.status.stage === 'failed';
    if ((job.status.stage !== 'built' && !retry) || job.abortRequested) return { ...job.status };
    job.status = { ...job.status, stage: 'starting', detail: 'Resuming tabs', error: undefined, retryable: undefined };
    void this.runStart(job).catch(error => {
      // The Session isn't usable here yet, so the source must not retire its copy.
      console.error(`[SessionMove] Start of ${moveId} failed:`, error);
      job.startFailed = true;
      const failure = moveError(error);
      job.status = { ...job.status, stage: 'failed', detail: undefined, retryable: true, error: { message: `The Session didn't start on ${thisMachineName()}: ${failure.message}`, next: 'It stays paused on both machines. Check again to retry.' } };
    });
    return { ...job.status };
  }

  private async runStart(job: Job): Promise<void> {
    const manifest = job.manifest!;
    const sessionId = String(manifest.session.id);
    const manager = this.services.orchestrationSessionManager!;
    // From here the move is committed: no undo, the previous copies kept for it go.
    job.cleanup = [];
    for (const placed of job.conversations) await placed.commit().catch(error => console.warn('[SessionMove] Commit of a conversation failed:', error));
    await manager.setMoveMark(sessionId, undefined, `Moved here from ${manifest.source.machine}.`);
    const failedTabs: string[] = [];
    let resumed = 0;
    const line = movedLine(manifest.source.machine, thisMachineName(), job.map!);
    const orchestratorPanels = new Set(Object.values(decodeBoundary(manifest.session.panelIds ?? {}, boundary.jsonObject)));
    const told: Array<{ panelId: string; title: string; input: string }> = [];
    for (const { tab } of job.tabs) {
      if (tab.type !== 'terminal' && tab.type !== 'chat') continue;
      // Every agent tab starts on its conversation; a plain shell starts only if it was running there.
      const isAgent = tab.type === 'chat' || !!readTabFields(tab.state).agentId;
      try {
        if (!isAgent && !tab.running) {
          await this.tabs.clearPaused([tab.id]);
          continue;
        }
        await this.releaseTab(tab.id, tab.type);
        if (tab.type === 'terminal') await this.registry.invoke('runpane:panels:resume', [{ panelId: tab.id }]);
        const panel = this.tabs.getPanel(tab.id);
        const want = tab.conversation?.id;
        const have = readTabFields(toJsonObject(panel?.state.customState ?? {})).conversationId;
        if (isAgent && (!want || have === want)) resumed += 1;
        else if (isAgent) failedTabs.push(tab.title);
        if (orchestratorPanels.has(tab.id) || tab.working) {
          told.push({ panelId: tab.id, title: tab.title, input: `${line}${tab.interrupted ? ' Your last turn was interrupted by the move; pick it up where it stopped.' : ''}` });
        }
      } catch (error) {
        console.warn(`[SessionMove] ${tab.title} couldn't resume after the move:`, error);
        failedTabs.push(tab.title);
      }
    }
    // The moved line waits for each agent's composer, so it doesn't hold up the source's confirmation.
    void Promise.all(told.map(({ panelId, title, input }) => this.registry.invoke('runpane:panels:submit', [{ panelId, input, source: 'agent' }])
      .catch(error => console.warn(`[SessionMove] The moved line didn't reach ${title}:`, error))));
    await this.receiver.remove(job.status.moveId).catch(() => undefined);
    job.status = { ...job.status, stage: 'started', detail: undefined, resumed, failedTabs };
  }

  /** Clears an arriving tab's move mark so it can start. */
  private async releaseTab(panelId: string, type: string): Promise<void> {
    if (type === 'chat') {
      await this.tabs.releaseChatMove(panelId);
      return;
    }
    await this.tabs.clearPaused([panelId]);
  }
}
