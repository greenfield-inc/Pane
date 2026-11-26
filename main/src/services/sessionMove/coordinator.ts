import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { app } from 'electron';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import {
  SESSION_MOVE_FEATURE,
  SESSION_MOVE_MANIFEST_VERSION,
  SESSION_MOVE_TARGET_CHANNELS,
  type SessionMoveCheck,
  type SessionMovePreflight,
  type SessionMoveProgress,
  type SessionMoveStep,
  type SessionMoveStepId,
  type SessionMoveWaitingTab,
} from '../../../../shared/types/sessionMove';
import type { OrchestrationSessionRecord } from '../../../../shared/types/orchestrationSession';
import type { TerminalPausedMark, ToolPanel } from '../../../../shared/types/panels';
import { configuredAgent, isConfiguredAgent } from '../../../../shared/agents';
import { isFileStoreAgent } from '../../../../packages/runpane/src/nativeSession';
import { fileDigest } from '../../../../packages/runpane/src/checkedCopy';
import type { PaneCommandRegistry } from '../../daemon/commandRegistry';
import type { AppServices } from '../../ipc/types';
import { getAppDirectory } from '../../utils/appDirectory';
import { getShellPath } from '../../utils/shellPath';
import { thisMachineName } from '../approvals/approvalStore';
import { getChatTabManager } from '../chatTabs';
import { panelManager } from '../panelManager';
import { restartRunScripts, runScriptRunning, stopRunScript } from '../panePause';
import { repositoryIdentityFromRemote } from '../repositoryIdentity';
import { sessionWorkspacePath } from '../sessionWorkspace';
import { terminalPanelManager } from '../terminalPanelManager';
import { databaseService } from '../database';
import { locateConversation } from './conversations';
import { createBundle, createSnapshot, ignoredPaths, putBackRef } from './gitSnapshot';
import { agentFarmProfiles, cliVersion, type TargetPreflight, type TargetStatus } from './importer';
import { agentFarmProfileOf, heldBackChecks, sessionApprovals, tabSnapshotFolder, type SessionApprovals } from './rules';
import { snapshotHoldsProfile } from '../agentFarm/sessionSnapshot';
import type { MovedApproval } from '../notify/notifyService';
import { keepIgnoredFiles } from './ignoredFiles';
import { runpaneWaits } from '../agentStatus/midTurn';
import { movedApprovals, readTabFields, sessionMoveCheckSchema, sessionMoveFixSchema, toJsonObject, type MoveManifest, type MovePane, type MoveTab, type PackageFile } from './manifest';
import { resolvePeer, type MovePeer } from './peer';
import { settleAfterFreeze, type FreezeOutcome, type FreezeWait } from './afterFreeze';
import { listSessionFolder } from './sessionFolder';
import { sendFile, writeResultSchema, type ChunkSender, type WriteRequest } from './transfer';

const run = promisify(execFile);
const POLL_MS = 1_000;
const CALL_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 130_000;
/** How long the target may stay silent before the freeze before the move gives up and restarts the tabs here. */
const SILENCE_BEFORE_FREEZE_MS = 3 * 60_000;
/** After the freeze, how long the target may stay silent before the dialog says so (the source keeps asking). */
const SILENCE_AFTER_FREEZE_MS = 2 * 60_000;

const targetPreflightSchema = boundary.object({
  machine: boundary.string,
  checks: boundary.array(sessionMoveCheckSchema),
  branchTips: boundary.record(boundary.string),
  home: boundary.string,
});
const targetStatusSchema = boundary.object({
  moveId: boundary.string,
  stage: boundary.enumeration('receiving', 'building', 'built', 'starting', 'started', 'failed', 'aborted'),
  detail: boundary.optional(boundary.string),
  panesDone: boundary.number,
  panesTotal: boundary.number,
  error: boundary.optional(boundary.object({ message: boundary.string, next: boundary.string })),
  resumed: boundary.optional(boundary.number),
  failedTabs: boundary.optional(boundary.array(boundary.string)),
  approvals: boundary.optional(boundary.number),
  leftBehind: boundary.optional(boundary.array(boundary.string)),
  missingEnv: boundary.optional(boundary.array(boundary.string)),
  previewsNotCarried: boundary.optional(boundary.array(boundary.string)),
  retryable: boundary.optional(boundary.boolean),
  rolledBack: boundary.optional(boundary.boolean),
  durable: boundary.optional(boundary.boolean),
});
const doctorSchema = boundary.object({ daemon: boundary.optional(boundary.object({ features: boundary.optional(boundary.array(boundary.string)) })) });

export const moveRequestSchema = boundary.object({ sessionId: boundary.nonEmptyString, target: boundary.nonEmptyString });
export const statusRequestSchema = boundary.object({ sessionId: boundary.nonEmptyString, recheck: boundary.optional(boundary.boolean) });
export const sessionRequestSchema = boundary.object({ sessionId: boundary.nonEmptyString });
export const fixRequestSchema = boundary.object({ sessionId: boundary.nonEmptyString, target: boundary.nonEmptyString, fix: sessionMoveFixSchema });
export type MoveRequest = ReturnType<typeof moveRequestSchema.decode>;
export type StatusRequest = ReturnType<typeof statusRequestSchema.decode>;
export type SessionRequest = ReturnType<typeof sessionRequestSchema.decode>;
export type FixRequest = ReturnType<typeof fixRequestSchema.decode>;

interface MovedTab {
  panel: ToolPanel;
  paneId: string;
  paneName: string;
  kind: 'terminal' | 'chat';
  running: boolean;
  working: boolean;
  interrupted: boolean;
  stopped: boolean;
  since?: string;
}

interface SourceJob {
  progress: SessionMoveProgress;
  peer: MovePeer;
  record: OrchestrationSessionRecord;
  paneIds: string[];
  tabs: MovedTab[];
  stopNow: boolean;
  cancelled: boolean;
  /** Panes whose run script the move stopped, restarted on cancel. */
  scripts: string[];
  /** Snapshot refs the pack wrote, with what they pointed at before, put back if the move doesn't happen. */
  snapshotRefs: Array<{ worktree: string; ref: string; previous: string | null }>;
  outDir: string;
  lastHeard: number;
  /** The after-freeze loop, while it runs: one per move. */
  settling?: Promise<void>;
  /** Ends the loop's current wait early (Check again). */
  wake?: () => void;
  /** Waiting cards held from the moment the move stops tabs until it packs them (T-44). */
  heldApprovals: string[];
  /** The cards the pack took from this machine; put back if the move doesn't happen. */
  carriedApprovals?: MovedApproval[];
  /** Cards answered while the move stopped tabs: they stay here, each with a note for the summary. */
  approvalsStayed: string[];
}

