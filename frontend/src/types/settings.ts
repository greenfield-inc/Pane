export type SettingsCategoryId =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'ai-agents'
  | 'usage'
  | 'worktrees-git'
  | 'notifications'
  | 'remote-access'
  | 'integrations'
  | 'shortcuts'
  | 'privacy'
  | 'advanced';

export type RemoteAccessSubviewId = 'host-setup' | 'connections' | 'advanced-host';

export type SettingsSettingId =
  | 'automatic-updates'
  | 'check-updates-now'
  | 'send-feedback'
  | 'start-on-login'
  | 'keep-awake'
  | 'theme'
  | 'appearance-mode'
  | 'system-light-theme'
  | 'system-dark-theme'
  | 'high-contrast'
  | 'ui-scale'
  | 'sidebar-pane-rows'
  | 'terminal-font-family'
  | 'terminal-font-size'
  | 'terminal-power-mode'
  | 'terminal-reference-paste-mode'
  | 'terminal-reference-line-count'
  | 'terminal-shell'
  | 'default-pane-chat-agent'
  | 'agent-context'
  | 'session-defaults'
  | 'claude-executable'
  | 'commit-footer'
  | 'git-attribution'
  | 'auto-rename-pr'
  | 'worktree-file-sync'
  | 'notification-permission'
  | 'notification-sound'
  | 'desktop-notifications'
  | 'remote-pane'
  | 'remote-host-setup'
  | 'remote-host-mode'
  | 'remote-connections'
  | 'remote-connection-code'
  | 'remote-advanced-host'
  | 'remote-paired-connection'
  | 'remote-existing-profile'
  | 'voice-transcription'
  | 'keyboard-shortcuts'
  | 'command-palette-shortcut'
  | 'kitty-keyboard'
  | 'terminal-shortcuts'
  | 'analytics'
  | 'verbose-logging'
  | 'developer-mode'
  | 'journey-timings'
  | 'pty-host'
  | 'additional-paths';

export interface SettingsTarget {
  category: SettingsCategoryId;
  setting?: SettingsSettingId;
  subview?: RemoteAccessSubviewId;
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
  atTerminalPasteMode: 'at_terminal_paste_mode',
  atTerminalLineCount: 'at_terminal_line_count',
} as const;

export type SidebarPaneRowLayout = 'single' | 'two-row';
type AtTerminalPasteMode = 'raw' | 'embed';
type AtTerminalLineCount = 100 | 300 | 500 | -1;

export interface SettingsPreferenceValues {
  autoRenameSessionsToPr: boolean;
  sidebarPaneRowLayout: SidebarPaneRowLayout;
  atTerminalPasteMode: AtTerminalPasteMode;
  atTerminalLineCount: AtTerminalLineCount;
}

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferenceValues = {
  autoRenameSessionsToPr: true,
  sidebarPaneRowLayout: 'single',
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
    atTerminalPasteMode: raw[SETTINGS_PREFERENCE_KEYS.atTerminalPasteMode] === 'embed' ? 'embed' : 'raw',
    atTerminalLineCount: lineCount === 100 || lineCount === 300 || lineCount === 500 || lineCount === -1
      ? lineCount
      : 500,
  };
}

export function serializeSettingPreference<K extends keyof SettingsPreferenceValues>(
  _key: K,
  value: SettingsPreferenceValues[K],
): string {
  return String(value);
}
