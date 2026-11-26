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
import { paneAgentFarmProcess } from '../agentFarm/bundledAgentFarm';
import { profilesOn } from '../agentFarm/profilesFeature';
import { parseProfileListJson, profileListEntries } from '../agentFarm/agentFarmProfiles';
import { panelManager } from '../panelManager';
import { terminalPanelManager } from '../terminalPanelManager';
import { getChatTabManager } from '../chatTabs';
import { repositoryIdentityFromRemote } from '../repositoryIdentity';
import { sessionWorkspacePath } from '../sessionWorkspace';
import { thisMachineName } from '../approvals/approvalStore';
import { isBinaryFile } from '../../utils/binaryFile';
import { placeConversation, undoConversationPlacement, type PlacedConversation } from './conversations';
import { addWorktree, applySnapshot, deleteRefs, importBundle, MoveGitError, placeBranch, snapshotMatches } from './gitSnapshot';
import { moveManifestSchema, movedApprovals, panelBuffersSchema, readTabFields, sessionMoveFixSchema, toJsonObject, type MoveManifest, type MovePane, type MoveRepo, type MoveTab } from './manifest';
import { buildPathMap, mapPath, rewriteJson, rewriteJsonText, rewriteText, type PathMap } from './pathMap';
import { arrivingPreview, previewSourcePath, relativeInside, type MovedRoot } from './filePreviews';
import { bindMovedApprovals } from './approvals';
import type { MovedApproval } from '../notify/notifyService';
import { MoveReceiver, type WriteRequest, type WriteResult } from './transfer';
import { isRegeneratedSessionFile, isTextFile, isVerbatimSessionFile } from './sessionFolder';
import { unreadableSnapshots } from '../agentFarm/sessionSnapshot';
import { agentFarmProfileOf, movedLine } from './rules';
import { MoveLedger, type CommitPlan, type JournalRecord, type LedgerEntry, type LedgerTab, type UndoStep } from './ledger';

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
  /** File preview tabs the build didn't carry, each with why (T-42). */
  previewsNotCarried?: string[];
  /** A failed start the source may ask for again. */
  retryable?: boolean;
  /** Durable proof the move was rolled back here (or never committed) and can never start: the source may release its copy. */
  rolledBack?: boolean;
  /** This machine keeps a durable record of every move it commits, so "no record" means it never committed one. */
  durable?: boolean;
}

interface Job {
  status: TargetStatus;
  /** When the source last wrote a chunk; a move left receiving this long without one is dropped. */
  lastWriteAt: number;
  manifest?: MoveManifest;
  map?: PathMap;
  /** The folders the build placed here: its worktrees and the Session folder. */
  roots?: string[];
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
  /** Archived Panes a move back set aside, deleted for good only once the move commits. */
  setAside: string[];
}

/** The tabs the importer creates, replaces and releases: Pane's own panel and terminal managers, or a test's. */
export interface ImporterTabs {
  getPanel(panelId: string): ToolPanel | undefined;
  getPanelsForSession(paneId: string): ToolPanel[];
  /** `hostFileGrant` only for a file:// preview this Pane checked itself (see filePreviews.ts). */
  createPanel(request: Parameters<typeof panelManager.createPanel>[0], options?: { hostFileGrant?: boolean }): Promise<ToolPanel>;
  deletePanel(panelId: string): Promise<void>;
  isTerminalInitialized(panelId: string): boolean;
  destroyTerminal(panelId: string): Promise<void>;
  clearPaused(panelIds: string[]): Promise<void>;
  releaseChatMove(panelId: string): Promise<void>;
  /** Drops every tab of a Pane that is going away, permanent ones (Explorer, Diff) included. */
  forgetPaneTabs(paneId: string): Promise<void>;
  /** Drops a Pane's tabs from memory only; their saved rows stay. */
  dropPaneTabsFromMemory(paneId: string): Promise<void>;
}

const liveTabs: ImporterTabs = {
  getPanel: panelId => panelManager.getPanel(panelId),
  getPanelsForSession: paneId => panelManager.getPanelsForSession(paneId),
  createPanel: (request, options) => panelManager.createPanel(request, options),
  deletePanel: async panelId => { await panelManager.deletePanel(panelId); },
  isTerminalInitialized: panelId => terminalPanelManager.isTerminalInitialized(panelId),
  destroyTerminal: async panelId => { await terminalPanelManager.destroyTerminal(panelId); },
  clearPaused: async panelIds => { await terminalPanelManager.clearPaused(panelIds); },
  releaseChatMove: async panelId => { await getChatTabManager().releaseMove(panelId); },
  forgetPaneTabs: paneId => panelManager.cleanupSessionPanels(paneId),
  dropPaneTabsFromMemory: paneId => panelManager.cleanupSessionPanelsInMemory(paneId),
};

const POSIX = new Set(['darwin', 'linux']);
/** Tries of a roll-back step before the person is told what is left (D-1). */
const NOTICE_AFTER_FAILURES = 5;
/** A roll-back step that failed is tried again after this long, doubling up to an hour. */
const UNDO_RETRY_MS = 5 * 60_000;

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

/** Git's output as it printed it (NUL-separated lists keep a name's leading spaces). */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, PATH: getShellPath() }, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Of the previewed source files under `sourceRoot`, those in the moved working tree (`snapshot`'s
 * tree: tracked and untracked files as they were on the source, never ignored or deleted ones),
 * each with its blob id, relative and `/`-separated.
 */