const STEP_TITLES = {
  stop: 'Stop tabs',
  pack: 'Pack Panes, conversations and the Session folder',
  send: 'Send',
  build: 'Set up',
  start: 'Resume tabs',
} satisfies Record<SessionMoveStepId, string>;
const STEP_ORDER: readonly SessionMoveStepId[] = ['stop', 'pack', 'send', 'build', 'start'];

function steps(): SessionMoveStep[] {
  return STEP_ORDER.map(id => ({ id, state: 'pending', title: STEP_TITLES[id] }));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, PATH: getShellPath() }, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try { return await git(cwd, args); } catch { return null; }
}

/** Messages waiting in a chat tab's queue; their full text lives in this machine's chat spool, which doesn't travel. */
function queuedMessages(panel: ToolPanel): number {
  if (panel.type !== 'chat') return 0;
  const queue = toJsonObject(panel.state.customState ?? {}).queue;
  return Array.isArray(queue) ? queue.length : 0;
}

/**
 * The source's side of a Session move: it stops every tab as its turn ends, packs the Session,
 * sends it, waits for the target to build it, freezes the source, has the target start it, and
 * retires the source once the target confirms. Before the freeze any failure restarts the tabs
 * here and leaves the target as it was; after it, the source never restarts on its own.
 */
export class MoveCoordinator {
  private readonly jobs = new Map<string, SourceJob>();

  constructor(private readonly services: AppServices, private readonly registry: PaneCommandRegistry) {}

  private manager() {
    const manager = this.services.orchestrationSessionManager;
    if (!manager) throw new PaneError('ERR_MOVE_NO_SESSIONS', 'Sessions are not available on this machine.', 'Update Pane, then try again.');
    return manager;
  }

  private memberPaneIds(record: OrchestrationSessionRecord): string[] {
    return [...new Set(record.associations.filter(association => !association.machine).map(association => association.paneId))]
      .filter(paneId => { const pane = this.services.sessionManager.getSession(paneId); return !!pane && !pane.archived; });
  }

  private tabsOf(record: OrchestrationSessionRecord): MovedTab[] {
    const panes = [record.internalSessionId, ...this.memberPaneIds(record)];
    return panes.flatMap(paneId => {
      const paneName = paneId === record.internalSessionId ? record.name : this.services.sessionManager.getSession(paneId)?.name ?? paneId;
      return panelManager.getPanelsForSession(paneId).flatMap((panel): MovedTab[] => {
        if (panel.type !== 'terminal' && panel.type !== 'chat') return [];
        const kind = panel.type;
        const running = kind === 'terminal' ? terminalPanelManager.isTerminalInitialized(panel.id) : getChatTabManager().isRunning(panel.id);
        return [{ panel, paneId, paneName, kind, running, working: false, interrupted: false, stopped: false }];
      });
    });
  }

  // ── The manifest ───────────────────────────────────────────────────────

