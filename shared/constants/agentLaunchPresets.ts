import { CONFIGURED_AGENT_IDS, agentTerminalCommand, configuredAgent, type ConfiguredAgentId } from '../agents';
import { agentTerminalShortcutId, type KeyboardShortcutId } from './keyboardShortcuts';

export type AgentLaunchPresetId = ConfiguredAgentId;

export interface AgentLaunchPreset {
  id: AgentLaunchPresetId;
  title: string;
  command: string;
  iconKey: string;
  hotkeyId: KeyboardShortcutId;
  hotkey: string;
  platforms?: readonly string[];
}

/** One terminal launch preset per configured agent, from the agents config (shared/agents.ts). */
export const AGENT_LAUNCH_PRESETS: readonly AgentLaunchPreset[] = CONFIGURED_AGENT_IDS.map(id => {
  const agent = configuredAgent(id);
  const preset: AgentLaunchPreset = { id, title: agent.title, command: agentTerminalCommand(id), iconKey: agent.icon, hotkeyId: agentTerminalShortcutId(id), hotkey: agent.terminal.hotkey };
  if (agent.terminal.platforms) preset.platforms = agent.terminal.platforms;
  return preset;
});

export function agentPresetsForPlatform(platform: string): readonly AgentLaunchPreset[] {
  return AGENT_LAUNCH_PRESETS.filter(preset => isAgentSupportedOnPlatform(preset.id, platform));
}

export function isAgentSupportedOnPlatform(agent: AgentLaunchPresetId, platform: string): boolean {
  const normalizedPlatform = platform === 'macos'
    ? 'darwin'
    : platform === 'windows' ? 'win32' : platform;
  const preset = AGENT_LAUNCH_PRESETS.find(candidate => candidate.id === agent);
  return Boolean(preset && (!preset.platforms || preset.platforms.includes(normalizedPlatform)));
}
