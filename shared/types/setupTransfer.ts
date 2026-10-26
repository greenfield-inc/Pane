import type { CustomCommandResume } from './customCommandResume';
import type { PaneChatAgent } from './paneChat';
import type { VoiceTranscriptionMode } from './voiceTranscription';
import type { WorktreeFileSyncEntry } from './worktreeFileSync';
import type { AppearanceMode, DarkTheme, LightTheme, Theme } from './appearance';
import type { SessionRetention } from './orchestrationSession';

/**
 * A Pane setup file (`pane-setup-YYYY-MM-DD.json`): an allowlisted copy of one
 * computer's setup that Settings › Import & Export writes and reads.
 * See docs/SETUP_EXPORT_IMPORT.md.
 */
export const SETUP_FILE_KIND = 'pane-setup';
export const SETUP_FILE_VERSION = 1;

/** Row order on the card. */
export const SETUP_SECTION_IDS = [
  'agentPresets',
  'customCommands',
  'runScripts',
  'skills',
  'terminalShortcuts',
  'worktreeFileSync',
  'appearance',
  'preferences',
] as const;
export type SetupSectionId = typeof SETUP_SECTION_IDS[number];

export interface SetupCustomCommand {
  name: string;
  command: string;
  resume?: CustomCommandResume | null;
}

export interface SetupTerminalShortcut {
  id: string;
  label: string;
  key: string;
  text: string;
  enabled: boolean;
}

export interface SetupAgentPresets {
  defaultOrchestratorAgent?: PaneChatAgent;
  defaultAgentInterface?: 'terminal' | 'chat';
  defaultSessionCommand?: string;
  defaultSessionResume?: CustomCommandResume | null;
  defaultSessionProfile?: string;
  defaultSessionPinned?: boolean;
  defaultPermissionMode?: 'approve' | 'ignore';
  defaultModel?: string;
}

/** One repository's saved scripts, keyed by its origin remote. */
export interface SetupRunScripts {
  name: string;
  /** The origin remote as host/owner/repo, or null when the repository had none. */
  remote: string | null;
  build_script?: string;
  run_script?: string;
  archive_script?: string;
}

export interface SetupSkills {
  homeSkill?: boolean;
  registerMcp?: boolean;
  mcpToolsets?: string[];
}

export interface SetupAppearance {
  appearanceMode?: AppearanceMode;
  theme?: Theme;
  systemLightTheme?: LightTheme;
  systemDarkTheme?: DarkTheme;
  highContrast?: boolean;
  uiScale?: number;
  terminalFontFamily?: string;
  terminalFontSize?: number;
}

export interface SetupSessionCreationPreferences {
  sessionCount?: number;
  toolType?: 'claude' | 'none';
  selectedTools?: { claude?: boolean };
  claudeConfig?: {
    model?: 'auto' | 'sonnet' | 'opus' | 'haiku';
    permissionMode?: 'ignore' | 'approve';
    ultrathink?: boolean;
  };
  showAdvanced?: boolean;
  startPinned?: boolean;
}

/** Config keys of the Preferences section. */
export interface SetupPreferenceConfig {
  notifications?: { playSound: boolean; enabled: boolean };
  keyboardShortcutsEnabled?: boolean;
  commandPaletteShortcutEnabled?: boolean;
  kittyKeyboardEnabled?: boolean;
  htmlFileOpenMode?: 'preview' | 'source';
  enableCommitFooter?: boolean;
  gitAttributionEnabled?: boolean;
  autoCheckUpdates?: boolean;
  keepAwakeWhileSessionsActive?: boolean;
  keepAwakeWhilePluggedIn?: boolean;
  keepAwakeOnBattery?: boolean;
  terminalPowerMode?: 'performance' | 'batterySaver';
  retention?: Partial<SessionRetention>;
  voiceTranscriptionMode?: VoiceTranscriptionMode;
  missionControlEnabled?: boolean;
  experimentalChatEnabled?: boolean;
  sessionCreationPreferences?: SetupSessionCreationPreferences;
}

/** user_preferences keys that mean the same on every computer. */
export const SETUP_PREFERENCE_KEYS = [
  'auto_rename_sessions_to_pr',
  'sidebar_pane_row_layout',
  'sidebar_attention_inbox',
  'at_terminal_paste_mode',
  'at_terminal_line_count',
] as const;
export type SetupPreferenceKey = typeof SETUP_PREFERENCE_KEYS[number];