  /** The manifest without package files (preflight), or with them (`pack`). */
  private async manifest(record: OrchestrationSessionRecord, moveId: string, pack?: { outDir: string; tabs: MovedTab[]; snapshotRefs: SourceJob['snapshotRefs']; approvals: MovedApproval[] }): Promise<{ manifest: MoveManifest; sources: Map<string, string> }> {
    const sources = new Map<string, string>();
    const panes: MovePane[] = [];
    const agentVersions: Record<string, string | null> = {};
    const profileNames = new Set<string>();
    // T-110: the snapshot each Agent Farm tab resolves from, for the profiles a move needs nothing installed for.
    const profileSnapshots = new Map<string, Array<string | undefined>>();
    const sessionFolder = sessionWorkspacePath(record.id);
    const envNames = new Set<string>();
    const tabState = new Map((pack?.tabs ?? []).map(tab => [tab.panel.id, tab]));
    const paneIds = [record.internalSessionId, ...this.memberPaneIds(record)];
    for (const paneId of paneIds) {
      const pane = this.services.sessionManager.getSession(paneId);
      const owner = paneId === record.internalSessionId;
      const db = databaseService.getSession(paneId);
      const worktreePath = owner ? sessionWorkspacePath(record.id) : pane?.worktreePath ?? db?.worktree_path ?? '';
      let repo: MovePane['repo'] = null;
      let branch: string | null = null;
      let head: string | null = null;
      let snapshot: MovePane['snapshot'] = null;
      let bundle: string | null = null;
      let ignored: string[] = [];
      if (!owner && worktreePath) {
        const project = db?.project_id ? databaseService.getProject(db.project_id) : undefined;
        const root = project?.path ?? (await tryGit(worktreePath, ['rev-parse', '--show-toplevel'])) ?? worktreePath;
        const remote = await tryGit(worktreePath, ['remote', 'get-url', 'origin']);
        const home = os.homedir();
        repo = {
          remote, identity: remote ? repositoryIdentityFromRemote(remote) : null, root,
          relativeToHome: root.startsWith(`${home}/`) ? root.slice(home.length + 1) : null, name: path.basename(root),
        };
        const abbrev = await tryGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        branch = abbrev && abbrev !== 'HEAD' ? abbrev : null;
        head = await tryGit(worktreePath, ['rev-parse', 'HEAD']);
        if (project) for (const variable of databaseService.getProjectEnvVars(project.id)) envNames.add(variable.key);
        if (pack) {
          const ref = `refs/pane/move/${paneId}`;
          const created = await createSnapshot(worktreePath, ref);
          pack.snapshotRefs.push({ worktree: worktreePath, ref, previous: created.previous });
          snapshot = { ref, commit: created.commit };
          bundle = `panes/${paneId}.bundle`;
          const out = path.join(pack.outDir, 'panes', `${paneId}.bundle`);
          await fs.promises.mkdir(path.dirname(out), { recursive: true });
          await createBundle(worktreePath, branch ? [`refs/heads/${branch}`, ref] : [ref], out);
          sources.set(bundle, out);
          ignored = await ignoredPaths(worktreePath);
        }
      }
      const tabs: MoveTab[] = [];
      for (const panel of panelManager.getPanelsForSession(paneId)) {
        const custom = toJsonObject(panel.state.customState ?? {});
        delete custom.scrollbackBuffer; delete custom.serializedBuffer; delete custom.alternateScreenBuffer;
        const moved = tabState.get(panel.id);
        const { agentId: agent, conversationId, launch } = readTabFields(custom);
        if (agent && isConfiguredAgent(agent) && !(agent in agentVersions)) agentVersions[agent] = await cliVersion(configuredAgent(agent).executables[0]);
        const profile = agentFarmProfileOf(launch);
        if (profile) {
          profileNames.add(profile);
          const pinned = decodeOptionalBoundary(custom.agentFarmSnapshot, boundary.string);
          profileSnapshots.set(profile, [...profileSnapshots.get(profile) ?? [], tabSnapshotFolder(launch, { agentFarmSnapshot: pinned }, sessionFolder, record.agentFarmSnapshot)]);
        }
        const tab: MoveTab = {
          id: panel.id, type: panel.type, title: panel.title,
          metadata: toJsonObject(panel.metadata ?? {}),
          state: custom,
          working: moved?.working ?? false, interrupted: moved?.interrupted ?? false, running: moved?.running ?? false,
        };
        if (pack && conversationId && isFileStoreAgent(agent)) {
          const located = await locateConversation(agent, conversationId, worktreePath, `conversations/${panel.id}`);
          if (located) {
            tab.conversation = located.conversation;
            for (const [packagePath, source] of located.sources) sources.set(packagePath, source);
          }
        }
        if (pack && panel.type === 'terminal') {
          const buffers = databaseService.getPanelBuffers(panel.id);
          if (buffers) {
            const out = path.join(pack.outDir, 'buffers', `${panel.id}.json`);
            await fs.promises.mkdir(path.dirname(out), { recursive: true });
            await fs.promises.writeFile(out, JSON.stringify({ scrollback: buffers.scrollback ?? null, serialized: buffers.serialized ?? null, alternate: buffers.alternate ?? null }));
            tab.buffers = `buffers/${panel.id}.json`;
            sources.set(tab.buffers, out);
          }
        }
        tabs.push(tab);
      }
      panes.push({
        id: paneId, name: owner ? record.name : pane?.name ?? paneId, role: owner ? 'owner' : 'member', repo, worktreePath,
        worktreeName: db?.worktree_name ?? path.basename(worktreePath), branch, head,
        baseBranch: db?.base_branch ?? null, baseCommit: db?.base_commit ?? null, snapshot, bundle,
        layout: databaseService.getSessionPanelLayout(paneId),
        record: { prompt: db?.initial_prompt ?? '', permissionMode: db?.permission_mode ?? 'ignore', noTool: db?.tool_type === 'none' },
        tabs, ignored,
      });
    }
    const folderRoot = sessionFolder;
    const folderFiles = listSessionFolder(folderRoot);
    if (pack) for (const relative of folderFiles) sources.set(`session/${relative}`, path.join(folderRoot, ...relative.split('/')));
    const here = profileNames.size ? await agentFarmProfiles() : {};
    const profiles = Object.fromEntries([...profileNames].map(name => [name, here[name] ?? null]));
    const snapshotProfiles: string[] = [];
    for (const [name, folders] of profileSnapshots) {
      let held = true;
      for (const folder of folders) held = held && !!folder && await snapshotHoldsProfile(folder, name);
      if (held) snapshotProfiles.push(name);
    }
    const approvals = (pack?.approvals ?? []).map(approval => toJsonObject(approval));
    const files: PackageFile[] = [];
    if (pack) for (const [packagePath, source] of sources) files.push({ path: packagePath, ...(await fileDigest(source)) });
    const manifest: MoveManifest = {
      version: SESSION_MOVE_MANIFEST_VERSION, moveId,
      source: {
        machine: thisMachineName(), home: os.homedir(), paneDir: getAppDirectory(), platform: process.platform,
        paneVersion: app?.getVersion?.() ?? '0.0.0', agentVersions, profiles, snapshotProfiles, envNames: [...envNames].sort(),
      },
      session: toJsonObject(record),
      sessionFolder: { root: folderRoot, files: folderFiles },
      panes, approvals, files,
    };
    return { manifest, sources };
  }

  /** The Session's approvals as the move sees them: those it carries, and those that hold it back. */
  private approvalsOf(record: OrchestrationSessionRecord): SessionApprovals {
    const store = this.services.approvalStore;
    if (!store) return { carried: [], held: [] };
    const paneIds = new Set([record.internalSessionId, ...this.memberPaneIds(record)]);
    return sessionApprovals(store.openItems(), {
      // Its asking tab, as this machine has it, is in one of the Session's Panes.
      askedHere: item => {
        const pane = item.source.panelId ? panelManager.getPanel(item.source.panelId)?.sessionId : undefined;
        return pane !== undefined && paneIds.has(pane);
      },
      filedHere: item => item.source.session?.id === record.id || (item.connected?.kind === 'session' && item.connected.id === record.id),
    });
  }

  /** Every tab of the Session's Panes: the move holds the cards they ask until it packs. */
  private panelIdsOf(record: OrchestrationSessionRecord): string[] {
    return [record.internalSessionId, ...this.memberPaneIds(record)].flatMap(paneId => panelManager.getPanelsForSession(paneId).map(panel => panel.id));
  }

  // ── Preflight ──────────────────────────────────────────────────────────