async function snapshotBlobs(worktree: string, snapshot: string, sourceRoot: string, previewPaths: readonly string[]): Promise<Map<string, string>> {
  const wanted = previewPaths.map(file => relativeInside(sourceRoot, file)).filter((file): file is string => file !== null);
  if (wanted.length === 0) return new Map();
  const listed = await gitRaw(worktree, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', snapshot, '--', ...wanted]);
  const blobs = new Map<string, string>();
  for (const entry of listed.split('\0')) {
    // `<mode> blob <id>\t<path>`; a symlink (120000) or submodule is never a previewable file.
    const match = /^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (match) blobs.set(match[2], match[1]);
  }
  return blobs;
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

/**
 * Runs Pane's own Agent Farm (the bundled copy, Pane's config root) while Profiles is on, as chat
 * launches and Pane's terminals do then; while it is off, `agent-farm` on PATH, as before T-63.
 */
async function runAgentFarm(args: string[], options: { cwd?: string; timeout: number; shellPath?: () => string }): Promise<{ stdout: string }> {
  const env = { ...process.env, PATH: (options.shellPath ?? getShellPath)() };
  if (!profilesOn()) return run('agent-farm', args, { cwd: options.cwd, env, timeout: options.timeout });
  const agentFarm = paneAgentFarmProcess(getAppDirectory(), args, { env, profiles: true });
  if (!agentFarm) throw new PaneError('ERR_MOVE_AGENT_FARM_MISSING', `This Pane build on ${thisMachineName()} lacks its bundled Agent Farm.`, `Reinstall Pane from runpane.com on ${thisMachineName()}, then check again.`);
  return run(agentFarm.executable, agentFarm.args, { cwd: options.cwd, env: agentFarm.env, timeout: options.timeout, windowsHide: true });
}

/**
 * Agent Farm profile versions from `agent-farm profiles list`, by qualified name. `shellPath` is the
 * PATH it runs with. With Profiles on, Pane's own Agent Farm's `profiles list --json`, leaving out
 * a profile that fails to resolve there (it cannot run); off, the person's own
 * agent-farm answers and is read as before T-63.
 */
export async function agentFarmProfiles(shellPath: () => string = getShellPath): Promise<Record<string, string>> {
  try {
    if (profilesOn()) {
      const { stdout } = await runAgentFarm(['profiles', 'list', '--json'], { timeout: 20_000, shellPath });
      return Object.fromEntries(profileListEntries(parseProfileListJson(stdout)).map(entry => [entry.ref, entry.version]));
    }
    const { stdout } = await runAgentFarm(['profiles', 'list'], { timeout: 20_000, shellPath });
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
  /** Each move's one decision, on disk, so it survives a restart of either machine. */
  readonly ledger: MoveLedger;
  /** Starts resumed from the ledger after a restart, by move. */
  private readonly resuming = new Map<string, Promise<void>>();
  /** Roll-backs under way, by move, so two never undo the same step at once. */
  private readonly rollingBack = new Map<string, Promise<void>>();

  constructor(
    private readonly services: AppServices,
    private readonly registry: PaneCommandRegistry,
    private readonly root = path.join(getAppDirectory(), 'moves'),
    private readonly tabs: ImporterTabs = liveTabs,
  ) {
    this.receiver = new MoveReceiver(root);
    this.ledger = new MoveLedger(path.join(path.dirname(root), 'move-ledger'));
    // Staging left by a move that was under way when Pane quit can't be finished: it goes. A move
    // that was built keeps its ledger entry, which is all its start needs.
    fs.rmSync(root, { recursive: true, force: true });
    this.ledger.prune();
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
        if (!found.pane.tabs.some(tab => agentFarmProfileOf(tabCommand(tab), profilesOn()))) continue;
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
      const { stdout } = await runAgentFarm(['workspace', 'show'], { cwd: repoPath, timeout: 20_000 });
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
        await runAgentFarm(['workspace', 'trust'], { cwd: fix.path, timeout: 60_000 });
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
      const decided = this.ledger.get(parsed.moveId);
      if (decided) throw new PaneError('ERR_MOVE_STAGE', `Move ${parsed.moveId} was already ${decided.decision === 'rolledBack' ? 'rolled back' : decided.decision} here.`, 'Start the move again.');
      this.jobs.set(parsed.moveId, { status: { moveId: parsed.moveId, stage: 'receiving', panesDone: 0, panesTotal: 0 }, lastWriteAt: Date.now(), conversations: [], tabs: [], setAside: [] });
    }
    const job = this.job(parsed.moveId);
    job.lastWriteAt = Date.now();
    if (job.status.stage !== 'receiving') throw new PaneError('ERR_MOVE_STAGE', `Move ${parsed.moveId} is past receiving (${job.status.stage}).`, 'Start the move again.');
    return this.receiver.write(parsed);
  }

  async status(moveId: string): Promise<TargetStatus> {
    const job = this.jobs.get(moveId);
    if (job) return { ...job.status, durable: true };
    const entry = this.ledger.get(moveId);
    if (entry) return this.fromLedger(this.abandonStaleBuild(entry));
    return this.noRecord(moveId);
  }

  /**
   * A build this Pane was running when it quit can't go on (its package and in-memory state are
   * gone): it is rolled back, from its journal, the first time anything asks about it.
   */
  private abandonStaleBuild(entry: LedgerEntry): LedgerEntry {
    if (entry.decision !== 'building' || this.jobs.has(entry.moveId)) return entry;
    const decided = this.ledger.decide(entry.moveId, 'rolledBack');
    void this.rollBack(entry.moveId).catch(error => console.error(`[SessionMove] Roll-back of ${entry.moveId} failed:`, error));
    return decided;
  }

  /**
   * The answer for a move with no ledger entry. Every build writes its entry first, so this machine
   * never committed it; unless something says otherwise (a Session still arriving for it, whose
   * record went missing), which is unknown and throws, so the source stays frozen.
   */
  private async noRecord(moveId: string): Promise<TargetStatus> {
    for (const session of (await this.services.orchestrationSessionManager?.list())?.sessions ?? []) {
      if (session.move?.moveId === moveId && session.move.state === 'arriving') {
        throw new PaneError('ERR_MOVE_LEDGER_MISSING', `Session “${session.name ?? session.id}” is arriving here for move ${moveId}, but this machine's record of the move is missing, so it can't say how the move ended.`, 'The Session stays paused on the other machine. Check the Pane folder on this machine, then check again.');
      }
      if (session.move?.state === 'arriving') continue;
      const record = await fs.promises.readFile(path.join(sessionWorkspacePath(session.id), 'moved.json'), 'utf8').catch(() => '');
      if (decodeOptionalBoundary(record ? JSON.parse(record) : null, boundary.object({ moveId: boundary.string }))?.moveId === moveId) {
        return { moveId, stage: 'started', panesDone: 0, panesTotal: 0, resumed: 0, failedTabs: [], durable: true };
      }
    }
    return { moveId, stage: 'aborted', panesDone: 0, panesTotal: 0, durable: true, error: { message: 'This machine has no record of the move, so it never started it here.', next: 'Start the move again.' } };
  }

  /** A move this Pane decided before it restarted, as the source asks for it. */
  private fromLedger(entry: LedgerEntry): TargetStatus {
    const base = { moveId: entry.moveId, panesDone: 0, panesTotal: 0, durable: true };
    const plan = entry.plan;
    switch (entry.decision) {
      case 'building':
        return { ...base, stage: 'building' };
      case 'built':
        return { ...base, stage: 'built', approvals: plan?.approvals ?? 0, leftBehind: plan?.leftBehind ?? [], missingEnv: plan?.missingEnv ?? [], previewsNotCarried: plan?.previewsNotCarried ?? [] };
      case 'committed':
        // A start cut short by the restart finishes on its own; the source sees it starting meanwhile.
        void this.resumeCommitted(entry.moveId);
        return { ...base, stage: 'starting', detail: 'Resuming tabs' };
      case 'started': {
        const results = Object.entries(entry.done);
        const failedTabs = results.filter(([, result]) => result === 'failed').map(([id]) => plan?.tabs.find(tab => tab.id === id)?.title ?? id);
        return { ...base, stage: 'started', resumed: results.filter(([, result]) => result === 'resumed').length, failedTabs, approvals: plan?.approvals ?? 0, leftBehind: plan?.leftBehind ?? [], missingEnv: plan?.missingEnv ?? [], previewsNotCarried: plan?.previewsNotCarried ?? [] };
      }
      case 'rolledBack':
        return { ...base, stage: 'aborted', rolledBack: true, error: { message: `The move was rolled back on ${thisMachineName()}; it never started there.`, next: 'Start the move again.' } };
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────

  /** Starts building in the background; the source polls status until built or failed. */
  build(moveId: string): TargetStatus {
    this.refuseTeammate();
    const job = this.job(moveId);
    if (job.status.stage !== 'receiving') return { ...job.status };
    // The entry comes first: every step of the build is recorded in it before it runs.
    this.ledger.begin(moveId);
    job.status = { ...job.status, stage: 'building', detail: 'Checking the package' };
    job.building = this.runBuild(job).catch(async error => {
      if (job.abortRequested) return; // abort undoes it, once this settles
      console.error(`[SessionMove] Build of ${moveId} failed:`, error);
      this.ledger.decide(moveId, 'rolledBack');
      await this.rollBack(moveId);
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
    // Waiting approvals move with the Session (T-44); a kind that can't move is refused before anything is built.
    try {
      movedApprovals(manifest.approvals);
    } catch (error) {
      throw new PaneError('ERR_MOVE_APPROVALS_INVALID', `An approval that came with the move can't be taken in here: ${reasonOf(error)}.`, 'Nothing was set up here. Answer it on the other machine, then move again.');
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
    // File previews (T-42) carry only files the move itself placed, listed before setup can add any.
    const previewPaths = manifest.panes.flatMap(pane => pane.tabs.map(previewSourcePath)).filter((file): file is string => file !== null);
    const movedRoots: MovedRoot[] = [];
    // Every Pane settles before the build goes on or fails, so clean-up never races a sibling still setting up.
    const settled = await Promise.allSettled(members.map(async pane => {
      step();
      const placement = placements.get(pane.id);
      if (!placement || !pane.bundle || !pane.snapshot) return;
      job.status.detail = `Setting up ${pane.name}`;
      const repo = placement.projectPath;
      const incomingPrefix = `refs/pane/move-incoming/${pane.id}`;
      this.journal(job, `refs for Pane “${pane.name}”`, { kind: 'deleteRefs', repo, prefix: incomingPrefix });
      const bundle = this.receiver.filePath(moveId, pane.bundle);
      // Moving back: the snapshot an earlier move left here (for Restore) comes back if this one fails.
      const previousSnapshot = await tryGit(repo, ['rev-parse', '--verify', '--quiet', pane.snapshot.ref]);
      this.journal(job, `the saved work of Pane “${pane.name}”`, { kind: 'restoreRef', repo, ref: pane.snapshot.ref, previous: previousSnapshot });
      const imported = await importBundle(repo, bundle, { branch: pane.branch, snapshotRef: pane.snapshot.ref, incomingPrefix });
      step();
      if (pane.branch && imported.branchHead) {
        const before = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${pane.branch}`]);
        this.journal(job, `branch ${pane.branch}`, { kind: 'restoreBranch', repo, branch: pane.branch, before });
        try {
          await placeBranch(repo, pane.branch, `${incomingPrefix}/branch`);
        } catch (error) {
          if (error instanceof MoveGitError && error.code === 'ERR_MOVE_BRANCH_DIVERGED') {
            const extra = error.details.extraCommits ?? 0;
            throw new PaneError('ERR_MOVE_BRANCH_DIVERGED', `${thisMachineName()} couldn't create the worktree for Pane “${pane.name}”: branch ${pane.branch} already exists there with ${extra} commit${extra === 1 ? '' : 's'} ${manifest.source.machine} doesn't have.`, `Push or delete branch ${pane.branch} on ${thisMachineName()}, then try again.`);
          }
          throw error;
        }
      }
      if (fs.existsSync(placement.worktreePath)) {
        throw new PaneError('ERR_MOVE_WORKTREE_EXISTS', `${placement.worktreePath} already exists on ${thisMachineName()}, so Pane “${pane.name}” can't get its worktree there.`, 'Move or remove that folder, then try again.');
      }
      const base = imported.snapshot ? (await git(repo, ['rev-parse', `${imported.snapshot}^1`])) : (pane.head ?? 'HEAD');
      this.journal(job, `worktree ${placement.worktreePath}`, { kind: 'removeWorktree', repo, path: placement.worktreePath });
      await addWorktree(repo, placement.worktreePath, pane.branch, base);
      await applySnapshot(placement.worktreePath, imported.snapshot);
      // Checked right after reapplying and before setup, which may change tracked files itself.
      if (!(await snapshotMatches(placement.worktreePath, imported.snapshot))) {
        throw new PaneError('ERR_MOVE_SNAPSHOT_MISMATCH', `The uncommitted work of Pane “${pane.name}” didn't come out the same on ${thisMachineName()}.`, 'Nothing was kept here. Try the move again.');
      }
      const blobs = await snapshotBlobs(placement.worktreePath, imported.snapshot, pane.worktreePath, previewPaths);
      movedRoots.push({
        from: pane.worktreePath, to: placement.worktreePath, files: new Set(blobs.keys()),
        same: async (relative, file) => blobs.get(relative) === await gitRaw(placement.worktreePath, ['hash-object', '--no-filters', '--', file]).then(out => out.trim(), () => null),
      });
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
      // Recorded right after (createSessionWithId is synchronous): a Pane of this ID that was here already must never be removed.
      this.journal(job, `Pane “${pane.name}”`, { kind: 'removePane', paneId: created.id });
      // Shown at once, the way a new Pane is (no reload), without taking focus; its own tabs follow.
      this.services.sessionManager.emitSessionCreated(created, { activateOnCreate: false, createDefaultTerminalOnCreate: false });
      if (pane.layout) sessionsDb.setSessionPanelLayout(pane.id, rewriteJsonText(map, pane.layout));
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
    this.journal(job, `the Session folder ${targetFolder}`, { kind: 'restoreFolder', target: targetFolder, backup: hadFolder ? backup : null });
    if (hadFolder) await fs.promises.rename(targetFolder, backup);
    for (const relative of manifest.sessionFolder.files) {
      if (isRegeneratedSessionFile(relative)) continue;
      const source = this.receiver.filePath(moveId, `session/${relative}`);
      const target = path.join(targetFolder, ...relative.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const text = isVerbatimSessionFile(relative) ? null : await readTextFile(source, relative);
      if (text === null) await fs.promises.copyFile(source, target);
      else await fs.promises.writeFile(target, rewriteText(map, text));
    }
    // T-110 (D-3): each Agent Farm snapshot must read here as it did there, or its agents would refuse to start.
    const brokenSnapshots = await unreadableSnapshots(targetFolder);
    if (brokenSnapshots.length) {
      throw new PaneError('ERR_MOVE_SNAPSHOT_UNREADABLE', `The Session's Agent Farm snapshot ${brokenSnapshots[0].path} didn't arrive intact on ${thisMachineName()}: ${brokenSnapshots[0].problem}.`, `Nothing was changed on ${manifest.source.machine}. Reload the Session's profile there, then move it again.`);
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
    const arriving = JSON.parse(JSON.stringify(rewriteJson(map, record))) as OrchestrationSessionRecord;
    arriving.move = arrivingMark;
    arriving.associations = arriving.associations.filter(association => !association.machine);
    // T-51 (W11): an older source doesn't refuse to move a to-do's Session; its to-do number names a
    // different to-do here, so the arriving record keeps none (as moved cards keep no `todo`).
    delete arriving.todoNumber;
    // Moving back: the copy that moved away keeps its owner Pane (archiving and recreating a live
    // Pane would let its teardown remove the arriving tabs); only its old tabs give way.
    step();
    if (existing) {
      for (const panel of this.tabs.getPanelsForSession(existing.internalSessionId)) await this.setAsidePanel(job, panel);
    }
    this.journal(job, `the arriving Session “${String(record.name ?? sessionId)}”`, { kind: 'removeArriving', sessionId, replaced: job.replacedSession ? toJsonObject(job.replacedSession) : null });
    await manager.importArriving(arriving);

    // Tabs: the same IDs, titles, order and split, stopped and marked arriving; conversations filed here.
    job.status.detail = 'Filing conversations';
    const arrivingPause: TerminalPausedMark = { at: new Date().toISOString(), by: 'move', machine: manifest.source.machine, arriving: true };
    movedRoots.push({ from: sourceFolder, to: targetFolder, files: new Set(manifest.sessionFolder.files.filter(relative => !isRegeneratedSessionFile(relative))) });
    job.roots = movedRoots.map(root => root.to);
    const previewsNotCarried: string[] = [];
    for (const pane of manifest.panes) {
      const paneId = pane.role === 'owner' ? arriving.internalSessionId : pane.id;
      const cwd = pane.role === 'owner' ? targetFolder : placements.get(pane.id)?.worktreePath;
      if (!cwd) continue;
      for (const tab of pane.tabs) {
        const state = decodeBoundary(rewriteJson(map, tab.state), boundary.jsonObject);
        // A file preview is never left to the remote-edit guard: the build checks and grants it here, or leaves it behind.
        const preview = await arrivingPreview(tab, movedRoots, manifest.source.machine);
        if (preview?.kind === 'notCarried') {
          previewsNotCarried.push(preview.note);
          continue;
        }
        if (preview) state.currentUrl = preview.currentUrl;
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
          const conversationId = tab.conversation.id;
          const placed = await placeConversation(tab.conversation, packagePath => this.receiver.filePath(moveId, packagePath), cwd, { here: thisMachineName(), source: manifest.source.machine }, process.env,
            plan => this.journal(job, `conversation ${conversationId}`, { kind: 'undoConversation', plan }));
          job.conversations.push(placed);
        }
        const existingPanel = this.tabs.getPanel(tab.id);
        if (existingPanel) await this.setAsidePanel(job, existingPanel);
        this.journal(job, `tab ${tab.title}`, { kind: 'deletePanel', panelId: tab.id });
        await this.tabs.createPanel({
          id: tab.id, sessionId: paneId,
          // SAFETY: the type is the source's own panel record's ToolPanelType, from a Pane of the same manifest version.
          type: tab.type as ToolPanelType,
          title: tab.title,
          initialState: { customState: state },
          metadata: tab.metadata,
          activate: false,
        }, { hostFileGrant: preview?.kind === 'carried' });
        job.tabs.push({ paneId, tab, cwd });
      }
    }
    const owner = manifest.panes.find(pane => pane.role === 'owner');
    if (owner?.layout) sessionsDb.setSessionPanelLayout(arriving.internalSessionId, rewriteJsonText(map, owner.layout));

    step();
    // The incoming refs did their job once the branches are placed; the snapshot refs stay for Restore.
    for (const pane of members) {
      const placement = placements.get(pane.id);
      if (placement) await deleteRefs(placement.projectPath, `refs/pane/move-incoming/${pane.id}`).catch(() => undefined);
    }
    const missingEnv = manifest.source.envNames.filter(name => !this.envNamesHere().has(name));
    // Built: the plan goes on disk before the source hears it, so the start survives a restart here.
    this.ledger.built(moveId, this.commitPlan(job, { leftBehind, missingEnv, previewsNotCarried }));
    job.status = { ...job.status, stage: 'built', detail: undefined, approvals: manifest.approvals.length, leftBehind, missingEnv, previewsNotCarried };
  }

  /** What the start does, from the build's results, in a form that survives a restart. */
  private commitPlan(job: Job, { leftBehind, missingEnv, previewsNotCarried }: Pick<CommitPlan, 'leftBehind' | 'missingEnv' | 'previewsNotCarried'>): CommitPlan {
    const manifest = job.manifest!;
    const orchestratorPanels = new Set(Object.values(decodeBoundary(manifest.session.panelIds ?? {}, boundary.jsonObject)));
    const tabs = job.tabs.map(({ tab }) => {
      const planned: LedgerTab = {
        id: tab.id, type: tab.type, title: tab.title,
        agent: tab.type === 'chat' || !!readTabFields(tab.state).agentId,
        running: tab.running, working: tab.working, interrupted: tab.interrupted,
      };
      if (tab.conversation?.id) planned.conversationId = tab.conversation.id;
      return planned;
    });
    return {
      sessionId: String(manifest.session.id), source: manifest.source.machine, tabs,
      told: tabs.filter(tab => orchestratorPanels.has(tab.id) || tab.working).map(tab => tab.id),
      movedLine: movedLine(manifest.source.machine, thisMachineName(), job.map!),
      setAside: [...job.setAside], leftovers: job.conversations.flatMap(placed => placed.leftovers),
      approvals: manifest.approvals.length, leftBehind, missingEnv, previewsNotCarried,
      // Shown here only once the move commits, with this machine's paths and bound to the tabs it made:
      // until then the source may still roll it back.
      approvalItems: this.boundApprovals(job).map(approval => toJsonObject(approval)),
    };
  }

  /** The move's approvals with this machine's paths, each bound to a tab this build made (approvals.ts). */
  private boundApprovals(job: Job): MovedApproval[] {
    const manifest = job.manifest!;
    if (!manifest.approvals.length) return [];
    const rewritten = manifest.approvals.map(approval => decodeBoundary(rewriteJson(job.map!, approval), boundary.jsonObject));
    const ownerPaneId = decodeBoundary(manifest.session.internalSessionId, boundary.nonEmptyString);
    const tabs = new Map(job.tabs.filter(({ tab }) => tab.type === 'terminal' || tab.type === 'chat').map(({ paneId, tab }) => [tab.id, paneId]));
    return bindMovedApprovals(movedApprovals(rewritten), {
      sessionId: String(manifest.session.id), sessionName: String(manifest.session.name ?? manifest.session.id), ownerPaneId, tabs, roots: job.roots ?? [],
    });
  }

  private envNamesHere(): Set<string> {
    return new Set(this.projects().flatMap(project => this.services.databaseService.getProjectEnvVars(project.id).map(variable => variable.key)));
  }

  /** Records how to undo the next build step, before it runs. */
  private journal(job: Job, label: string, step: UndoStep): void {
    this.ledger.journal(job.status.moveId, label, step);
  }

  /** Removes a tab that gives way to an arriving one; a failed move puts it back as it was. */
  private async setAsidePanel(job: Job, panel: ToolPanel): Promise<void> {
    // The tab as it was is saved beside the record first, so a restart can still put it back.
    this.ledger.saveSide(job.status.moveId, panel.id, toJsonObject({
      id: panel.id, sessionId: panel.sessionId, type: panel.type, title: panel.title,
      customState: panel.state.customState ?? {}, metadata: panel.metadata ?? {},
    }));
    this.journal(job, `tab ${panel.title}`, { kind: 'putBackPanel', panelId: panel.id });
    if (this.tabs.isTerminalInitialized(panel.id)) await this.tabs.destroyTerminal(panel.id).catch(() => undefined);
    await this.tabs.deletePanel(panel.id);
  }

  /**
   * Moving back: the archived Pane an earlier move left here (what Restore here brings back) gives
   * way to the arriving Pane of the same ID. Nothing it saved is deleted until the move commits: its
   * rows (tabs, layout, history, output, terminal buffers) wait under another id, hidden, and a
   * failed move puts them back as they were.
   */
  private async setAsideArchivedPane(job: Job, paneId: string): Promise<void> {
    const db = this.services.databaseService;
    await this.tabs.dropPaneTabsFromMemory(paneId).catch(error => console.warn(`[SessionMove] Pane ${paneId}'s tabs weren't dropped from memory:`, error));
    // Opening an archived Pane keeps it in memory, where it would block the arriving Pane's id.
    this.services.sessionManager.forgetSession(paneId);
    const aside = db.setArchivedSessionAside(paneId, `${paneId}.moving-${job.status.moveId}`);
    if (!aside) return;
    // Recorded right after: setting aside is one synchronous database step, and its undo needs what it returned.
    this.journal(job, `the archived Pane ${paneId}`, { kind: 'restoreAside', ...aside });
    job.setAside.push(aside.asideId);
  }

  private async removePane(paneId: string): Promise<void> {
    const db = this.services.databaseService;
    // deletePanel keeps permanent tabs; left cached, they would stand in for the arriving Pane's own.
    await this.tabs.forgetPaneTabs(paneId).catch(error => console.warn(`[SessionMove] Pane ${paneId}'s tabs weren't cleared:`, error));
    if (this.services.sessionManager.getSession(paneId)) await this.services.sessionManager.archiveSession(paneId).catch(() => undefined);
    if (db.getSession(paneId) && !db.getSession(paneId)?.archived) db.archiveSession(paneId);
    db.deleteArchivedSessionPermanently(paneId);
  }

  // ── Roll-back ──────────────────────────────────────────────────────────

  /**
   * Undoes everything the move made here, from its journal alone, newest step first, so it works
   * the same during the build and after a restart. Each step that succeeds is marked, so a
   * roll-back cut short resumes where it stopped. A step that fails stops the replay, and the next
   * try starts with it, before any older step: an older step may restore what it still has to
   * remove (an archived Pane's tab with the same ID as an arriving one), so it must never run first.
   */
  private rollBack(moveId: string): Promise<void> {
    const running = this.rollingBack.get(moveId);
    if (running) return running;
    const rolling = this.runRollBack(moveId).finally(() => this.rollingBack.delete(moveId));
    this.rollingBack.set(moveId, rolling);
    return rolling;
  }

  private async runRollBack(moveId: string): Promise<void> {
    const entry = this.ledger.get(moveId);
    if (!entry || entry.decision !== 'rolledBack' || entry.rollbackDone) return;
    for (let index = entry.journal.length - 1; index >= 0; index -= 1) {
      const record = entry.journal[index];
      if (record.undone) continue;
      try {
        await this.undo(moveId, record.step);
        this.ledger.undoResult(moveId, index);
      } catch (error) {
        // Stop here (F-16): an older step may restore what this one still has to remove, and a
        // retry of this one after that would delete the restored copy. The next try starts here.
        console.error(`[SessionMove] Undoing ${record.label} for move ${moveId} failed:`, error);
        const failed = this.ledger.undoResult(moveId, index, reasonOf(error));
        const tries = failed.failures ?? 1;
        if (tries >= NOTICE_AFTER_FAILURES && !this.ledger.get(moveId)?.noticed) this.tellLeftovers(moveId, entry.journal.slice(0, index + 1).filter(item => !item.undone), failed);
        setTimeout(() => void this.rollBack(moveId).catch(retry => console.error(`[SessionMove] Roll-back of ${moveId} failed:`, retry)), Math.min(UNDO_RETRY_MS * 2 ** Math.max(0, tries - 1), 60 * 60_000)).unref();
        return;
      }
    }
    await this.receiver.remove(moveId).catch(() => undefined);
    this.ledger.mark(moveId, 'rollbackDone');
  }

  /** The only manual path (D-1): steps that kept failing, named once, with what to do. */
  private tellLeftovers(moveId: string, left: JournalRecord[], failed: JournalRecord): void {
    this.ledger.mark(moveId, 'noticed');
    const more = left.length > 1 ? ` and ${left.length - 1} more` : '';
    const reason = failed.lastError ?? 'it kept failing';
    void this.services.notifyService?.queue.ask({
      question: {
        ui: 'info',
        title: `A cancelled move left ${failed.label}${more} on this machine`,
        context: `Pane tried ${NOTICE_AFTER_FAILURES} times to undo it and couldn't: ${reason}. Fix that (permissions or free disk space), then restart Pane to finish the clean-up; or remove it yourself. The Session itself is safe on the other machine.`,
      },
      source: { name: 'Pane', agent: 'Pane' },
    }).catch(error => console.warn("[SessionMove] The leftovers notice wasn't shown:", error));
  }

  /** One undo step. Each is safe when its step never ran, ran in part, or was already undone. */
  private async undo(moveId: string, step: UndoStep): Promise<void> {
    switch (step.kind) {
      case 'deleteRefs':
        await deleteRefs(step.repo, step.prefix);
        return;
      case 'restoreRef':
        if (step.previous) await git(step.repo, ['update-ref', step.ref, step.previous]);
        else await tryGit(step.repo, ['update-ref', '-d', step.ref]);
        return;
      case 'restoreBranch':
        if (step.before) await git(step.repo, ['update-ref', `refs/heads/${step.branch}`, step.before]);
        else if (await tryGit(step.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${step.branch}`]) !== null) await git(step.repo, ['branch', '-D', step.branch]);
        return;
      case 'removeWorktree':
        await tryGit(step.repo, ['worktree', 'remove', '--force', step.path]);
        await fs.promises.rm(step.path, { recursive: true, force: true });
        await tryGit(step.repo, ['worktree', 'prune']);
        return;
      case 'removePane':
        await this.removePane(step.paneId);
        return;
      case 'restoreAside': {
        const db = this.services.databaseService;
        if (db.getSession(step.asideId)) db.restoreSetAsideSession({ id: step.id, asideId: step.asideId, panelIds: step.panelIds, hidden: step.hidden });
        const job = this.jobs.get(moveId);
        if (job) job.setAside = job.setAside.filter(id => id !== step.asideId);
        return;
      }
      case 'restoreFolder':
        if (step.backup === null) {
          await fs.promises.rm(step.target, { recursive: true, force: true });
        } else if (fs.existsSync(step.backup)) {
          await fs.promises.rm(step.target, { recursive: true, force: true });
          await fs.promises.rename(step.backup, step.target);
        }
        return;
      case 'removeArriving': {
        const manager = this.services.orchestrationSessionManager;
        if (!manager) return;
        // SAFETY: `replaced` is the OrchestrationSessionRecord this machine had, saved as JSON by the build; the store sanitises it on write.
        const replaced = step.replaced ? JSON.parse(JSON.stringify(step.replaced)) as OrchestrationSessionRecord : undefined;
        await manager.removeArriving(step.sessionId, replaced).catch(error => {
          // Never imported, or already replaced back: nothing of this move's is there.
          if (error instanceof PaneError && error.code === 'ERR_MOVE_NOT_ARRIVING') return;
          throw error;
        });
        return;
      }
      case 'putBackPanel': {
        const saved = this.ledger.readSide(moveId, step.panelId);
        if (!saved || this.tabs.getPanel(step.panelId)) return;
        const panel = decodeBoundary(saved, boundary.object({ id: boundary.string, sessionId: boundary.string, type: boundary.string, title: boundary.string, customState: boundary.jsonObject, metadata: boundary.jsonObject }));
        await this.tabs.createPanel({
          id: panel.id, sessionId: panel.sessionId,
          // SAFETY: the saved panel's own ToolPanelType, written by this Pane when it set the tab aside.
          type: panel.type as ToolPanelType,
          title: panel.title, initialState: { customState: panel.customState },
          // SAFETY: the saved panel's own metadata, written by this Pane when it set the tab aside.
          metadata: JSON.parse(JSON.stringify(panel.metadata)) as ToolPanel['metadata'], activate: false,
          // This machine's own tab, as this Pane saved it beside its own ledger: a file preview it
          // showed was granted here, so putting it back is no remote grant, even when a remote abort runs it.
        }, { hostFileGrant: panel.type === 'browser' });
        return;
      }
      case 'deletePanel':
        if (this.tabs.getPanel(step.panelId)) await this.tabs.deletePanel(step.panelId);
        return;
      case 'undoConversation':
        await undoConversationPlacement(step.plan);
        return;
    }
  }

  /**
   * Before start only: records the roll-back, then removes everything this move made here. The
   * record comes first, so a move rolled back here can never start later, even after a restart.
   */
  async abort(moveId: string): Promise<TargetStatus> {
    const job = this.jobs.get(moveId);
    if (!job) return this.abortFromLedger(moveId);
    if (job.status.stage === 'starting' || job.status.stage === 'started' || job.startFailed) {
      throw new PaneError('ERR_MOVE_STARTED', 'The Session already started here, so the move can no longer be undone.', 'Use the Session here.');
    }
    job.aborting ??= (async () => {
      // A build still running stops at its next step, and settles before anything is undone.
      job.abortRequested = true;
      await job.building;
      this.ledger.decide(moveId, 'rolledBack');
      await this.rollBack(moveId);
      job.status = { ...job.status, stage: 'aborted', detail: undefined, rolledBack: true };
      return { ...job.status, durable: true };
    })();
    return job.aborting;
  }

  /**
   * Abort after a restart here: the roll-back is recorded, then undone from the build's journal. A
   * move this machine never built is fenced; one that committed refuses; an unknown one throws.
   */
  private async abortFromLedger(moveId: string): Promise<TargetStatus> {
    const entry = this.ledger.get(moveId);
    if (entry?.decision === 'committed' || entry?.decision === 'started') {
      throw new PaneError('ERR_MOVE_STARTED', 'The Session already started here, so the move can no longer be undone.', 'Use the Session here.');
    }
    if (!entry && (await this.noRecord(moveId)).stage === 'started') {
      throw new PaneError('ERR_MOVE_STARTED', 'The Session already started here, so the move can no longer be undone.', 'Use the Session here.');
    }
    const decided = this.ledger.decide(moveId, 'rolledBack');
    await this.rollBack(moveId);
    return this.fromLedger(this.ledger.get(moveId) ?? decided);
  }

  // ── Start ──────────────────────────────────────────────────────────────

  /** After the source froze: shows the Session and starts every tab on its conversation. Idempotent. */
  start(moveId: string): TargetStatus {
    this.refuseTeammate();
    const job = this.jobs.get(moveId);
    if (!job) return this.startFromLedger(moveId);
    // A start that failed before any tab started may be asked again (the source's Check again).
    const retry = job.startFailed && job.status.stage === 'failed';
    if ((job.status.stage !== 'built' && !retry) || job.abortRequested) return { ...job.status, durable: true };
    job.status = { ...job.status, stage: 'starting', detail: 'Resuming tabs', error: undefined, retryable: undefined };
    void this.commit(moveId).then(result => {
      job.status = { ...job.status, stage: 'started', detail: undefined, ...result };
    }, error => {
      // The Session isn't usable here yet, so the source must not retire its copy.
      console.error(`[SessionMove] Start of ${moveId} failed:`, error);
      job.startFailed = true;
      const failure = moveError(error);
      job.status = { ...job.status, stage: 'failed', detail: undefined, retryable: true, error: { message: `The Session didn't start on ${thisMachineName()}: ${failure.message}`, next: 'It stays paused on both machines. Check again to retry.' } };
    });
    return { ...job.status, durable: true };
  }

  /** Start after a restart here: a move built before it starts from its plan; one already decided answers as it stands. */
  private startFromLedger(moveId: string): TargetStatus {
    const stored = this.ledger.get(moveId);
    if (!stored) throw new PaneError('ERR_MOVE_UNKNOWN', `This machine has no move ${moveId} in progress.`, 'Start the move again from the other machine.');
    const entry = this.abandonStaleBuild(stored);
    if (entry.decision === 'built' || entry.decision === 'committed') {
      void this.resumeCommitted(moveId);
      return { moveId, stage: 'starting', detail: 'Resuming tabs', panesDone: 0, panesTotal: 0, durable: true };
    }
    return this.fromLedger(entry);
  }

  /**
   * When Pane starts: finishes every start it had committed, rolls back every build it was
   * running when it quit, and finishes every roll-back cut short. A built move waits for the source.
   */
  async resume(): Promise<void> {
    await Promise.all(this.ledger.pending().map(async entry => {
      try {
        if (entry.decision === 'committed') await this.resumeCommitted(entry.moveId);
        else if (entry.decision === 'building') {
          this.abandonStaleBuild(entry);
          await this.rollBack(entry.moveId);
        } else if (entry.decision === 'rolledBack') await this.rollBack(entry.moveId);
      } catch (error) {
        console.error(`[SessionMove] Move ${entry.moveId} didn't resume:`, error);
      }
    }));
  }

  private resumeCommitted(moveId: string): Promise<void> {
    const running = this.resuming.get(moveId);
    if (running) return running;
    const resumed = this.commit(moveId).then(() => undefined, error => {
      // Stays committed: the next status or start asks again, and the source stays frozen meanwhile.
      console.error(`[SessionMove] The start of ${moveId} didn't finish after Pane restarted:`, error);
    }).finally(() => this.resuming.delete(moveId));
    this.resuming.set(moveId, resumed);
    return resumed;
  }

  /**
   * The commit: recorded first, then every step that can't be undone, from the ledger's plan.
   * Each tab is noted as it is handled, so a start resumed after a restart picks up where it was.
   */
  private async commit(moveId: string): Promise<{ resumed: number; failedTabs: string[] }> {
    const entry = this.ledger.decide(moveId, 'committed');
    const plan = entry.plan;
    if (!plan) throw new PaneError('ERR_MOVE_NO_PLAN', `This machine's record of move ${moveId} has no start plan.`, 'Start the move again.');
    const manager = this.services.orchestrationSessionManager!;
    // From here the move is committed: no undo, the previous copies kept for it go.
    for (const asideId of plan.setAside) {
      try {
        this.services.databaseService.deleteArchivedSessionPermanently(asideId);
      } catch (error) {
        console.warn(`[SessionMove] The replaced archive ${asideId} wasn't deleted:`, error);
      }
    }
    for (const file of plan.leftovers) await fs.promises.rm(file, { force: true }).catch(error => console.warn("[SessionMove] A previous conversation copy wasn't removed:", error));
    await manager.setMoveMark(plan.sessionId, undefined, `Moved here from ${plan.source}.`);
    // The approvals that came along wait here now; each answer goes to its tab once that tab is at its prompt.
    // Once per move: a commit resumed after a restart never brings back a card handled here since.
    if (plan.approvalItems?.length && !entry.approvalsTaken) {
      this.services.notifyService?.adoptMovedApprovals(movedApprovals(plan.approvalItems));
      this.ledger.approvalsTaken(moveId);
    }
    const told = new Set(plan.told);
    const tell: Array<{ panelId: string; title: string; input: string }> = [];
    for (const tab of plan.tabs) {
      if (tab.type !== 'terminal' && tab.type !== 'chat') continue;
      if (entry.done[tab.id]) continue;
      let result: 'resumed' | 'failed' | 'skipped' = 'skipped';
      try {
        if (!tab.agent && !tab.running) {
          // A plain shell starts only if it was running there.
          await this.tabs.clearPaused([tab.id]);
        } else {
          await this.releaseTab(tab.id, tab.type);
          if (tab.type === 'terminal') await this.registry.invoke('runpane:panels:resume', [{ panelId: tab.id }]);
          const panel = this.tabs.getPanel(tab.id);
          const have = readTabFields(toJsonObject(panel?.state.customState ?? {})).conversationId;
          if (tab.agent) result = !tab.conversationId || have === tab.conversationId ? 'resumed' : 'failed';
          if (told.has(tab.id)) tell.push({ panelId: tab.id, title: tab.title, input: `${plan.movedLine}${tab.interrupted ? ' Your last turn was interrupted by the move; pick it up where it stopped.' : ''}` });
        }
      } catch (error) {
        console.warn(`[SessionMove] ${tab.title} couldn't resume after the move:`, error);
        result = 'failed';
      }
      this.ledger.tabDone(moveId, tab.id, result);
    }
    // The moved line waits for each agent's composer, so it doesn't hold up the source's confirmation.
    void Promise.all(tell.map(({ panelId, title, input }) => this.registry.invoke('runpane:panels:submit', [{ panelId, input, source: 'agent' }])
      .catch(error => console.warn(`[SessionMove] The moved line didn't reach ${title}:`, error))));
    await this.receiver.remove(moveId).catch(() => undefined);
    const done = this.ledger.decide(moveId, 'started');
    const status = this.fromLedger(done);
    return { resumed: status.resumed ?? 0, failedTabs: status.failedTabs ?? [] };
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