export type SetupPreferences = SetupPreferenceConfig & Partial<Record<SetupPreferenceKey, string>>;

export interface SetupSections {
  agentPresets?: SetupAgentPresets;
  customCommands?: SetupCustomCommand[];
  runScripts?: SetupRunScripts[];
  skills?: SetupSkills;
  terminalShortcuts?: SetupTerminalShortcut[];
  worktreeFileSync?: WorktreeFileSyncEntry[];
  appearance?: SetupAppearance;
  preferences?: SetupPreferences;
}

export interface SetupFile {
  kind: typeof SETUP_FILE_KIND;
  version: typeof SETUP_FILE_VERSION;
  exportedAt: string;
  appVersion: string;
  platform: string;
  sections: SetupSections;
}

/** An item the secret check kept out of the file, e.g. `deploy-prod` or `acme-web Build Script`. */
export interface SetupLeftOutItem {
  section: SetupSectionId;
  name: string;
}

/** One card row in export mode. */
export interface SetupExportRow {
  id: SetupSectionId;
  /** Items, repositories, paths or settings that would be written. */
  count: number;
  leftOut: SetupLeftOutItem[];
  /** agentPresets: display names of the chosen agents. */
  agents?: string[];
  /** skills: what is on. */
  skills?: { homeSkill: boolean; registerMcp: boolean };
  /** appearance: the theme shown, or both system themes. */
  appearance?: { mode: AppearanceMode; theme: Theme; light: LightTheme; dark: DarkTheme };
}

export interface SetupExportSummary {
  rows: SetupExportRow[];
}

export interface SetupExportResult {
  fileName: string;
  /** Where it was saved, for Show in Finder. */
  filePath: string;
  leftOut: SetupLeftOutItem[];
}

/** One line under an expanded preview row. */
export type SetupPreviewItem =
  | {
    kind: 'new' | 'replaces';
    name: string;
    /** Which field, e.g. "Run Commands" or "Theme". */
    field?: string;
    text: string;
    was?: string;
    /** An incoming terminal shortcut whose key another local shortcut uses; it comes in turned off. */
    keyInUse?: boolean;
  }
  | {
    kind: 'skipped';
    name: string;
    field?: string;
    reason: string;
    /** missing: not saved in Pane here; config-file: the repo's own config file provides it; ambiguous: several repos share the name. */
    cause: 'missing' | 'config-file' | 'ambiguous';
    /** config-file: which file, e.g. pane.json. */
    source?: string;
  };

/** What a confirmed section sends through Settings' existing save calls. */
export interface SetupApplyPayload {
  config?: SetupAgentPresets & Omit<SetupPreferenceConfig, 'sessionCreationPreferences'> & SetupAppearance & {
    /** Keeps this computer's base branch, which the file never carries. */
    sessionCreationPreferences?: SetupSessionCreationPreferences & { baseBranch?: string };
    customCommands?: SetupCustomCommand[];
    terminalShortcuts?: SetupTerminalShortcut[];
    worktreeFileSync?: WorktreeFileSyncEntry[];
    agentContext?: SetupSkills;
  };
  preferences?: Partial<Record<SetupPreferenceKey, string>>;
  projects?: Array<{
    id: number;
    name: string;
    updates: Pick<SetupRunScripts, 'build_script' | 'run_script' | 'archive_script'>;
  }>;
}

export interface SetupPreviewSection {
  id: SetupSectionId;
  /** New plus replaced items or changed values; 0 means "No changes". */
  changes: number;
  added: number;
  replaced: number;
  keyInUse: number;
  /** runScripts: exported repositories with at least one local match, of all exported. */
  repositories?: { matched: number; total: number };
  /** skills: what turning this section on does. */
  skills?: Array<'mcp-on' | 'mcp-off' | 'skill-on' | 'skill-off' | 'toolsets'>;
  /** appearance: the theme it switches to, when it changes. */
  theme?: Theme;
  items: SetupPreviewItem[];
  apply: SetupApplyPayload;
}

export interface SetupImportPreview {
  fileName: string;
  appVersion: string;
  /** The exporting computer's process.platform. */
  platform: string;
  /** True when the file was written on another OS than this one. */
  otherPlatform: boolean;
  /** Sent back on confirm so main recomputes against the current setup. */
  file: SetupFile;
  /** Sections present in the file, in card order. */
  sections: SetupPreviewSection[];
}