  async check({ sessionId, target }: MoveRequest): Promise<SessionMovePreflight> {
    const record = await this.manager().get({ sessionId });
    if (record.archived || record.move) {
      throw new PaneError('ERR_MOVE_SESSION_STATE', `Session “${record.name}” is ${record.archived ? 'archived' : record.move?.state ?? 'busy'}, so it can't move.`, record.archived ? 'Restore it first.' : 'Wait for the current move to finish.');
    }
    // T-51 (W11): a to-do's own Session stays with its to-do, whose number means a different to-do on another machine.
    if (record.todoNumber !== undefined) {
      return { target, ready: false, checks: [{ id: 'todo', level: 'block', title: `T-${record.todoNumber}'s Session stays on this machine`, detail: `It belongs to to-do T-${record.todoNumber}, which lives here; to-dos don't move between machines, and T-${record.todoNumber} on ${target} is a different to-do. Nothing was moved.` }], paneCount: 0, tabCount: 0, bytes: 0 };
    }
    const peer = resolvePeer(target, this.services.configManager);
    const checks: SessionMoveCheck[] = [];
    // An older Pane on the target says so before anything else is asked of it.
    try {
      const doctor = await peer.invoke('runpane:doctor', [{}], doctorSchema, CALL_TIMEOUT_MS);
      if (!doctor.daemon?.features?.includes(SESSION_MOVE_FEATURE)) {
        return { target, ready: false, checks: [{ id: 'version', level: 'block', title: `Update Pane on ${target}`, detail: `Pane on ${target} is too old to receive a whole Session. Update it there, then check again.` }], paneCount: 0, tabCount: 0, bytes: 0 };
      }
    } catch (error) {
      return { target, ready: false, checks: [{ id: 'reach', level: 'block', title: `Can't reach Pane on ${target}`, detail: error instanceof PaneError ? `${error.message} ${error.next ?? ''}`.trim() : reasonOf(error) }], paneCount: 0, tabCount: 0, bytes: 0 };
    }
    const { manifest } = await this.manifest(record, randomUUID());
    const answer: TargetPreflight = await peer.invoke(SESSION_MOVE_TARGET_CHANNELS.preflight, [{ manifest: toJsonObject(manifest) }], targetPreflightSchema, CALL_TIMEOUT_MS);
    checks.push(...answer.checks);
    // A branch on the target with commits this machine doesn't have would be overwritten: block it here.
    for (const pane of manifest.panes) {
      const tip = answer.branchTips[pane.id];
      if (!tip || !pane.branch || !pane.head || tip === pane.head) continue;
      const known = await tryGit(pane.worktreePath, ['cat-file', '-e', `${tip}^{commit}`]) !== null;
      const ancestor = known && (await tryGit(pane.worktreePath, ['merge-base', '--is-ancestor', tip, 'HEAD'])) !== null;
      if (!ancestor) {
        const count = known ? await tryGit(pane.worktreePath, ['rev-list', '--count', `HEAD..${tip}`]) : null;
        checks.push({ id: `diverged:${pane.id}`, level: 'block', title: `Branch ${pane.branch} has diverged on ${target}`, detail: `It exists there with ${count ?? 'some'} commit${count === '1' ? '' : 's'} this machine doesn't have. Push or delete branch ${pane.branch} on ${target}, then check again.` });
      }
    }
    checks.push(...this.heldBackChecks(record));
    // Tabs as the person counts them: terminals and chats (Explorer and Diff come along on their own).
    const tabCount = manifest.panes.reduce((sum, pane) => sum + pane.tabs.filter(tab => tab.type === 'terminal' || tab.type === 'chat').length, 0);
    const bytes = await this.estimate(manifest);
    return { target, ready: !checks.some(check => check.level === 'block'), checks, paneCount: manifest.panes.filter(pane => pane.role === 'member').length, tabCount, bytes };
  }

  private heldBackChecks(record: OrchestrationSessionRecord, stopped = false): SessionMoveCheck[] {
    const tabs = this.tabsOf(record).map(tab => ({ panelId: tab.panel.id, title: tab.panel.title, running: tab.running, queued: queuedMessages(tab.panel) }));
    return heldBackChecks(this.approvalsOf(record), tabs, stopped);
  }

  private async estimate(manifest: MoveManifest): Promise<number> {
    let bytes = 0;
    const add = async (file: string) => { bytes += await fs.promises.stat(file).then(stat => stat.size, () => 0); };
    for (const relative of manifest.sessionFolder.files) await add(path.join(manifest.sessionFolder.root, ...relative.split('/')));
    for (const pane of manifest.panes) {
      for (const tab of pane.tabs) {
        const { conversationId: id, agentId: agent } = readTabFields(tab.state);
        if (!id || !isFileStoreAgent(agent)) continue;
        const located = await locateConversation(agent, id, pane.worktreePath, 'x').catch(() => undefined);
        for (const source of located?.sources.values() ?? []) await add(source);
      }
    }
    return bytes;
  }

  async fix({ sessionId, target, fix }: FixRequest): Promise<SessionMovePreflight> {
    const peer = resolvePeer(target, this.services.configManager);
    // Setup-heavy: a clone can take minutes.
    await peer.invoke(SESSION_MOVE_TARGET_CHANNELS.fix, [{ fix }], boundary.json, 10 * 60_000);
    return this.check({ sessionId, target });
  }

  // ── The move ───────────────────────────────────────────────────────────

  async start({ sessionId, target }: MoveRequest): Promise<SessionMoveProgress> {
    const existing = this.jobs.get(sessionId);
    if (existing && !['done', 'failed', 'cancelled'].includes(existing.progress.phase)) return { ...existing.progress };
    const preflight = await this.check({ sessionId, target });
    if (!preflight.ready) {
      const block = preflight.checks.find(check => check.level === 'block');
      if (block?.id === 'todo') throw new PaneError('ERR_MOVE_TODO_SESSION', `${block.title}: ${block.detail ?? 'it belongs to a to-do on this machine.'}`, `Work on it from this machine, or start a new to-do on ${target}.`);
      // Open approvals and waiting messages are this Session's, not the target's.
      const here = block?.id === 'approvals' || block?.id.startsWith('queue:');
      throw new PaneError('ERR_MOVE_NOT_READY', here ? `The Session can't move yet: ${block?.title}.` : `${target} isn't ready: ${block?.title ?? 'a check failed'}.`, here ? block?.detail ?? 'Check again.' : 'Fix what the dialog lists, then move again.');
    }
    const record = await this.manager().get({ sessionId });
    // Another start may have begun the move during those awaits: join it rather than replace it, so
    // there is never a second job whose clean-up could put back the running move's snapshot refs.
    const active = this.jobs.get(sessionId);
    if (active && !['done', 'failed', 'cancelled'].includes(active.progress.phase)) return { ...active.progress };
    const moveId = randomUUID();
    const tabs = this.tabsOf(record);
    const job: SourceJob = {
      record, peer: resolvePeer(target, this.services.configManager), paneIds: [record.internalSessionId, ...this.memberPaneIds(record)], tabs,
      stopNow: false, cancelled: false, scripts: [], snapshotRefs: [], heldApprovals: [], approvalsStayed: [], outDir: path.join(getAppDirectory(), 'moves-out', moveId), lastHeard: Date.now(),
      progress: {
        moveId, sessionId, sessionName: record.name, target, phase: 'waiting', waiting: [], stoppedTabs: 0, totalTabs: tabs.length,
        steps: steps(), frozen: false, updatedAt: new Date().toISOString(),
      },
    };
    this.jobs.set(sessionId, job);
    this.setStep(job, 'stop', 'running');
    void this.run(job).catch(error => this.fail(job, error));
    return { ...job.progress };
  }

  async status({ sessionId, recheck }: StatusRequest): Promise<SessionMoveProgress | null> {
    const job = this.jobs.get(sessionId) ?? await this.recoverFrozen(sessionId);
    if (!job) return null;
    if (recheck && job.progress.phase === 'confirming') void this.recheck(job).catch(() => undefined);
    else if (job.progress.frozen) this.settle(job);
    return { ...job.progress, waiting: [...job.progress.waiting], steps: job.progress.steps.map(step => ({ ...step })) };
  }

