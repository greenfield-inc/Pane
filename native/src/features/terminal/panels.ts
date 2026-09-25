import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';
import type { ToolPanel } from '@shared/types/panels';

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
  /** Command the host runs when the panel starts; none opens a shell. */
  initialCommand?: string;
}

export const NEW_PANEL_OPTIONS: readonly NewPanelOption[] = [
  { id: 'terminal', title: 'Terminal' },
  ...AGENT_LAUNCH_PRESETS.map(preset => ({ id: preset.id, title: preset.title, initialCommand: preset.command })),
];

/** `panels:create` arguments for a new terminal tab. */
export function createPanelRequest(sessionId: string, option: NewPanelOption) {
  return {
    sessionId,
    type: 'terminal' as const,
    title: option.title,
    initialState: option.initialCommand ? { customState: { initialCommand: option.initialCommand } } : undefined,
  };
}
