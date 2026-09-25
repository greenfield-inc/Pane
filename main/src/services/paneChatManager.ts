import { prepareSessionWorkspace, sessionWorkspacePath } from './sessionWorkspace';
import { randomUUID } from 'crypto';
import { withLock } from '../utils/mutex';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import type { ConfigManager } from './configManager';
import type { SessionManager } from './sessionManager';
import type { SkillCacheManager } from './skillCacheManager';
import type { Session } from '../types/session';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import {
  getPaneChatPanelId,
  normalizePaneChatAgent,
  PANE_CHAT_SESSION_ID,
  type PaneChatAgent,
  type PaneChatState,
} from '../../../shared/types/paneChat';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { isAgentSupportedOnPlatform } from '../../../shared/constants/agentLaunchPresets';
import { isCliAgentType } from './agents/agentIdentity';

const PANE_CHAT_TITLE = 'Pane Chat';
const PANE_CHAT_BOOTSTRAP_VERSION = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_PATTERN.test(value);
}

export class PaneChatManager {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly sessionManager: SessionManager,
    private readonly skillCacheManager: SkillCacheManager | undefined,
  ) {}

  async getOrCreate(): Promise<PaneChatState<Session>> {
    return withLock('pane-chat-session', async () => {
      const configuredAgent = normalizePaneChatAgent(this.configManager.getConfig().defaultOrchestratorAgent);
      return this.getOrCreateForAgent(configuredAgent);
    });
  }

  async setAgent(agent: PaneChatAgent): Promise<PaneChatState<Session>> {
    return withLock('pane-chat-session', async () => {
      const normalizedAgent = normalizePaneChatAgent(agent);
      this.assertAgentSupported(normalizedAgent);
      await this.configManager.updateConfig({ defaultOrchestratorAgent: normalizedAgent });
      return this.getOrCreateForAgent(normalizedAgent);
    });
  }

  private async getOrCreateForAgent(agent: PaneChatAgent): Promise<PaneChatState<Session>> {
    this.assertAgentSupported(agent);
    const guidePath = await this.ensureGuidePath();
    const cwd = prepareSessionWorkspace('legacy-pane-chat', this.configManager.getConfig().defaultSessionProfile);
    const session = this.ensureSession(cwd);
    const panel = await this.ensurePanel(session.id, agent);
    await panelManager.setActivePanel(session.id, panel.id);
    const resolvedAgent = this.resolvePanelAgent(panel) ?? agent;

    return {
      session,
      panel,
      agent: resolvedAgent,
      cwd,
      guidePath,
      started: terminalPanelManager.isTerminalInitialized(panel.id),
    };
  }

  private assertAgentSupported(agent: PaneChatAgent): void {
    if (!isAgentSupportedOnPlatform(agent, process.platform)) {
      throw new Error(`${RUNPANE_CONTRACT.agentTemplates[agent].title} is not supported on ${process.platform}.`);
    }
  }

  private async ensureGuidePath(): Promise<string> {
    if (!this.skillCacheManager) {
      throw new Error('Pane Chat skill cache manager is not initialized');
    }

    return this.skillCacheManager.ensurePaneChatGuide();
  }

  private ensureSession(cwd: string): Session {
    const existingSession = this.sessionManager.getSession(PANE_CHAT_SESSION_ID);
    if (existingSession) {
      return existingSession;
    }

    const session = this.sessionManager.createSessionWithId(
      PANE_CHAT_SESSION_ID,
      PANE_CHAT_TITLE,
      cwd,
      '',
      'pane-chat',
      'ignore',
      undefined,
      false,
      undefined,
      'none',
      undefined,
      undefined,
      false,
      { detached: true, hidden: true },
    );
    this.sessionManager.updateSession(session.id, { status: 'stopped' });
    return this.sessionManager.getSession(session.id) ?? session;
  }

  private async ensurePanel(sessionId: string, agent: PaneChatAgent): Promise<ToolPanel> {
    const panelId = getPaneChatPanelId(agent);
    const existingPanel = panelManager.getPanel(panelId);
    if (existingPanel) {
      const existingAgent = this.resolvePanelAgent(existingPanel) ?? agent;
      const isInitialized = terminalPanelManager.isTerminalInitialized(existingPanel.id);
      const needsAgentSwitch = existingAgent !== agent;
      const needsRepair = needsAgentSwitch || (!isInitialized && this.needsLaunchStateRepair(existingPanel, existingAgent));
      if (needsAgentSwitch && isInitialized) {
        await terminalPanelManager.destroyTerminal(existingPanel.id);
      }

      if (!isInitialized || needsRepair) {
        await this.updatePanelLaunchState(existingPanel, agent, isInitialized && !needsAgentSwitch);
      }
      return panelManager.getPanel(panelId) ?? existingPanel;
    }

    return panelManager.createPanel({
      id: panelId,
      sessionId,
      type: 'terminal',
      title: agent === 'claude'
        ? PANE_CHAT_TITLE
        : `${PANE_CHAT_TITLE} - ${RUNPANE_CONTRACT.agentTemplates[agent].title}`,
      initialState: this.buildTerminalState(agent),
      metadata: { permanent: true },
    });
  }

  private async updatePanelLaunchState(panel: ToolPanel, agent: PaneChatAgent, wasInitialized: boolean): Promise<void> {
    // SAFETY: Pane Chat owns this terminal panel and writes its custom state exclusively as TerminalPanelState.
    const previousCustomState = panel.state.customState as TerminalPanelState | undefined;
    const shouldResetClaudeLaunch = agent === 'claude' && !isValidUuid(previousCustomState?.agentSessionId) && !wasInitialized;
    // Bootstrap metadata may change after an app upgrade. An initialized panel
    // already owns a live conversation, so refreshing the launch metadata must
    // never clear its durable scrollback, serialized buffer, or captured agent id.
    const nextCustomState: TerminalPanelState = {
      ...previousCustomState,
      ...this.buildTerminalState(agent, previousCustomState, shouldResetClaudeLaunch),
      initialInputSentAt: wasInitialized ? previousCustomState?.initialInputSentAt : undefined,
      initialInputError: wasInitialized ? previousCustomState?.initialInputError : undefined,
    };

    if (shouldResetClaudeLaunch && !wasInitialized) {
      nextCustomState.hasClaudeSessionId = undefined;
    }

    const nextState = {
      ...panel.state,
      customState: nextCustomState,
    };

    await panelManager.updatePanel(panel.id, { state: nextState });
  }

  private buildTerminalState(
    agent: PaneChatAgent,
    previousState?: TerminalPanelState,
    forceNewAgentSession = false,
  ): TerminalPanelState {
    const agentSessionId = this.resolveAgentSessionId(agent, previousState, forceNewAgentSession);

    const panelState: TerminalPanelState = {
      initialCommand: this.skillCacheManager?.launchCommand(agent) ?? RUNPANE_CONTRACT.agentTemplates[agent].command,
      initialInput: undefined,
      orchestrationSessionId: 'legacy-pane-chat',
      orchestrationWorkspace: sessionWorkspacePath('legacy-pane-chat'),
      orchestrationProfile: this.configManager.getConfig().defaultSessionProfile,
      initialInputMode: 'argument',
      initialInputSubmitStrategy: 'enter',
      initialInputDeliveryVersion: PANE_CHAT_BOOTSTRAP_VERSION,
      agentType: agent,
      isCliPanel: true,
      isCliReady: false,
    };
    if (agentSessionId) panelState.agentSessionId = agentSessionId;
    return panelState;
  }

  private resolveAgentSessionId(agent: PaneChatAgent, previousState?: TerminalPanelState, forceNewAgentSession = false): string | undefined {
    if (agent === 'claude') {
      return !forceNewAgentSession && isValidUuid(previousState?.agentSessionId)
        ? previousState.agentSessionId
        : randomUUID();
    }

    // Codex and Cursor own their ids; reuse only what was captured for this agent.
    return previousState?.agentType === agent ? previousState.agentSessionId : undefined;
  }

  private needsLaunchStateRepair(panel: ToolPanel, agent: PaneChatAgent): boolean {
    // SAFETY: Pane Chat owns this terminal panel and writes its custom state exclusively as TerminalPanelState.
    const customState = panel.state.customState as TerminalPanelState | undefined;
    return this.needsBootstrapRefresh(customState) || (agent === 'claude' && !isValidUuid(customState?.agentSessionId));
  }

  private needsBootstrapRefresh(customState: TerminalPanelState | undefined): boolean {
    const expectedInputMode = 'argument';
    const expectedSubmitStrategy = 'enter';
    return (
      customState?.initialInputMode !== expectedInputMode ||
      customState?.initialInputSubmitStrategy !== expectedSubmitStrategy ||
      customState?.initialInputDeliveryVersion !== PANE_CHAT_BOOTSTRAP_VERSION
    );
  }

  private resolvePanelAgent(panel: ToolPanel): PaneChatAgent | undefined {
    // SAFETY: Pane Chat owns this terminal panel and writes its custom state exclusively as TerminalPanelState.
    const customState = panel.state.customState as TerminalPanelState | undefined;
    return isCliAgentType(customState?.agentType) ? customState?.agentType : undefined;
  }
}
