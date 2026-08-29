import type { KeyboardShortcutId } from './keyboardShortcuts';

export type AgentLaunchPresetId = 'claude' | 'codex' | 'cursor';

export interface AgentLaunchPreset {
  id: AgentLaunchPresetId;
  title: string;
  command: string;
  iconKey: string;
  hotkeyId: KeyboardShortcutId;
  platforms?: readonly string[];
}

/*
 * Launch templates duplicated from contracts/runpane/contract.json
 * agentTemplates so the renderer doesn't bundle the full generated contract.
 * agentLaunchPresets.test.ts pins this list 1:1 against the contract.
 */
export const AGENT_LAUNCH_PRESETS: readonly AgentLaunchPreset[] = [
  {
    id: 'claude',
    title: 'Claude Code',
    command: 'claude --dangerously-skip-permissions',
    iconKey: 'claude',
    hotkeyId: 'add-tool-terminal-claude',
  },
  {
    id: 'codex',
    title: 'Codex',
    command: 'codex --yolo',
    iconKey: 'codex',
    hotkeyId: 'add-tool-terminal-codex',
  },
  {
    id: 'cursor',
    title: 'Cursor',
    command: 'cursor-agent --force --trust',
    iconKey: 'cursor',
    hotkeyId: 'add-tool-terminal-cursor',
    platforms: ['darwin', 'linux', 'wsl'],
  },
];

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