  /**
   * A Session still frozen as Moving after Pane restarted mid-move: the target may run it, so it
   * stays frozen, and the move carries on asking the target until its record decides it.
   */
  private async recoverFrozen(sessionId: string): Promise<SourceJob | undefined> {
    const record = await this.manager().get({ sessionId }).catch(() => undefined);
    if (record?.move?.state !== 'moving') return undefined;
    const existing = this.jobs.get(sessionId);
    if (existing) return existing;
    // Every tab was stopped by the move; an agent tab starts again on its conversation if the move is rolled back.
    const tabs = this.tabsOf(record).map(tab => ({
      ...tab, stopped: true,
      running: tab.running || tab.kind === 'chat' || !!readTabFields(toJsonObject(tab.panel.state.customState ?? {})).agentId,
    }));
    const job: SourceJob = {
      record, peer: resolvePeer(record.move.machine, this.services.configManager), paneIds: [record.internalSessionId, ...this.memberPaneIds(record)],
      tabs, stopNow: false, cancelled: false, scripts: [], snapshotRefs: [], heldApprovals: [], approvalsStayed: [], outDir: path.join(getAppDirectory(), 'moves-out', record.move.moveId), lastHeard: Date.now(),
      progress: {
        moveId: record.move.moveId, sessionId, sessionName: record.name, target: record.move.machine, phase: 'confirming', waiting: [], stoppedTabs: tabs.length, totalTabs: tabs.length,
        steps: steps().map(step => ({ ...step, state: step.id === 'start' ? 'running' : 'done' })), frozen: true, updatedAt: new Date().toISOString(),
        error: { message: `Asking ${record.move.machine} whether the move finished.`, next: `The Session stays paused here until ${record.move.machine} answers, so it never runs twice.` },
      },
    };
    this.jobs.set(sessionId, job);
    this.settle(job);
    return job;
  }

  /** On app start: every Session left frozen by a move carries on to its outcome without the dialog. */
  async resume(): Promise<void> {
    const sessions = (await this.services.orchestrationSessionManager?.list())?.sessions ?? [];
    await this.recoverHandoffs(sessions).catch(error => console.warn('[SessionMove] Approvals left by an unfinished move weren\'t checked:', error));
    for (const session of sessions) {
      if (session.move?.state !== 'moving') continue;
      await this.recoverFrozen(session.id).catch(error => console.warn(`[SessionMove] The move of ${session.name} didn't resume:`, error));
    }
  }

  stopNow({ sessionId }: SessionRequest): SessionMoveProgress {
    const job = this.jobs.get(sessionId);
    if (!job) throw new PaneError('ERR_MOVE_NONE', 'This Session is not moving.', 'Nothing to stop.');
    job.stopNow = true;
    return { ...job.progress };
  }

  async cancel({ sessionId }: SessionRequest): Promise<SessionMoveProgress> {
    const job = this.jobs.get(sessionId);
    if (!job) throw new PaneError('ERR_MOVE_NONE', 'This Session is not moving.', 'Nothing to cancel.');
    if (job.progress.frozen) {
      throw new PaneError('ERR_MOVE_FROZEN', `${job.progress.target} may already be running the Session, so the move can't be cancelled from here.`, `Check again, or open the Session on ${job.progress.target}.`);
    }
    job.cancelled = true;
    return { ...job.progress };
  }

  private touch(job: SourceJob, patch: Partial<SessionMoveProgress> = {}): void {
    Object.assign(job.progress, patch, { updatedAt: new Date().toISOString() });
  }

  private setStep(job: SourceJob, id: SessionMoveStepId, state: SessionMoveStep['state'], detail?: string): void {
    job.progress.steps = job.progress.steps.map(step => step.id === id ? { ...step, state, detail } : step);
    this.touch(job);
  }

  private checkCancelled(job: SourceJob): void {
    if (job.cancelled) throw new PaneError('ERR_MOVE_CANCELLED', 'You cancelled the move.', 'The Session is running here again, unchanged.');
  }

  private async run(job: SourceJob): Promise<void> {
    // Held before any tab stops, with any card its tabs post meanwhile: a stopping tab would otherwise end them (T-44).
    job.heldApprovals = this.services.notifyService?.holdMovingApprovals(job.progress.moveId, this.approvalsOf(job.record).carried.map(item => item.id), this.panelIdsOf(job.record)) ?? [];
    await this.stopTabs(job);
    this.checkCancelled(job);
    this.setStep(job, 'stop', 'done', this.stoppedSummary(job));
    this.touch(job, { phase: 'moving', waiting: [] });

    this.setStep(job, 'pack', 'running');
    await fs.promises.mkdir(job.outDir, { recursive: true });
    const record = await this.manager().get({ sessionId: job.record.id });
    // Asked again once every tab stopped: Stop now can leave a queue, and an approval can open while turns end.
    const held = this.heldBackChecks(record, true).find(check => check.level === 'block');
    if (held) throw new PaneError('ERR_MOVE_HELD_BACK', `${held.title}, so the Session didn't move.`, held.detail ?? 'Check again.');
    // The held cards leave this machine now, those its tabs posted since the hold too; one answered
    // meanwhile stays here, with its answer. What leaves is saved first, so a restart here can put it back.
    const notify = this.services.notifyService;
    const moving = [...new Set([...job.heldApprovals, ...this.approvalsOf(record).carried.map(item => item.id)])];
    if (notify && moving.length) await this.saveHandoff(job, notify.movingApprovals(moving));
    const taken = notify?.takeMovingApprovals(job.progress.moveId, moving, job.progress.target) ?? { carried: [], stayed: [] };
    job.heldApprovals = [];
    job.carriedApprovals = taken.carried;
    if (notify && moving.length) await this.saveHandoff(job, taken.carried);
    job.approvalsStayed = taken.stayed.map(card => `“${card.title}” was answered while the move stopped the Session's tabs${card.answer ? ` (${card.answer})` : ''}. The answer stays on ${thisMachineName()}; its tab moved before it heard it, so tell the agent on ${job.progress.target}.`);
    const { manifest, sources } = await this.manifest(record, job.progress.moveId, { outDir: job.outDir, tabs: job.tabs, snapshotRefs: job.snapshotRefs, approvals: taken.carried });
    this.setStep(job, 'pack', 'done', `${manifest.panes.filter(pane => pane.role === 'member').length} Panes, ${manifest.panes.reduce((sum, pane) => sum + pane.tabs.filter(tab => tab.conversation).length, 0)} conversations, the Session folder`);
    this.checkCancelled(job);

    this.setStep(job, 'send', 'running');
    let sent = 0;
    const sender: ChunkSender = {
      write: async (request: WriteRequest) => {
        const result = await job.peer.invoke(SESSION_MOVE_TARGET_CHANNELS.write, [toJsonObject(request)], writeResultSchema, WRITE_TIMEOUT_MS);
        job.lastHeard = Date.now();
        return result;
      },
    };
    for (const file of manifest.files) {
      this.checkCancelled(job);
      await sendFile(sender, manifest.moveId, file.path, sources.get(file.path)!);
      sent += file.bytes;
      this.setStep(job, 'send', 'running', `Sent ${formatBytes(sent)}`);
    }
    const manifestFile = path.join(job.outDir, 'manifest.json');
    await fs.promises.writeFile(manifestFile, JSON.stringify(manifest));
    await sendFile(sender, manifest.moveId, 'manifest.json', manifestFile);
    this.setStep(job, 'send', 'done', `Sent ${formatBytes(sent)}`);

    this.setStep(job, 'build', 'running');
    await this.callTarget(job, SESSION_MOVE_TARGET_CHANNELS.build);
    const built = await this.waitFor(job, ['built'], status => this.setStep(job, 'build', 'running', status.panesTotal ? `${status.panesDone} of ${status.panesTotal} Panes${status.detail ? ` · ${status.detail}` : ''}` : status.detail));
    this.setStep(job, 'build', 'done');

    // The freeze: from here the source never restarts by itself.
    await this.manager().setMoveMark(job.record.id, { state: 'moving', machine: job.progress.target, moveId: job.progress.moveId, at: new Date().toISOString() }, `Moving to ${job.progress.target}.`);
    this.touch(job, { frozen: true });
    this.setStep(job, 'start', 'running');
    await this.callTarget(job, SESSION_MOVE_TARGET_CHANNELS.start).catch(() => undefined);
    this.settle(job, built);
    await job.settling;
  }

