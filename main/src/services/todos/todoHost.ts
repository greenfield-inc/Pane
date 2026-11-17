import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { NotifyQuestion, NotifySource } from '../../../../shared/types/notify';
import { PANE_ONE_TIME_PROMPT_OPENING } from '../../../../shared/types/paneChat';
import type { TodoListRow } from '../../../../shared/types/todos';
import type { PaneCommandRegistry } from '../../daemon/commandRegistry';
import { typeIntoLocalTab } from '../../ipc/notify';
import { archiveTodoSessionPanes } from '../../ipc/runpane';
import type { AppServices } from '../../ipc/types';
import { thisMachineName } from '../approvals/approvalStore';
import { getChatTabManager } from '../chatTabs';
import { readMemoryPressure } from '../machineHealth/memoryPressure';
import { machineCpuTimes, type CpuTimes } from '../machineHealth/machineHealthService';
import { panelManager } from '../panelManager';
import { terminalPanelManager } from '../terminalPanelManager';
import type { LoadSample, MemoryLevel } from './loadGate';
import type { CreatedTodoSession, TodoCard, TodoHost, TodoPanelInfo, TodoSessionInfo } from './todoService';

const resumeResultSchema = boundary.object({ action: boundary.optional(boundary.string) });
const screenSchema = boundary.object({ composer: boundary.object({ hasUndeliveredText: boundary.boolean }) });

