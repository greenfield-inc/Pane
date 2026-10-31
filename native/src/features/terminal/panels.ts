import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';
import type { OrchestrationSessionRecord } from '@shared/types/orchestrationSession';
import type { EditorPanelState, ToolPanel, ToolPanelType } from '@shared/types/panels';
import type { RemotePwaCustomCommand } from '@shared/types/remoteDaemon';

/** How the phone draws a tab. A placeholder names the computer, where the tab opens. */
export type TabView = 'terminal' | 'browser' | 'explorer' | 'editor' | 'placeholder';

export function tabView(panel: ToolPanel): TabView {
  switch (panel.type) {
    case 'terminal':
    case 'browser':
    case 'explorer':
      return panel.type;
    case 'editor':
      return (panel.state.customState as EditorPanelState | undefined)?.diff ? 'placeholder' : 'editor';
    default:
      return 'placeholder';
  }
}

/** Strip groups, as the web phone app sorts them: agents and terminals, pages, Explorer and Diff, other tabs, desktop-only tabs. */
const STRIP_GROUP: Record<ToolPanelType, number> = {
  terminal: 0,
  browser: 1,
  explorer: 2,
  diff: 2,
  editor: 3,
  logs: 3,
  notes: 4,
  dashboard: 4,
  'setup-tasks': 4,
};

/** Every tab of a pane, in strip order; each group keeps the pane's tab order. */
export function stripPanels(panels: readonly ToolPanel[]): ToolPanel[] {
  return [...panels].sort((a, b) => STRIP_GROUP[a.type] - STRIP_GROUP[b.type] || a.metadata.position - b.metadata.position);
}

/**
 * Whether the phone moves to this tab when the computer brings it forward: only tabs on the
 * desktop's stage that the phone draws. Explorer and Diff live in the desktop's side panel and
 * are often reported as active, so the phone never jumps to them.
 */
export function followsHost(panel: ToolPanel): boolean {
  return panel.type !== 'explorer' && panel.type !== 'diff' && tabView(panel) !== 'placeholder';
}

/**
 * The tab to show: the one picked on this phone while it still exists, else
 * the host's active tab when the phone follows it there, else the first tab.
 */
export function pickPanel(
  panels: readonly ToolPanel[],
  selectedId: string | null,
  hostActiveId: string | null | undefined,
): ToolPanel | null {
  return panels.find(panel => panel.id === selectedId)
    ?? panels.find(panel => panel.id === hostActiveId && followsHost(panel))
    ?? panels[0]
    ?? null;
}

/**
 * A Session's tabs, as on desktop: its current agent's chat first, then the
 * workspace's own tabs. Chats of agents the Session no longer uses stay hidden.
 */
export function sessionWorkspacePanels(
  view: { session: Pick<OrchestrationSessionRecord, 'panelIds'>; panel: ToolPanel },
  panels: readonly ToolPanel[],
): ToolPanel[] {
  const chatIds = new Set(Object.values(view.session.panelIds));
  const chat = panels.find(panel => panel.id === view.panel.id) ?? view.panel;
  return [chat, ...panels.filter(panel => !chatIds.has(panel.id))];
}

export interface NewPanelOption {
  id: string;
  title: string;
  /** The line under the title in the Add tool list. */
  description: string;
  /** Command the host runs when the panel starts; none opens a shell. */
  initialCommand?: string;
}

/** The web app's Add tool menu: a shell, the agent presets, then the host's custom commands. */
export function newPanelOptions(customCommands: readonly RemotePwaCustomCommand[]): NewPanelOption[] {
  return [
    { id: 'terminal', title: 'Terminal', description: 'Start a shell on the remote host' },
    ...AGENT_LAUNCH_PRESETS.map(preset => ({
      id: preset.id,
      title: preset.title,
      description: `Run ${preset.command}`,
      initialCommand: preset.command,
    })),
    ...customCommands.map((command, index) => ({
      id: `custom-${index}`,
      title: command.name,
      description: command.command,
      initialCommand: command.command,
    })),
  ];
}

/** `panels:create` arguments for a new terminal tab. */
export function createPanelRequest(sessionId: string, option: NewPanelOption) {
  return {
    sessionId,
    type: 'terminal' as const,
    title: option.title,
    initialState: option.initialCommand ? { customState: { initialCommand: option.initialCommand } } : undefined,
  };
}
