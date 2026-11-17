import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { isConfiguredAgent } from '../../../../shared/agents';
import { PaneError } from '../../../../shared/paneError';
import type { NotifyQuestion, NotifyResult, NotifySource } from '../../../../shared/types/notify';
import type { LibraryProfile, Profile, ProfileRun } from '../../../../shared/types/profiles';
import type { RunpaneCommandToolSpec } from '../../../../shared/types/runpaneOrchestration';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry } from '../../daemon/commandRegistry';
import type { AppServices } from '../../ipc/types';
import { getAppDirectory } from '../../utils/appDirectory';
import { ShellDetector } from '../../utils/shellDetector';
import { getRuntimeConfigManager } from '../../core/runtime';
import { agentFarmConfigRoot, bundledAgentFarm } from '../agentFarm/bundledAgentFarm';
import { panelManager } from '../panelManager';
import { sessionWorkspacePath } from '../sessionWorkspace';
import type { WorkspaceJournal } from '../workspaceJournal';
import { listProfiles } from './profileLibrary';
import { ProfileRunner, profileRunsFolder, type CardOutcome, type RunCard, type StartedTab, type StepShell, type StepTabRequest } from './profileRunner';

let runner: ProfileRunner | undefined;
let quitting = false;

/** Pane is quitting: tabs it stops don't finish their steps, and cards it ends aren't closed by you. */
export function prepareProfileRunnerForQuit(): void {
  quitting = true;
  runner?.prepareForQuit();
}

/** The profile runner this Pane started, for IPC and runpane. */
export function getProfileRunner(): ProfileRunner {
  if (!runner) throw new PaneError('PROFILE_RUNNER_NOT_READY', 'Pane has not started its profile runner yet.', 'Wait for Pane to finish starting, then try again.');
  return runner;
}

/** The library as config sets it now: bundled profiles on or off, and the person's own. */
function currentProfiles(): LibraryProfile[] {
  return listProfiles({ paneDir: getAppDirectory(), enabled: getRuntimeConfigManager().getConfig().profiles?.enabled });
}

/** `blocked` is Pane's own prompt detection (`detectPanelBlocker`), as `panels wait` reports it. */
const readinessSchema = boundary.optional(boundary.object({ blocked: boundary.optional(boundary.object({ message: boundary.string })) }));
const createdPane = boundary.object({ items: boundary.array(boundary.object({ ok: boundary.boolean, paneId: boundary.optional(boundary.string), panelId: boundary.optional(boundary.string), error: boundary.optional(boundary.object({ message: boundary.string })), readiness: readinessSchema })) });
const createdPanel = boundary.object({ paneId: boundary.string, panelId: boundary.string, readiness: readinessSchema });

function stepShell(services: AppServices, run: ProfileRun): StepShell {
  // A WSL repository's tabs run its distribution's bash, whatever Windows' own shell is.
  if (services.databaseService.getProject(run.repoId)?.wsl_enabled) return 'posix';
  const name = ShellDetector.getDefaultShell(getRuntimeConfigManager().getPreferredShell()).name.toLowerCase();
  if (name.includes('powershell') || name.includes('pwsh')) return 'powershell';
  if (name === 'cmd' || name === 'cmd.exe') return 'cmd';
  if (name.includes('fish')) return 'fish';
  return 'posix';
}

/**
 * A `reads` file as the agent opens it, from the folders the loader resolved it in (an overlay's
 * own, then its base's). A bundled plugin's folder is read from its installed copy in Pane's
 * Agent Farm config root, because app.asar is unreadable to agents.
 */