  /** Check again after the freeze: a target whose start failed before any tab started is asked to start again. */
  private async recheck(job: SourceJob): Promise<void> {
    const status = await this.callTarget(job, SESSION_MOVE_TARGET_CHANNELS.status).catch(() => undefined);
    if (status?.stage === 'failed' && status.retryable) await this.callTarget(job, SESSION_MOVE_TARGET_CHANNELS.start).catch(() => undefined);
    this.settle(job);
    job.wake?.();
  }

  /**
   * After the freeze: asks the target until its durable record decides the move (F-10, J9). It
   * resends the start while the target says built, retires here once it started, and releases
   * the Session here only on the target's proof it rolled back. Silence keeps it frozen.
   */
  private settle(job: SourceJob, built?: TargetStatus): void {
    if (job.settling || job.progress.phase === 'done' || !job.progress.frozen) return;
    const target = job.progress.target;
    job.settling = settleAfterFreeze({
      status: () => this.callTarget(job, SESSION_MOVE_TARGET_CHANNELS.status),
      start: () => this.callTarget(job, SESSION_MOVE_TARGET_CHANNELS.start),
      rollBack: () => this.callTarget(job, SESSION_MOVE_TARGET_CHANNELS.abort),
    }, {
      onWait: wait => this.showWait(job, wait),
      stopped: () => job.progress.phase === 'done' || !job.progress.frozen || this.jobs.get(job.progress.sessionId) !== job,
      sleep: ms => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ms);
        job.wake = () => { clearTimeout(timer); resolve(); };
      }),
    }).then(outcome => outcome && this.finish(job, outcome, built)).catch(error => {
      console.error(`[SessionMove] The move of ${job.progress.sessionName} couldn't finish:`, error);
      this.touch(job, { phase: 'confirming', error: { message: `The move to ${target} couldn't finish here: ${reasonOf(error)}.`, next: `The Session stays paused here so it never runs twice. Check again, or open it on ${target}.` } });
    }).finally(() => { job.settling = undefined; });
  }

  private showWait(job: SourceJob, wait: FreezeWait): void {
    const target = job.progress.target;
    const stays = `The Session stays paused here so it never runs twice; Pane keeps asking ${target}.`;
    switch (wait.kind) {
      case 'starting':
        this.touch(job, { phase: 'moving', error: undefined, waitReason: undefined });
        return;
      case 'startFailed':
        this.touch(job, { phase: 'confirming', waitReason: 'startFailed', error: { message: wait.status.error?.message ?? `${target} couldn't start the Session.`, next: wait.status.error?.next ?? 'Check again to retry.' } });
        return;
      case 'unknown':
        this.touch(job, { phase: 'confirming', waitReason: 'undecided', error: { message: `${target} answers but can't say yet whether the move finished${wait.status.error ? ` (${wait.status.error.message})` : ''}.`, next: `${stays} Open the Session on ${target} to check it there.` } });
        return;
      case 'answeredError':
        this.touch(job, { phase: 'confirming', waitReason: 'undecided', error: { message: `${target} answers but can't say yet whether the move finished: ${wait.message}`, next: `${stays} ${wait.next ?? `Open Pane on ${target} to check it.`}` } });
        return;
      case 'unreachable':
        if (Date.now() - wait.since < SILENCE_AFTER_FREEZE_MS && job.progress.phase !== 'confirming') return;
        this.touch(job, { phase: 'confirming', waitReason: 'unreachable', error: { message: `${target} isn't answering (${wait.error}).`, next: `${stays} Open Pane on ${target}.` } });
    }
  }

  private async finish(job: SourceJob, outcome: FreezeOutcome, built?: TargetStatus): Promise<void> {
    if (outcome.kind === 'rolledBack') {
      await this.release(job);
      return;
    }
    const status = outcome.status;
    const kept = await this.retire(job);
    this.setStep(job, 'start', 'done', `${status.resumed ?? 0} tabs resumed`);
    this.touch(job, {
      phase: 'done', error: undefined,
      summary: {
        panes: job.paneIds.length - 1, tabs: job.tabs.filter(tab => tab.kind === 'chat' || !!readTabFields(toJsonObject(tab.panel.state.customState ?? {})).agentId).length, resumed: status.resumed ?? 0, failedTabs: status.failedTabs ?? [],
        approvals: status.approvals ?? built?.approvals ?? 0, leftBehind: status.leftBehind ?? built?.leftBehind ?? [], missingEnv: status.missingEnv ?? built?.missingEnv ?? [],
        previewsNotCarried: status.previewsNotCarried ?? built?.previewsNotCarried ?? [], approvalsStayed: job.approvalsStayed, stayedHere: kept,
      },
    });
    await fs.promises.rm(job.outDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** The target proved the move rolled back there: the Session is unfrozen and its tabs restart here. */
  private async release(job: SourceJob): Promise<void> {
    const target = job.progress.target;
    await this.manager().setMoveMark(job.record.id, undefined, `The move to ${target} was rolled back there; the Session runs here again.`);
    this.touch(job, { frozen: false });
    await this.restartHere(job, false);
    this.setStep(job, 'start', 'failed');
    this.touch(job, { phase: 'failed', error: { message: `${target} rolled the move back before it started the Session, so nothing runs there. The Session is running here again, unchanged.`, next: 'Move it again when you are ready.' } });
  }

  /** Archives the moved Panes here; returns what stayed behind instead, for the summary. */
  private async retire(job: SourceJob): Promise<string[]> {
    const manager = this.manager();
    await manager.setMoveMark(job.record.id, { state: 'moved', machine: job.progress.target, moveId: job.progress.moveId, at: new Date().toISOString() }, `Moved to ${job.progress.target}.`);
    // Archiving removes the worktrees; the snapshot refs stay in each repository for Restore, and
    // ignored files (which never travel) are kept beside them.
    const kept: string[] = [];
    for (const paneId of job.paneIds.slice(1)) {
      const pane = this.services.sessionManager.getSession(paneId);
      const worktree = pane?.worktreePath;
      if (worktree && fs.existsSync(worktree)) {
        try {
          await keepIgnoredFiles(worktree, paneId, await ignoredPaths(worktree));
        } catch (error) {
          // Archiving would delete the only copy of those files: this Pane keeps its worktree, still paused.
          console.warn(`[SessionMove] Pane ${paneId}'s ignored files weren't set aside, so it wasn't archived:`, error);
          kept.push(`Pane “${pane?.name ?? paneId}” stays here, paused, with its worktree: its ignored files couldn't be set aside (${reasonOf(error)}). ${error instanceof PaneError && error.next ? error.next : `Copy what you need from ${worktree}, then archive it.`}`);
          continue;
        }
      }
      try {
        await this.registry.invoke('sessions:delete', [paneId]);
      } catch (error) {
        console.warn(`[SessionMove] Pane ${paneId} wasn't archived after the move:`, error);
      }
    }
    return kept;
  }

  private async callTarget(job: SourceJob, channel: string): Promise<TargetStatus> {
    const status = await job.peer.invoke(channel, [{ moveId: job.progress.moveId }], targetStatusSchema, CALL_TIMEOUT_MS);
    job.lastHeard = Date.now();
    return status;
  }

  /** Polls the target until it reaches a wanted stage; a failure or a long silence throws. */
  private async waitFor(job: SourceJob, wanted: TargetStatus['stage'][], onProgress: (status: TargetStatus) => void, silenceMs = SILENCE_BEFORE_FREEZE_MS): Promise<TargetStatus> {
    for (;;) {
      if (!job.progress.frozen) this.checkCancelled(job);
      let status: TargetStatus | undefined;
      try {
        status = await this.callTarget(job, SESSION_MOVE_TARGET_CHANNELS.status);
      } catch (error) {
        if (Date.now() - job.lastHeard > silenceMs) {
          throw new PaneError('ERR_MOVE_TARGET_SILENT', `${job.progress.target} stopped answering (${reasonOf(error)}).`, 'Check that Pane is open on both machines, then try again.');
        }
      }
      if (status) {
        if (wanted.includes(status.stage)) return status;
        if (status.stage === 'failed' || status.stage === 'aborted') {
          throw new PaneError('ERR_MOVE_TARGET_FAILED', status.error?.message ?? `${job.progress.target} couldn't build the Session.`, status.error?.next ?? 'Try again.');
        }
        onProgress(status);
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }

  private stoppedSummary(job: SourceJob): string {
    const stopped = job.tabs.filter(tab => tab.stopped).length;
    return `Stopped ${stopped} tab${stopped === 1 ? '' : 's'}${job.scripts.length ? `, ${job.scripts.length} run script${job.scripts.length === 1 ? '' : 's'}` : ''}`;
  }

  /** P2: each tab stops the moment its turn ends (or at once with Stop now); stopped tabs refuse input. */
  private async stopTabs(job: SourceJob): Promise<void> {
    const mark = (interrupted: boolean): TerminalPausedMark => {
      const moving: TerminalPausedMark = { at: new Date().toISOString(), by: 'move', machine: job.progress.target };
      if (interrupted) moving.interrupted = true;
      return moving;
    };
    for (;;) {
      this.checkCancelled(job);
      const waiting: SessionMoveWaitingTab[] = [];
      // First who is still working, so the dialog shows it at once; then the rest stop together.
      const idle: Array<{ tab: MovedTab; interrupted: boolean }> = [];
      for (const tab of job.tabs.filter(item => !item.stopped)) {
        // A tab only waiting in `runpane watch`, `panels wait` or Notify is idle (P2, D-386).
        const busy = tab.running && (tab.kind === 'terminal'
          ? await terminalPanelManager.isAgentMidTurn(tab.panel.id)
          : getChatTabManager().isMidTurn(tab.panel.id));
        const watching = busy && tab.kind === 'terminal' && runpaneWaits.isWaiting(tab.panel.id);
        if (busy && !watching && !job.stopNow) {
          tab.working = true;
          tab.since ??= new Date().toISOString();
          waiting.push({ panelId: tab.panel.id, title: tab.panel.title, paneName: tab.paneName, since: tab.since });
        } else {
          idle.push({ tab, interrupted: busy && !watching && job.stopNow });
        }
      }
      // Nobody to wait for: the dialog moves on to the steps while the tabs stop.
      this.touch(job, waiting.length === 0 ? { waiting, phase: 'moving' } : { waiting });
      await Promise.all(idle.map(async ({ tab, interrupted }) => {
        try {
          if (tab.kind === 'terminal') {
            // A tab that isn't running is only marked, so nothing starts it during the move.
            const outcome = await terminalPanelManager.pausePanels([tab.panel.id], mark(interrupted));
            if (outcome.failed.length) throw new Error(outcome.failed[0].error);
          } else {
            await getChatTabManager().pauseForMove(tab.panel.id, mark(interrupted), interrupted);
          }
          tab.stopped = true;
          tab.interrupted = interrupted;
        } catch (error) {
          console.warn(`[SessionMove] ${tab.panel.title} didn't stop yet:`, error);
          waiting.push({ panelId: tab.panel.id, title: tab.panel.title, paneName: tab.paneName, since: tab.since });
        }
        this.touch(job, { stoppedTabs: job.tabs.filter(item => item.stopped).length });
      }));
      this.touch(job, { waiting, stoppedTabs: job.tabs.filter(tab => tab.stopped).length });
      if (waiting.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    // Run scripts (dev servers and the like) stop too; Cancel starts them again.
    for (const paneId of job.paneIds.slice(1)) {
      if (await runScriptRunning(paneId)) {
        await stopRunScript(this.registry, paneId);
        job.scripts.push(paneId);
      }
    }
  }

  /**
   * Restarts the stopped tabs here; before the freeze it first asks the target to remove what it
   * made (`askTarget`). Returns whether the target confirmed it removed what it had set up.
   */
  private async restartHere(job: SourceJob, askTarget = true): Promise<boolean> {
    const cleaned = !askTarget || await job.peer.invoke(SESSION_MOVE_TARGET_CHANNELS.abort, [{ moveId: job.progress.moveId }], boundary.json, CALL_TIMEOUT_MS).then(() => true, error => {
      console.warn('[SessionMove] The target could not be told to clean up:', error);
      return false;
    });
    for (const tab of job.tabs.filter(item => item.stopped)) {
      try {
        if (tab.kind === 'terminal') {
          await terminalPanelManager.clearPaused([tab.panel.id]);
          if (tab.running) await this.registry.invoke('runpane:panels:resume', [{ panelId: tab.panel.id }]);
        } else if (tab.running) {
          await getChatTabManager().releaseMove(tab.panel.id);
        } else {
          await getChatTabManager().clearMoveHold(tab.panel.id);
        }
      } catch (error) {
        console.warn(`[SessionMove] ${tab.panel.title} didn't restart:`, error);
      }
      // The agent hears what happened when it was stopped mid-turn or was working.
      if (tab.running && (tab.working || tab.interrupted) && tab.kind === 'terminal') {
        await this.registry.invoke('runpane:panels:submit', [{ panelId: tab.panel.id, input: `[Pane] The move to ${job.progress.target} didn't happen and nothing changed; this Session is running here again.${tab.interrupted ? ' Your last turn was interrupted; pick it up where it stopped.' : ''}`, source: 'agent' }]).catch(() => undefined);
      }
    }
    await restartRunScripts(this.registry, job.scripts);
    // The move didn't happen: its approvals are this machine's again, waiting, their answers going to their tabs here.
    this.services.notifyService?.releaseMovingApprovals(job.progress.moveId, job.heldApprovals);
    const carried = await this.carriedApprovalsOf(job);
    if (carried.length) this.services.notifyService?.adoptMovedApprovals(carried);
    // The move didn't happen: its snapshot refs go, and an earlier move's ref (kept for Restore) comes back.
    for (const { worktree, ref, previous } of job.snapshotRefs) {
      await putBackRef(worktree, ref, previous).catch(error => console.warn(`[SessionMove] ${ref} wasn't put back:`, error));
    }
    await fs.promises.rm(job.outDir, { recursive: true, force: true }).catch(() => undefined);
    return cleaned;
  }

  /** The cards the pack took: from memory, or after a restart here from the handoff it saved. */
  private async carriedApprovalsOf(job: SourceJob): Promise<MovedApproval[]> {
    return job.carriedApprovals ?? readHandoff(job.outDir);
  }

  /** Writes what leaves this machine, before it leaves: the only copy of a waiting card while it travels. */
  private async saveHandoff(job: SourceJob, approvals: readonly MovedApproval[]): Promise<void> {
    await fs.promises.mkdir(job.outDir, { recursive: true });
    const file = path.join(job.outDir, HANDOFF_FILE);
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(approvals));
    await fs.promises.rename(`${file}.tmp`, file);
  }

  /**
   * On app start: a move that took cards and never froze (Pane quit between the pack and the freeze)
   * gives them back here, waiting again. A frozen move settles them itself; a finished one keeps none.
   */
  private async recoverHandoffs(sessions: readonly OrchestrationSessionRecord[]): Promise<void> {
    const root = path.join(getAppDirectory(), 'moves-out');
    const moves: string[] = await fs.promises.readdir(root).catch(() => []);
    for (const moveId of moves) {
      const outDir = path.join(root, moveId);
      if (!fs.existsSync(path.join(outDir, HANDOFF_FILE))) continue;
      const mark = sessions.find(session => session.move?.moveId === moveId)?.move;
      if (mark?.state === 'moving') continue;
      try {
        if (mark?.state !== 'moved') {
          const approvals = await readHandoff(outDir);
          if (approvals.length) this.services.notifyService?.adoptMovedApprovals(approvals);
        }
        await fs.promises.rm(path.join(outDir, HANDOFF_FILE), { force: true });
      } catch (error) {
        console.warn(`[SessionMove] The approvals of move ${moveId} weren't put back here:`, error);
      }
    }
  }

  private async fail(job: SourceJob, error: Error): Promise<void> {
    console.error(`[SessionMove] Move of ${job.progress.sessionName} failed:`, error);
    const cancelled = error instanceof PaneError && error.code === 'ERR_MOVE_CANCELLED';
    if (job.progress.frozen) {
      // B may already run the agents: stay frozen and say so.
      this.touch(job, { phase: 'confirming', error: { message: reasonOf(error), next: `The Session stays paused here so it never runs twice. Check again, or open it on ${job.progress.target}.` } });
      return;
    }
    const cleaned = await this.restartHere(job);
    const running = job.progress.steps.find(step => step.state === 'running');
    if (running) this.setStep(job, running.id, 'failed');
    const there = cleaned
      ? `${job.progress.target} removed everything it had set up.`
      : `${job.progress.target} didn't answer; it removes what it had set up on its own once the move stops arriving.`;
    const failure = error instanceof PaneError
      ? { message: `${error.message} ${there} The Session is running here again, unchanged.`, next: error.next ?? 'Try again.' }
      : { message: `${reasonOf(error)}. ${there} The Session is running here again, unchanged.`, next: 'Try again.' };
    this.touch(job, cancelled ? { phase: 'cancelled', error: undefined } : { phase: 'failed', error: failure });
  }
}

/** The approvals a move took from this machine, saved in its outbox before they left. */
const HANDOFF_FILE = 'approvals.json';

async function readHandoff(outDir: string): Promise<MovedApproval[]> {
  const text = await fs.promises.readFile(path.join(outDir, HANDOFF_FILE), 'utf8').catch(() => null);
  if (!text) return [];
  return movedApprovals(decodeBoundary(JSON.parse(text), boundary.array(boundary.jsonObject)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
