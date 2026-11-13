export type SettingsCategoryId =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'links'
  | 'ai-agents'
  | 'agents'
  | 'usage'
  | 'worktrees-git'
  | 'notify'
  | 'autopilot'
  | 'notifications'
  | 'remote-access'
  | 'integrations'
  | 'secrets'
  | 'shortcuts'
  | 'privacy'
  | 'import-export'
  | 'advanced';

export type RemoteAccessSubviewId = 'host-setup' | 'advanced-host';

export type SettingsSettingId =
  | 'automatic-updates'
  | 'check-updates-now'
  | 'send-feedback'
  | 'start-on-login'
  | 'keep-awake'
  | 'keep-awake-plugged-in'
  | 'keep-awake-on-battery'
  | 'resume-paused-on-open'
  | 'auto-pause'
  | 'auto-pause-hours'
  | 'html-file-open-mode'
  | 'theme'
  | 'appearance-mode'
  | 'system-light-theme'
  | 'system-dark-theme'
  | 'high-contrast'
  | 'ui-scale'
  | 'sidebar-pane-rows'
  | 'attention-inbox'
  | 'terminal-font-family'
  | 'terminal-font-size'
  | 'terminal-power-mode'
  | 'terminal-copy-on-select'
  | 'terminal-references-enabled'
  | 'terminal-reference-paste-mode'
  | 'terminal-reference-line-count'
  | 'terminal-shell'
  | 'custom-links'
  | 'default-pane-chat-agent'
  | 'chat-tab-keys'
  | 'chat-agents'
  | 'mcp-registration'
  | 'mcp-toolsets'
  | 'answer-prompts-from-pane'
  | 'agent-skill'
  | 'agent-context'
  | 'session-defaults'
  | 'claude-executable'
  | 'session-import'
  | 'commit-footer'
  | 'git-attribution'
  | 'auto-rename-pr'
  | 'worktree-file-sync'
  | 'default-ide-command'
  | 'notify-enabled'
  | 'notify-cards-on'
  | 'notify-show-outside'
  | 'notify-position'
  | 'notify-shortcut'
  | 'notify-updates-hide-after'
  | 'notify-sound'
  | 'notify-show-details'
  | 'notification-permission'
  | 'notification-sound'
  | 'desktop-notifications'
  | 'remote-pane'
  | 'remote-add-code'
  | 'remote-machines'
  | 'remote-visibility'
  | 'remote-password'
  | 'remote-address'
  | 'remote-glasses'
  | 'remote-host-setup'
  | 'remote-host-mode'
  | 'remote-advanced-host'
  | 'remote-paired-connection'
  | 'remote-existing-profile'
  | 'voice-transcription'
  | 'apns-credentials'
  | 'pane-secrets'
  | 'keyboard-shortcuts'
  | 'keyboard-shortcut-map'
  | 'command-palette-shortcut'
  | 'kitty-keyboard'
  | 'terminal-shortcuts'
  | 'analytics'
  | 'browser-data'
  | 'setup-transfer'
  | 'verbose-logging'
  | 'developer-mode'
  | 'journey-timings'
  | 'pty-host'
  | 'additional-paths'
  | 'mission-control'
  | 'chat-tabs'
  | 'autopilot'
  | 'autopilot-instructions'
  | 'notes'
  | 'usage-leaderboard';

export interface SettingsTarget {
  category: SettingsCategoryId;
  setting?: SettingsSettingId;
  subview?: RemoteAccessSubviewId;
  /** Remote Access: the Tailscale machine whose password field opens. */
  machine?: string;
}

export interface SettingsOpenRequest {
  target: SettingsTarget;
  nonce: number;
}

export type SettingSaveState =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'error'; message: string };

export const SETTINGS_PREFERENCE_KEYS = {
  autoRenameSessionsToPr: 'auto_rename_sessions_to_pr',
  sidebarPaneRowLayout: 'sidebar_pane_row_layout',
  sidebarAttentionInbox: 'sidebar_attention_inbox',
  atTerminalPasteMode: 'at_terminal_paste_mode',
  atTerminalLineCount: 'at_terminal_line_count',
} as const;

export type SidebarPaneRowLayout = 'single' | 'two-row';
type AtTerminalPasteMode = 'raw' | 'embed';
export const AT_TERMINAL_LINE_COUNT_PRESETS = [100, 300, 500, -1] as const;
type AtTerminalLineCount = typeof AT_TERMINAL_LINE_COUNT_PRESETS[number];

export interface SettingsPreferenceValues {
  autoRenameSessionsToPr: boolean;
  sidebarPaneRowLayout: SidebarPaneRowLayout;
  sidebarAttentionInbox: boolean;
  atTerminalPasteMode: AtTerminalPasteMode;
  atTerminalLineCount: AtTerminalLineCount;
}

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferenceValues = {
  autoRenameSessionsToPr: true,
  sidebarPaneRowLayout: 'single',
  sidebarAttentionInbox: false,
  atTerminalPasteMode: 'raw',
  atTerminalLineCount: 500,
};

export function normalizeSidebarPaneRowLayout(value: string | null | undefined): SidebarPaneRowLayout {
  return value === 'two-row' ? 'two-row' : 'single';
}

export function parseSettingsPreferences(raw: Record<string, string | null | undefined>): SettingsPreferenceValues {
  const lineCount = Number.parseInt(raw[SETTINGS_PREFERENCE_KEYS.atTerminalLineCount] ?? '', 10);
  return {
    autoRenameSessionsToPr: raw[SETTINGS_PREFERENCE_KEYS.autoRenameSessionsToPr] !== 'false',
    sidebarPaneRowLayout: normalizeSidebarPaneRowLayout(raw[SETTINGS_PREFERENCE_KEYS.sidebarPaneRowLayout]),
    sidebarAttentionInbox: raw[SETTINGS_PREFERENCE_KEYS.sidebarAttentionInbox] === 'true',
    atTerminalPasteMode: raw[SETTINGS_PREFERENCE_KEYS.atTerminalPasteMode] === 'embed' ? 'embed' : 'raw',
    atTerminalLineCount: AT_TERMINAL_LINE_COUNT_PRESETS.find(preset => preset === lineCount)
      ?? DEFAULT_SETTINGS_PREFERENCES.atTerminalLineCount,
  };
}

export function serializeSettingPreference<K extends keyof SettingsPreferenceValues>(
  _key: K,
  value: SettingsPreferenceValues[K],
): string {
  return String(value);
}
