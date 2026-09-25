import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';
import type { ToolPanel } from '@shared/types/panels';
import type { RemotePwaCustomCommand } from '@shared/types/remoteDaemon';

/** The pane's terminal panels in tab order. Other panel types (diff, editor, …) are desktop-only. */
export function terminalPanels(panels: readonly ToolPanel[]): ToolPanel[] {
  return panels
    .filter(panel => panel.type === 'terminal')
    .sort((a, b) => a.metadata.position - b.metadata.position);
}

/**
 * The tab to show: the one picked on this phone while it still exists, else
 * the panel active on the host, else the first terminal.
 */
export function pickPanel(
  panels: readonly ToolPanel[],
  selectedId: string | null,
  hostActiveId: string | null | undefined,
): ToolPanel | null {
  return panels.find(panel => panel.id === selectedId)
    ?? panels.find(panel => panel.id === hostActiveId)
    ?? panels[0]
    ?? null;
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
