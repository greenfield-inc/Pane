import type { RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { PaneChatAgent } from '../../../shared/types/paneChat';
import type { VoiceTranscriptionMode } from '../../../shared/types/voiceTranscription';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';
import type { AppearanceMode, DarkTheme, LightTheme, Theme } from '../../../shared/types/appearance';

export interface TerminalShortcut {
  id: string;
  label: string;
  key: string;
  text: string;
  enabled: boolean;
}

interface CustomCommand {
  name: string;
  command: string;
}

type TerminalPowerMode = 'performance' | 'batterySaver';

export interface AnalyticsIdentity {
  distinctId: string;
  identitySource: 'email' | 'github' | 'git_name' | 'posthog' | 'anonymous';
  installId?: string;
  appVersion?: string;
  platform?: string;
  electronVersion?: string;
  webDistinctId?: string;
  webAttributionPresent?: boolean;
  isFirstLaunch?: boolean;
  previousVersion?: string | null;
  githubUsername?: string;
  githubEmail?: string;
  gitEmail?: string;
  gitEmailHash?: string;
  gitUserName?: string;
}

interface AnalyticsConfig {
  enabled: boolean;
  posthogApiKey?: string;
  posthogHost?: string;
  installId?: string;
  distinctId?: string;
  identitySource?: AnalyticsIdentity['identitySource'];
  githubUsername?: string;
  githubEmail?: string;
  gitEmail?: string;
  gitEmailHash?: string;
  gitUserName?: string;
}

export interface AppConfig {
  verbose?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  falApiKey?: string;
  openRouterApiKey?: string;
  deepgramApiKey?: string;
  voiceTranscriptionMode?: VoiceTranscriptionMode;
  // Legacy fields for backward compatibility
  gitRepoPath?: string;
  systemPromptAppend?: string;
  runScript?: string[];
  // Custom claude executable path (for when it's not in PATH)
  claudeExecutablePath?: string;
  // Permission mode for all sessions
  defaultPermissionMode?: 'approve' | 'ignore';
  // Default model for new sessions
  defaultModel?: string;
  // Default agent used by the global Pane Chat orchestrator terminal
  defaultOrchestratorAgent?: PaneChatAgent;
  // Auto-check for updates
  autoCheckUpdates?: boolean;
  // Start Pane automatically when the user logs in
  autoStartOnBoot?: boolean;
  // Keep the computer awake while any session is active
  keepAwakeWhileSessionsActive?: boolean;
  // Stravu MCP integration
  stravuApiKey?: string;
  stravuServerUrl?: string;
  // Theme preference
  appearanceMode?: AppearanceMode;
  theme?: Theme;
  systemLightTheme?: LightTheme;
  systemDarkTheme?: DarkTheme;
  // Opt-in high contrast mode: raises muted chrome text to AAA and the terminal's
  // minimumContrastRatio so dim CLI output stays legible
  highContrast?: boolean;
  // UI scale factor (0.75 to 1.5, default 1.0)
  uiScale?: number;
  // Notification settings
  notifications?: {
    playSound: boolean;
    enabled: boolean;
  };
  // Dev mode for debugging
  devMode?: boolean;
  // Additional paths to add to PATH environment variable
  additionalPaths?: string[];
  // Session creation preferences
  sessionCreationPreferences?: {
    sessionCount?: number;
    toolType?: 'claude' | 'none';
    selectedTools?: {
      claude?: boolean;
    };
    claudeConfig?: {
      model?: 'auto' | 'sonnet' | 'opus' | 'haiku';
      permissionMode?: 'ignore' | 'approve';
      ultrathink?: boolean;
    };
    showAdvanced?: boolean;
    startPinned?: boolean;
    baseBranch?: string;
  };
  // Pane commit footer setting (enabled by default)
  enableCommitFooter?: boolean;
  // Inject Pane's git committer identity (GIT_COMMITTER_NAME/EMAIL) into commits
  // made through Pane (enabled by default). Applies to newly spawned terminals
  // and commands only — already-running processes keep their launch-time env.
  gitAttributionEnabled?: boolean;
  // Agent-facing Pane context
  agentContext?: {
    /** Write a marked Pane section into repository AGENTS.md files (off by default; edits the repo). */
    managedAgentsMd?: boolean;
    /** Install Pane's managed skill in the user's home skill folders (default on). */
    homeSkill?: boolean;
    /** Agent-context defaults already applied to this config; see configManager migrations. */
    defaultsVersion?: number;
  };
  // Use interactive mode for Claude CLI (persistent process with stdin instead of spawn-per-message)
  useInteractiveMode?: boolean;
  // Route PTY spawns through an isolated ptyHost UtilityProcess for crash
  // isolation. On by default on Windows. Requires app restart; the supervisor is forked
  // once at `app.whenReady`.
  usePtyHost?: boolean;
  // PostHog analytics settings
  analytics?: AnalyticsConfig;
  // User-defined custom commands for the Add Tool picker
  customCommands?: CustomCommand[];
  // Terminal shortcuts — hotkey-triggered clipboard paste snippets
  terminalShortcuts?: TerminalShortcut[];
  // Whether Pane intercepts application keyboard shortcuts
  keyboardShortcutsEnabled?: boolean;
  // Whether the Command Palette shortcut remains active when other shortcuts are disabled
  commandPaletteShortcutEnabled?: boolean;
  // Whether the terminal answers kitty keyboard protocol requests (CSI = | ? | > | < u)
  kittyKeyboardEnabled?: boolean;
  // Worktree file sync — files/dirs to copy from main repo into new worktrees
  worktreeFileSync?: WorktreeFileSyncEntry[];
  // Preferred shell for Windows terminals
  preferredShell?: 'auto' | 'gitbash' | 'powershell' | 'pwsh' | 'cmd';
  // Terminal rendering/power behavior
  terminalPowerMode?: TerminalPowerMode;
  // Self-hosted remote daemon settings and saved client profiles
  remoteDaemon?: RemoteDaemonConfig;
  terminalFontFamily?: string;
  terminalFontSize?: number;
}

export type PreferredShell = NonNullable<AppConfig['preferredShell']>;
export type PreferredTerminalPowerMode = NonNullable<AppConfig['terminalPowerMode']>;

export interface UpdateConfigRequest {
  verbose?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  falApiKey?: string;
  openRouterApiKey?: string;
  deepgramApiKey?: string;
  voiceTranscriptionMode?: VoiceTranscriptionMode;
  claudeExecutablePath?: string;
  systemPromptAppend?: string;
  defaultPermissionMode?: 'approve' | 'ignore';
  defaultModel?: string;
  defaultOrchestratorAgent?: PaneChatAgent;
  autoCheckUpdates?: boolean;
  autoStartOnBoot?: boolean;
  keepAwakeWhileSessionsActive?: boolean;
  stravuApiKey?: string;
  stravuServerUrl?: string;
  theme?: AppConfig['theme'];
  appearanceMode?: AppearanceMode;
  systemLightTheme?: LightTheme;
  systemDarkTheme?: DarkTheme;
  highContrast?: boolean;
  uiScale?: number;
  notifications?: AppConfig['notifications'];
  devMode?: boolean;
  additionalPaths?: string[];
  sessionCreationPreferences?: AppConfig['sessionCreationPreferences'];
  enableCommitFooter?: boolean;
  gitAttributionEnabled?: boolean;
  agentContext?: AppConfig['agentContext'];
  useInteractiveMode?: boolean;
  usePtyHost?: boolean;
  analytics?: AnalyticsConfig;
  customCommands?: CustomCommand[];
  terminalShortcuts?: TerminalShortcut[];
  keyboardShortcutsEnabled?: boolean;
  commandPaletteShortcutEnabled?: boolean;
  kittyKeyboardEnabled?: boolean;
  worktreeFileSync?: WorktreeFileSyncEntry[];
  preferredShell?: PreferredShell;
  terminalPowerMode?: PreferredTerminalPowerMode;
  terminalFontFamily?: string;
  terminalFontSize?: number;
}