function readPath(profile: Profile, id: string): string | undefined {
  const loaded = currentProfiles().find((candidate) => candidate.name === profile.name);
  const bundle = bundledAgentFarm();
  const bundledPlugins = bundle ? path.join(bundle.root, 'plugins') : undefined;
  const installedPlugins = path.join(agentFarmConfigRoot(getAppDirectory()), 'plugins');
  const roots = (loaded?.readsRoots ?? []).map((root) => (bundledPlugins && path.dirname(root) === bundledPlugins ? path.join(installedPlugins, path.basename(root)) : root));
  for (const root of roots) {
    for (const file of [path.join(root, 'instructions', `${id}.md`), path.join(root, `${id}.md`)]) {
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

function cardOutcome(result: NotifyResult): CardOutcome {
  if ('answer' in result) return { answer: result.answer };
  if ('reply' in result) return { answer: result.reply };
  if (quitting) return { quitting: true };
  return { closed: 'unavailable' in result ? result.unavailable : 'closed' };
}

/** Exit codes a shell gives a command killed by SIGHUP (its tab closed), SIGINT (Ctrl+C) or SIGTERM. */
const INTERRUPTED_EXIT_CODES = new Set([129, 130, 143]);

/**
 * Starts the profile runner on this Pane's services: step tabs through runpane's own
 * `panes create` and `panels create`, cards through Approvals, tab exits from the workspace
 * journal. Resumes saved runs without waiting.
 */
export function startProfileRunner(services: AppServices, registry: PaneCommandRegistry, journal: WorkspaceJournal, log: (message: string) => void): ProfileRunner {
  const pendingCards = new Map<string, Promise<NotifyResult>>();
  const queue = () => {
    const notify = services.notifyService?.queue;
    if (!notify) throw new PaneError('PROFILE_APPROVALS_UNAVAILABLE', 'Approvals are not running in this Pane, so a profile run can\'t ask you anything.', 'Restart Pane, then launch the profile again.');
    return notify;
  };
  /**
   * The baseline for a CLI Pane doesn't know: Pane can't tell when its input is ready, so it types
   * the first message as one line, then Enter, once the command has started and its output goes quiet.
   */
  const typeFirstMessage = async (panelId: string, command: string, message: string) => {
    // The shell echoes the command when it runs it; until then the shell itself would read the message.
    const program = command.trim().split(/\s+/u)[0] ?? '';
    await registry.invoke('runpane:panels:wait', [{ panelId, condition: 'text', contains: `${program} `, timeoutMs: 30_000 }]).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await registry.invoke('runpane:panels:wait', [{ panelId, condition: 'idle', timeoutMs: 20_000 }]).catch(() => undefined);
    await registry.invoke('runpane:panels:input', [{ panelId, input: `${message.replace(/\s*\n\s*/gu, ' ')}\r`, source: 'agent' }]);
  };
  const openTab = async (request: StepTabRequest, tool: RunpaneCommandToolSpec): Promise<StartedTab> => {
    // An agent Pane knows waits until its input box is ready for the first message; anything else just runs.
    const waitReady = tool.initialInput !== undefined;
    if (request.newPane) {
      const result = decodeBoundary(await registry.invoke('runpane:panes:create', [{
        repo: { id: request.run.repoId }, panes: [{ name: request.newPane.name, tool }],
        associateSession: request.run.sessionId, source: 'agent', noFocus: true, waitReady,
      }]), createdPane);
      const item = result.items[0];
      if (!item?.paneId || !item.panelId) throw new PaneError('PROFILE_STEP_START_FAILED', `Pane couldn't open the run's first Pane: ${item?.error?.message ?? 'no Pane was created'}`, 'Check the repository in Pane, then launch the profile again.');
      const started: StartedTab = { paneId: item.paneId, panelId: item.panelId };
      if (item.readiness?.blocked) started.blocked = item.readiness.blocked.message;
      return started;
    }
    if (!request.run.paneId) throw new PaneError('PROFILE_STEP_START_FAILED', 'The run has no Pane for its next step.', 'Launch the profile again.');
    const created = decodeBoundary(await registry.invoke('runpane:panels:create', [{ paneId: request.run.paneId, tool, source: 'agent', noFocus: true, waitReady }]), createdPanel);
    const started: StartedTab = { paneId: created.paneId, panelId: created.panelId };
    if (created.readiness?.blocked) started.blocked = created.readiness.blocked.message;
    return started;
  };
  const startTab = async (request: StepTabRequest): Promise<StartedTab> => {
    const tool: RunpaneCommandToolSpec = { command: request.command, title: request.title };
    if (request.agentType && isConfiguredAgent(request.agentType)) tool.agentType = request.agentType;
    // Pane delivers the first message only to an agent it recognises; the baseline types it after.
    if (request.initialInput && tool.agentType) tool.initialInput = request.initialInput;
    const started = await openTab(request, tool);
    if (request.initialInput && !tool.agentType) await typeFirstMessage(started.panelId, request.command, request.initialInput);
    return started;
  };
  const postCard = (card: RunCard) => {
    const question: NotifyQuestion = { ui: card.ui, title: card.title, context: card.context };
    // A card with buttons takes only its own choices: a typed reply could never move the run.
    if (card.choices) Object.assign(question, { choices: card.choices, optionsOnly: true });
    const source: NotifySource = { name: `${card.run.profile} run`, agent: 'Pane profile' };
    if (card.run.paneId) source.paneId = card.run.paneId;
    pendingCards.set(card.id, queue().ask({ question, source, id: card.id }));
  };
  const waitCard = async (approvalId: string): Promise<CardOutcome> => {
    let result = await (pendingCards.get(approvalId) ?? queue().ask({ resume: approvalId, source: { name: 'Pane profile', agent: 'Pane profile' } }));
    pendingCards.delete(approvalId);
    while ('waiting' in result) result = await queue().ask({ resume: approvalId, source: { name: 'Pane profile', agent: 'Pane profile' } });
    if ('unavailable' in result) log(`[Profiles] Approval ${approvalId} is unavailable: ${result.unavailable}`);
    return cardOutcome(result);
  };
  runner = new ProfileRunner({
    now: () => new Date().toISOString(),
    profile: (name) => {
      const loaded = currentProfiles().find((candidate) => candidate.name === name);
      return loaded?.launchable ? loaded.profile : undefined;
    },
    readPath,
    runsFolder: (sessionId) => profileRunsFolder(sessionWorkspacePath(sessionId)),
    allRunsFolders: () => {
      const sessions = path.join(getAppDirectory(), 'sessions');
      try { return readdirSync(sessions).map((entry) => profileRunsFolder(path.join(sessions, entry))).filter((folder) => existsSync(folder)); }
      catch { return []; }
    },
    shell: (run) => stepShell(services, run),
    startTab,
    tabExists: (panelId) => panelManager.getPanel(panelId) !== undefined,
    postCard,
    cardOpen: (approvalId) => queue().waitingItems().some((item) => item.id === approvalId),
    waitCard,
    closeCard: (approvalId, summary) => services.notifyService?.queue.settle(approvalId, summary),
    log,
  });
  journal.subscribe((entry) => {
    if (entry.kind !== 'panel.exited' || !entry.panelId) return;
    // node-pty reports signal 0 for a normal exit, which the journal writes as `signal:0`.
    const signal = /^signal:(.+)$/u.exec(entry.reason ?? '')?.[1];
    const interrupted = (signal !== undefined && signal !== '0') || (entry.exitCode !== undefined && INTERRUPTED_EXIT_CODES.has(entry.exitCode));
    void runner?.tabExited(entry.panelId, { code: entry.exitCode, interrupted }).catch((error) => log(`[Profiles] ${String(error)}`));
  });
  void runner.resumeAll().catch((error) => log(`[Profiles] Could not resume profile runs: ${String(error)}`));
  return runner;
}
