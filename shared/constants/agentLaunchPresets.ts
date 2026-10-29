export type AgentLaunchPresetId = 'claude' | 'codex' | 'cursor' | 'opencode';

export interface AgentLaunchPreset {
  id: AgentLaunchPresetId;
  title: string;
  command: string;
  iconKey: string;
  hotkeyId: string;
  hotkey: string;
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
    hotkey: 'mod+alt+3',
  },
  {
    id: 'codex',
    title: 'Codex',
    command: 'codex --yolo',
    iconKey: 'codex',
    hotkeyId: 'add-tool-terminal-codex',
    hotkey: 'mod+alt+4',
  },
  {
    id: 'cursor',
    title: 'Cursor',
    command: 'cursor-agent --force --trust',
    iconKey: 'cursor',
    hotkeyId: 'add-tool-terminal-cursor',
    hotkey: 'mod+alt+5',
    platforms: ['darwin', 'linux', 'wsl'],
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    command: 'opencode --auto',
    iconKey: 'opencode',
    hotkeyId: 'add-tool-terminal-opencode',
    hotkey: 'mod+alt+6',
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
