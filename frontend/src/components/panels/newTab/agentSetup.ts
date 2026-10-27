import { agentInstallCommand, agentPreset, type AgentLaunchPresetId } from '../../../../../shared/constants/agentLaunchPresets';
import type { ProjectEnvironment } from '../../../../../shared/types/panels';
import type { PanelCreateOptions } from '../../../types/panelComponents';
import { isWindows } from '../../../utils/platformUtils';

export type AgentSetupKind = 'install' | 'sign-in';

/**
 * A plain terminal tab with the agent's install or sign-in command typed and
 * left for the person to run. Undefined when the agent has no install command
 * for this environment.
 */
export function agentSetupTerminal(
  agent: AgentLaunchPresetId,
  kind: AgentSetupKind,
  environment: ProjectEnvironment | undefined,
): PanelCreateOptions | undefined {
  const preset = agentPreset(agent);
  const command = kind === 'sign-in'
    ? preset.signInCommand
    : agentInstallCommand(agent, environment ?? (isWindows() ? 'windows' : 'macos'));
  if (!command) return undefined;
  return {
    title: kind === 'sign-in' ? `Sign in to ${preset.title}` : `Install ${preset.title}`,
    // launchCommand outlives the one-shot stagedCommand, so the tab stays a working tab and never becomes the dock.
    initialState: { customState: { stagedCommand: command, launchCommand: command } },
  };
}
