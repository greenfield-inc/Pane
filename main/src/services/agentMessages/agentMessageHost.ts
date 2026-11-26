import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry } from '../../daemon/commandRegistry';
import { typeIntoLocalTab } from '../../ipc/notify';
import type { AppServices } from '../../ipc/types';
import { getChatTabManager } from '../chatTabs';
import { panelManager } from '../panelManager';
import { terminalPanelManager } from '../terminalPanelManager';
import type { AgentMessageHost, MessagePanelInfo } from './agentMessageService';

const panelAgentSchema = boundary.object({ agentType: boundary.optional(boundary.string) });
const resumeResultSchema = boundary.object({ action: boundary.optional(boundary.string) });
const screenSchema = boundary.object({ composer: boundary.object({ hasUndeliveredText: boundary.boolean }) });

/**
 * Binds AgentMessageService to the running Pane. A reply is typed the way to-do messages and owed
 * answers are (typeIntoLocalTab: only at a live agent's prompt), and a tab that is down is resumed
 * through `runpane panels resume`.
 */
export function createAgentMessageHost(services: AppServices, commandRegistry: PaneCommandRegistry): AgentMessageHost {
  const panel = (panelId: string): MessagePanelInfo | null => {
    const found = panelManager.getPanel(panelId);
    if (!found) return null;
    const membership = services.orchestrationSessionManager?.todoSessionOfPanel(panelId, found.sessionId);
    const pane = services.sessionManager.getSession(found.sessionId);
    const paneName = pane?.name ?? found.title;
    const name = membership?.orchestrator
      ? `the "${membership.sessionName}" Session orchestrator`
      : membership ? `${paneName} (in the "${membership.sessionName}" Session)` : paneName;
    const agent = found.type === 'chat' || decodeOptionalBoundary(found.state.customState, panelAgentSchema)?.agentType !== undefined;
    return { panelId, paneId: found.sessionId, sessionId: membership?.sessionId ?? null, name, orchestrator: membership?.orchestrator ?? false, agent };
  };

  return {
    panel,
    orchestratorPanel: sessionId => services.orchestrationSessionManager?.todoSessionInfo(sessionId)?.orchestratorPanelId ?? null,

    isMidTurn(panelId: string): boolean {
      const found = panelManager.getPanel(panelId);
      if (!found) return false;
      return found.type === 'chat' ? getChatTabManager().isMidTurn(panelId) : terminalPanelManager.isMidTurn(panelId);
    },

    async hasUnsentText(panelId: string): Promise<boolean> {
      const found = panelManager.getPanel(panelId);
      if (!found || found.type !== 'terminal' || !terminalPanelManager.isTerminalInitialized(panelId)) return false;
      try {
        const screen = decodeOptionalBoundary(await commandRegistry.invoke('runpane:panels:screen', [{ panelId }]), screenSchema);
        // Unknown counts as unsent: Pane never types over the person.
        return screen?.composer.hasUndeliveredText !== false;
      } catch {
        return true;
      }
    },

    async isPanelDown(panelId: string): Promise<boolean> {
      const found = panelManager.getPanel(panelId);
      if (!found) return true;
      if (found.type === 'chat') return !getChatTabManager().isRunning(panelId);
      if (!terminalPanelManager.isTerminalInitialized(panelId)) return true;
      return terminalPanelManager.hasLaunchCommandExited(panelId);
    },

    async resumePanel(panelId: string): Promise<boolean> {
      const result = decodeOptionalBoundary(await commandRegistry.invoke('runpane:panels:resume', [{ panelId }]), resumeResultSchema);
      return result?.action === 'resumed' || result?.action === 'already-running';
    },

    typeIntoTab: (panelId, text) => typeIntoLocalTab(commandRegistry, panelId, text),

    log(message: string, error?: Error | string): void {
      if (error) services.logger?.warn(message, error instanceof Error ? error : new Error(error));
      else services.logger?.info(message);
    },
  };
}
