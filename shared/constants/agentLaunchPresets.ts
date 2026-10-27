export type AgentLaunchPresetId = 'claude' | 'codex' | 'cursor' | 'opencode';

export interface AgentLaunchPreset {
  id: AgentLaunchPresetId;
  title: string;
  command: string;
  iconKey: string;
  hotkeyId: string;
  hotkey: string;
  platforms?: readonly string[];
  /** The vendor's sign-in command, typed for the user to run. */
  signInCommand: string;
  /** The vendor's install command for macOS, Linux and WSL shells, and for native Windows (any shell). */
  installCommand: { unix: string; windows?: string };
  docsUrl: string;
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
    signInCommand: 'claude auth login',
    installCommand: { unix: 'curl -fsSL https://claude.ai/install.sh | bash', windows: 'npm install -g @anthropic-ai/claude-code' },
    docsUrl: 'https://code.claude.com/docs/en/setup',
  },
  {
    id: 'codex',
    title: 'Codex',
    command: 'codex --yolo',
    iconKey: 'codex',
    hotkeyId: 'add-tool-terminal-codex',
    hotkey: 'mod+alt+4',
    signInCommand: 'codex login',
    installCommand: { unix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', windows: 'npm install -g @openai/codex' },
    docsUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'cursor',
    title: 'Cursor',
    command: 'cursor-agent --force --trust',
    iconKey: 'cursor',
    hotkeyId: 'add-tool-terminal-cursor',
    hotkey: 'mod+alt+5',
    platforms: ['darwin', 'linux', 'wsl'],
    signInCommand: 'cursor-agent login',
    installCommand: { unix: 'curl https://cursor.com/install -fsS | bash' },
    docsUrl: 'https://cursor.com/docs/cli/installation',
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    command: 'opencode --auto',
    iconKey: 'opencode',
    hotkeyId: 'add-tool-terminal-opencode',
    hotkey: 'mod+alt+6',
    signInCommand: 'opencode auth login',
    installCommand: { unix: 'curl -fsSL https://opencode.ai/install | bash', windows: 'npm install -g opencode-ai' },
    docsUrl: 'https://opencode.ai/docs',
  },
];

export function agentPreset(agent: AgentLaunchPresetId): AgentLaunchPreset {
  const preset = AGENT_LAUNCH_PRESETS.find(candidate => candidate.id === agent);
  if (!preset) throw new Error(`Unknown agent preset: ${agent}`);
  return preset;
}

/** The install command for a repo environment: `windows` for native Windows repos, else the shell installer. */
export function agentInstallCommand(agent: AgentLaunchPresetId, platform: string): string | undefined {
  const { installCommand } = agentPreset(agent);
  return platform === 'windows' || platform === 'win32' ? installCommand.windows : installCommand.unix;
}

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