/** Test-only: a fixed machine-wide CPU percent, as PANE_MEMORY_PRESSURE_TEST_LEVEL fixes memory pressure. */
function cpuTestPercent(): number | null {
  const raw = process.env.PANE_CPU_LOAD_TEST_PERCENT;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

/**
 * Binds TodoService to the running Pane: Sessions, tabs, approvals, archive and machine load. Every
 * typed message goes through the same path an owed answer does (typeIntoLocalTab: only at a live
 * agent's prompt), and every start through `runpane panels resume`.
 */
export function createTodoHost(services: AppServices, commandRegistry: PaneCommandRegistry): TodoHost {
  let lastCpu: CpuTimes | null = null;
  const sessions = () => {
    const manager = services.orchestrationSessionManager;
    if (!manager) throw new Error('Sessions are not running in this Pane process.');
    return manager;
  };

  const panelInfo = (panelId: string): TodoPanelInfo | null => {
    const panel = panelManager.getPanel(panelId);
    if (!panel) return null;
    const membership = services.orchestrationSessionManager?.todoSessionOfPanel(panelId, panel.sessionId);
    const pane = services.sessionManager.getSession(panel.sessionId);
    return {
      name: membership?.orchestrator ? 'orchestrator' : pane?.name ?? panel.title,
      sessionId: membership?.sessionId ?? null,
      sessionName: membership?.sessionName,
      orchestrator: membership?.orchestrator ?? false,
      agentId: membership?.orchestrator ? membership.agent : undefined,
      paneId: panel.sessionId,
    };
  };

  return {
    machineName: () => thisMachineName(),

    async createSession(input): Promise<CreatedTodoSession> {
      const manager = sessions();
      // As Ask an agent does: the opening prompt rides on the agent's launch line where the shell allows it.
      const atLaunch = terminalPanelManager.launchShellIsPosix();
      const view = await manager.create({
        name: input.name, isPinned: false, launchCommand: '', customResume: null,
        agent: input.agent === 'claude' || input.agent === 'codex' || input.agent === 'cursor' ? input.agent : undefined,
        openingPrompt: atLaunch ? `${PANE_ONE_TIME_PROMPT_OPENING}, to start a to-do. ${input.openingPrompt}` : undefined,
      });
      if (view.panel.type === 'terminal') await terminalPanelManager.initializeTerminal(view.panel, view.internalSession.worktreePath);
      return { sessionId: view.session.id, orchestratorPanelId: view.panel.id, prompted: atLaunch };
    },

    session(sessionId: string): TodoSessionInfo | null {
      const record = services.orchestrationSessionManager?.todoSessionInfo(sessionId);
      if (!record) return null;
      return { id: record.id, name: record.name, orchestratorPanelId: record.orchestratorPanelId, archived: record.archived, paneIds: record.paneIds, agentId: record.agent };
    },

    panel: panelInfo,

    projectName: projectId => services.databaseService.getProject(projectId)?.name ?? null,

    isMidTurn(panelId: string): boolean {
      const panel = panelManager.getPanel(panelId);
      if (!panel) return false;
      return panel.type === 'chat' ? getChatTabManager().isMidTurn(panelId) : terminalPanelManager.isMidTurn(panelId);
    },

    async hasUnsentText(panelId: string): Promise<boolean> {
      const panel = panelManager.getPanel(panelId);
      // Pane can't see a chat tab's draft; a chat tab queues a typed message behind it instead.
      if (!panel || panel.type !== 'terminal' || !terminalPanelManager.isTerminalInitialized(panelId)) return false;
      try {
        const screen = decodeOptionalBoundary(await commandRegistry.invoke('runpane:panels:screen', [{ panelId }]), screenSchema);
        // Unknown counts as unsent: Pane never types over the person.
        return screen?.composer.hasUndeliveredText !== false;
      } catch {
        return true;
      }
    },

    async isPanelDown(panelId: string): Promise<boolean> {
      const panel = panelManager.getPanel(panelId);
      if (!panel) return true;
      if (panel.type === 'chat') return !getChatTabManager().isRunning(panelId);
      if (!terminalPanelManager.isTerminalInitialized(panelId)) return true;
      return terminalPanelManager.hasLaunchCommandExited(panelId);
    },

    typeIntoTab: (panelId, text) => typeIntoLocalTab(commandRegistry, panelId, text),

    async resumePanel(panelId: string): Promise<boolean> {
      const result = decodeOptionalBoundary(await commandRegistry.invoke('runpane:panels:resume', [{ panelId }]), resumeResultSchema);
      return result?.action === 'resumed' || result?.action === 'already-running';
    },

    async pausePanels(panelIds: string[]): Promise<void> {
      const mark = { at: new Date().toISOString(), by: 'auto' as const };
      const chats = panelIds.filter(panelId => panelManager.getPanel(panelId)?.type === 'chat');
      const terminals = panelIds.filter(panelId => panelManager.getPanel(panelId)?.type === 'terminal');
      if (terminals.length > 0) await terminalPanelManager.pausePanels(terminals, mark);
      if (chats.length > 0) await getChatTabManager().pause(chats, mark);
    },

    isPanelProtected(panelId: string): boolean {
      const paneId = panelManager.getPanel(panelId)?.sessionId;
      if (!paneId) return false;
      if (services.databaseService.getSession(paneId)?.is_favorite) return true;
      return services.getMainWindow()?.isFocused() === true && services.gitStatusManager.getActiveSessionId() === paneId;
    },

    // Pane knows an agent's usage limit only from Codex's account samples, not per tab: none yet.
    usageLimitUntil: () => null,

    ask(card: TodoCard) {
      const queue = services.notifyService?.queue;
      if (!queue) return Promise.resolve({ unavailable: 'Approvals are not running.', next: 'Turn on Approvals in Settings.' });
      const owner = card.todo.sessionId ? services.orchestrationSessionManager?.todoSessionInfo(card.todo.sessionId) : undefined;
      const asker = card.askerPanelId ? panelManager.getPanel(card.askerPanelId) : undefined;
      const source: NotifySource = asker
        ? { name: owner?.name ?? card.todo.ref, agent: owner?.agent ?? 'Agent', paneId: asker.sessionId, panelId: asker.id }
        : { name: card.todo.ref, agent: 'Pane' };
      if (!asker && owner) source.session = { id: owner.id, name: owner.name, paneId: owner.ownPaneId };
      const question: NotifyQuestion = card.choices.length > 0
        ? { ui: 'options', title: card.title, context: card.context, choices: card.choices.map((label, index) => ({ label, recommended: index === 0 })), links: card.links }
        : { ui: 'ask', title: card.title, context: card.context, links: card.links };
      question.todo = { number: card.todo.number, title: card.todo.title, kind: card.kind };
      return queue.ask({ id: card.id, question, source });
    },

    archiveSessionPanes: sessionId => archiveTodoSessionPanes(services, commandRegistry, sessionId),

    async restoreSession(sessionId: string): Promise<void> {
      await sessions().update({ sessionId }, { archived: false, isPinned: false });
    },

    async sampleLoad(): Promise<Omit<LoadSample, 'at'>> {
      const memory = await readMemoryPressure().then(reading => reading.level, (): MemoryLevel => 'unknown');
      const fixed = cpuTestPercent();
      const times = machineCpuTimes();
      const cpuPercent = fixed ?? (lastCpu && times.total > lastCpu.total ? Math.round((1 - (times.idle - lastCpu.idle) / (times.total - lastCpu.total)) * 1000) / 10 : null);
      lastCpu = times;
      return { cpuPercent, memory };
    },

    loadGateEnabled: () => services.configManager.getConfig().machineHealth?.holdTodoAgents !== false,

    prOf(paneIds: string[]): TodoListRow['pr'] | undefined {
      for (const paneId of paneIds) {
        const status = services.gitStatusManager.getCachedStatus(paneId)?.status;
        if (!status?.prNumber) continue;
        const state = status.prState === 'MERGED' ? 'Merged' : status.prState === 'CLOSED' ? 'Closed' : status.prIsDraft ? 'Draft' : 'Open';
        return { number: status.prNumber, label: `#${status.prNumber} · ${state}`, url: status.prUrl };
      }
      return undefined;
    },

    log(message: string, error?: Error | string): void {
      if (error) services.logger?.warn(message, error instanceof Error ? error : new Error(error));
      else services.logger?.info(message);
    },
  };
}
