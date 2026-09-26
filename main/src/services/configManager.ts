import { EventEmitter } from 'events';
import type { AnalyticsIdentity, AppConfig } from '../types/config';
import { DEFAULT_PANE_CHAT_AGENT, normalizePaneChatAgent } from '../../../shared/types/paneChat';
import { createDefaultRemoteDaemonConfig, normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';
import { DEFAULT_WORKTREE_FILE_SYNC_ENTRIES } from '../../../shared/types/worktreeFileSync';
import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { HOME_GIT_SCAN_WARNING, isHomeDirectory } from '../utils/gitScanSafety';
import { getAppDirectory } from '../utils/appDirectory';
import { clearShellPathCache } from '../utils/shellPath';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  AppearanceValidationError,
  DEFAULT_APPEARANCE,
  isLightTheme,
  isTheme,
  normalizeAppearance,
  type AppearanceConfig,
} from '../../../shared/types/appearance';

const DEFAULT_POSTHOG_API_KEY = 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1';
const LEGACY_POSTHOG_HOST = 'https://us.i.posthog.com';
const DEFAULT_POSTHOG_HOST = 'https://runpane.com/api/c';

function defaultAnalyticsConfig(): NonNullable<AppConfig['analytics']> {
  return {
    enabled: true,
    posthogApiKey: DEFAULT_POSTHOG_API_KEY,
    posthogHost: DEFAULT_POSTHOG_HOST
  };
}

export class ConfigManager extends EventEmitter {
  private config: AppConfig;
  private configPath: string;
  private configDir: string;
  private fileWatcher: FSWatcher | null = null;
  private lastConfigJson: string = '';
  private saveConfigQueue: Promise<void> = Promise.resolve();

  constructor(defaultGitPath?: string) {
    super();
    this.configDir = getAppDirectory();
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = {
      gitRepoPath: defaultGitPath || '',
      usePtyHost: process.platform === 'win32',
      verbose: false,
      anthropicApiKey: undefined,
      falApiKey: undefined,
      openRouterApiKey: undefined,
      deepgramApiKey: undefined,
      voiceTranscriptionMode: 'streaming',
      systemPromptAppend: undefined,
      runScript: undefined,
      theme: 'light-rounded',
      appearanceMode: 'system',
      systemLightTheme: 'light-rounded',
      systemDarkTheme: 'dark',
      highContrast: false,
      terminalFontFamily: 'Geist Mono',
      terminalFontSize: 14,
      terminalPowerMode: 'performance',
      defaultPermissionMode: 'ignore',
      defaultModel: 'sonnet',
      defaultOrchestratorAgent: DEFAULT_PANE_CHAT_AGENT,
      autoStartOnBoot: true,
      keepAwakeWhileSessionsActive: true,
      stravuApiKey: undefined,
      stravuServerUrl: '', // Stravu integration disabled
      notifications: {
        playSound: true,
        enabled: true
      },
      sessionCreationPreferences: {
        sessionCount: 1,
        toolType: 'none',
        selectedTools: {
          claude: false
        },
        claudeConfig: {
          model: 'auto',
          permissionMode: 'ignore',
          ultrathink: false
        },
        showAdvanced: false
      },
      analytics: defaultAnalyticsConfig(),
      agentContext: {
        managedAgentsMd: false,
        registerMcp: true
      },
      remoteDaemon: createDefaultRemoteDaemonConfig(),
      keyboardShortcutsEnabled: true,
      commandPaletteShortcutEnabled: true,
      terminalShortcuts: [
        {
          id: 'default-root-cause',
          label: 'Root cause or symptom?',
          key: 'e',
          text: 'Think hard: is this the root cause or a symptom? How might we solve this at the root?',
          enabled: true
        },
        {
          id: 'default-codex-review',
          label: 'Codex review loop',
          key: 'r',
          text: "Prepare a PR once done with changes, then run in a subagent 'codex review --base main' and wait for it to respond. Read its response and make the fixes it suggests. Continue in a loop until it says there are no longer any issues.",
          enabled: true
        },
        {
          id: 'default-rebase-merge-release',
          label: 'Rebase, merge & release',
          key: 'd',
          text: 'Rebase main and merge the PR to main, then bump a release patch.',
          enabled: true
        },
        {
          id: 'default-review-and-release',
          label: 'Review and release loop',
          key: 's',
          text: "Prepare a PR once done with changes, then run in a subagent 'codex review --base main' and wait for it to respond. Read its response and make the fixes it suggests. Continue in a loop until it says there are no longer any issues. Once there are no issues, rebase main and merge the PR to main, then bump a release patch.",
          enabled: true
        }
      ],
      worktreeFileSync: DEFAULT_WORKTREE_FILE_SYNC_ENTRIES
    };
  }

  async initialize(): Promise<void> {
    await this.enqueueConfigWrite(() => this.initializeFromDisk());
  }

  private async initializeFromDisk(): Promise<void> {
    // Ensure the config directory exists
    await fs.mkdir(this.configDir, { recursive: true });
    
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      // SAFETY: initialize immediately normalizes boundary-sensitive fields before assigning the parsed config.
      const loadedConfig = JSON.parse(data) as AppConfig;
      const normalizedAppearance = normalizeAppearance(loadedConfig);
      for (const diagnostic of normalizedAppearance.diagnostics) {
        console.error(`[ConfigManager] appearance: ${diagnostic}`);
      }
      
      // Migrate legacy notification fields from older config files.
      // notifyWhenBackgrounded -> enabled (if enabled is not explicitly set)
      // notifyWhenViewingOtherPanel is dropped silently.
      const incomingNotifications = decodeBoundary(
        loadedConfig.notifications,
        boundary.optional(boundary.object({
          playSound: boundary.optional(boundary.boolean),
          enabled: boundary.optional(boundary.boolean),
          notifyWhenBackgrounded: boundary.optional(boundary.boolean),
          notifyWhenViewingOtherPanel: boundary.optional(boundary.boolean),
        })),
      );
      const migratedNotifications = incomingNotifications
        ? {
            playSound: incomingNotifications.playSound ?? this.config.notifications!.playSound,
            enabled: incomingNotifications.enabled ?? incomingNotifications.notifyWhenBackgrounded ?? this.config.notifications!.enabled,
          }
        : this.config.notifications!;

      // Merge loaded config with defaults, ensuring nested settings exist
      this.config = {
        ...this.config,
        ...loadedConfig,
        ...normalizedAppearance.appearance,
        notifications: migratedNotifications,
        sessionCreationPreferences: {
          ...this.config.sessionCreationPreferences,
          ...loadedConfig.sessionCreationPreferences,
          selectedTools: {
            ...this.config.sessionCreationPreferences?.selectedTools,
            ...loadedConfig.sessionCreationPreferences?.selectedTools
          },
          claudeConfig: {
            ...this.config.sessionCreationPreferences?.claudeConfig,
            ...loadedConfig.sessionCreationPreferences?.claudeConfig
          }
        },
        analytics: {
          ...this.config.analytics!,
          ...loadedConfig.analytics
        },
        agentContext: {
          ...this.config.agentContext!,
          ...loadedConfig.agentContext
        },
        defaultOrchestratorAgent: normalizePaneChatAgent(
          loadedConfig.defaultOrchestratorAgent ?? this.config.defaultOrchestratorAgent,
        ),
        remoteDaemon: normalizeRemoteDaemonConfig(loadedConfig.remoteDaemon),
        // Use !== undefined to distinguish "user cleared all entries" (empty array → preserve)
        // from "field absent in config file" (→ use defaults)
        worktreeFileSync: loadedConfig.worktreeFileSync !== undefined
          ? loadedConfig.worktreeFileSync
          : DEFAULT_WORKTREE_FILE_SYNC_ENTRIES
      };

      let shouldPersistMigration = normalizedAppearance.migrated;
      // One-time switch from the AGENTS.md block to MCP registration. Existing blocks stay
      // in repositories until the user turns the setting on and off again.
      if (loadedConfig.agentContext?.registerMcp === undefined) {
        this.config.agentContext = { ...this.config.agentContext, managedAgentsMd: false, registerMcp: true };
        shouldPersistMigration = true;
        console.log('[ConfigManager] Pane now registers its MCP server with Claude Code and Codex; stopped writing the AGENTS.md block.');
      }
      if (this.config.analytics?.posthogHost === LEGACY_POSTHOG_HOST) {
        this.config.analytics.posthogHost = DEFAULT_POSTHOG_HOST;
        shouldPersistMigration = true;
      }
      if (shouldPersistMigration) {
        await this.writeConfigToDisk(this.config);
      }
    } catch (error: unknown) {
      let errorCode: string | undefined;
      try {
        errorCode = decodeBoundary(error, boundary.object({
          code: boundary.optional(boundary.string),
        })).code;
      } catch {
        errorCode = undefined;
      }
      const isNotFound = errorCode === 'ENOENT';
      if (isNotFound) {
        // Config file doesn't exist — create with defaults
        await this.writeConfigToDisk(this.config);
      } else {
        // Config exists but is corrupted — log and keep defaults in memory
        // Do NOT overwrite the file (user might want to recover it)
        console.error('[ConfigManager] Failed to parse config file, using defaults:', error);
      }
    }
  }

  private async writeConfigToDisk(config: AppConfig): Promise<void> {
    const configJson = JSON.stringify(config, null, 2);
    await fs.mkdir(this.configDir, { recursive: true });
    const tmpPath = `${this.configPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

    try {
      await fs.writeFile(tmpPath, configJson);
      await fs.rename(tmpPath, this.configPath);
      this.lastConfigJson = configJson;
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  private async enqueueConfigWrite<T>(work: () => Promise<T>): Promise<T> {
    const queuedWrite = this.saveConfigQueue.then(work, work);
    this.saveConfigQueue = queuedWrite.then(() => undefined, () => undefined);
    return queuedWrite;
  }

  private async saveConfig(): Promise<void> {
    await this.enqueueConfigWrite(() => this.writeConfigToDisk(this.config));
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * Reload config from disk. Use this when external processes (like setup scripts)
   * may have modified the config file.
   */
  async reloadFromDisk(): Promise<AppConfig> {
    await this.initialize();
    console.log('[ConfigManager] Reloaded config from disk');
    return this.config;
  }

  /**
   * Start watching config file for external changes (e.g., from setup scripts).
   * Emits 'config-updated' when the file changes.
   */
  startWatching(): void {
    if (this.fileWatcher) return; // Already watching

    try {
      this.lastConfigJson = JSON.stringify(this.config);

      const handleFileChange = async () => {
        try {
          // Small delay to let the file finish writing
          await new Promise(resolve => setTimeout(resolve, 100));

          const data = await fs.readFile(this.configPath, 'utf-8');

          // Only emit if content actually changed
          if (data !== this.lastConfigJson) {
            this.lastConfigJson = data;
            await this.initialize();
            console.log('[ConfigManager] Config file changed externally, reloaded');
            this.emit('config-updated', this.config);
          }
        } catch (err) {
          console.error('[ConfigManager] Error reloading config after file change:', err);
        }
      };

      const setupWatcher = () => {
        if (this.fileWatcher) {
          this.fileWatcher.close();
        }

        this.fileWatcher = watch(this.configPath, { persistent: false }, async (eventType) => {
          // Handle both 'change' and 'rename' events
          // 'rename' occurs when using atomic writes (tmp + mv pattern)
          if (eventType === 'change' || eventType === 'rename') {
            await handleFileChange();

            // On rename, the watched inode may have changed, so reattach the watcher
            if (eventType === 'rename') {
              console.log('[ConfigManager] Config file renamed/replaced, reattaching watcher');
              // Small delay before reattaching to let filesystem settle
              setTimeout(() => setupWatcher(), 200);
            }
          }
        });
      };

      setupWatcher();
      console.log('[ConfigManager] Watching config file for external changes');
    } catch (err) {
      console.error('[ConfigManager] Failed to start file watcher:', err);
    }
  }

  /**
   * Stop watching config file.
   */
  stopWatching(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
      console.log('[ConfigManager] Stopped watching config file');
    }
  }

  async updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
    return this.updateConfigWith(() => updates);
  }

  async updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<AppConfig> {
    return this.enqueueConfigWrite(async () => {
      const updates = update(this.getConfig());
      const analytics = updates.analytics !== undefined
        ? { ...defaultAnalyticsConfig(), ...this.config.analytics, ...updates.analytics }
        : this.config.analytics;
      const agentContext = updates.agentContext !== undefined
        ? { ...this.config.agentContext, ...updates.agentContext }
        : this.config.agentContext;
      const next: AppConfig = {
        ...this.config,
        ...updates,
        analytics,
        agentContext,
        defaultOrchestratorAgent: 'defaultOrchestratorAgent' in updates
          ? normalizePaneChatAgent(updates.defaultOrchestratorAgent)
          : this.config.defaultOrchestratorAgent,
        remoteDaemon: 'remoteDaemon' in updates
          ? normalizeRemoteDaemonConfig(updates.remoteDaemon)
          : this.config.remoteDaemon,
      };

      this.validateAppearanceUpdate(updates, next);
      await this.writeConfigToDisk(next);
      this.config = next;

      if ('additionalPaths' in updates) {
        clearShellPathCache();
        console.log('[ConfigManager] Additional paths updated, cleared PATH cache');
      }
      this.emit('config-updated', this.config);
      return this.getConfig();
    });
  }

  private validateAppearanceUpdate(updates: Partial<AppConfig>, next: AppConfig): void {
    if ('appearanceMode' in updates && updates.appearanceMode !== 'system' && updates.appearanceMode !== 'fixed') {
      throw new AppearanceValidationError('appearanceMode must be system or fixed');
    }
    if ('theme' in updates && !isTheme(updates.theme)) {
      throw new AppearanceValidationError('theme must be a valid palette');
    }
    if ('systemLightTheme' in updates && (!isTheme(updates.systemLightTheme) || !isLightTheme(updates.systemLightTheme))) {
      throw new AppearanceValidationError('systemLightTheme must be a light palette');
    }
    if ('systemDarkTheme' in updates && (!isTheme(updates.systemDarkTheme) || isLightTheme(updates.systemDarkTheme))) {
      throw new AppearanceValidationError('systemDarkTheme must be a dark palette');
    }
    const appearance: AppearanceConfig = {
      appearanceMode: next.appearanceMode ?? DEFAULT_APPEARANCE.appearanceMode,
      theme: next.theme ?? DEFAULT_APPEARANCE.theme,
      systemLightTheme: next.systemLightTheme ?? DEFAULT_APPEARANCE.systemLightTheme,
      systemDarkTheme: next.systemDarkTheme ?? DEFAULT_APPEARANCE.systemDarkTheme,
    };
    if (!isLightTheme(appearance.systemLightTheme)) {
      throw new AppearanceValidationError('systemLightTheme must be a light palette');
    }
    if (isLightTheme(appearance.systemDarkTheme)) {
      throw new AppearanceValidationError('systemDarkTheme must be a dark palette');
    }
  }

  getGitRepoPath(): string {
    const repoPath = this.config.gitRepoPath || '';
    if (isHomeDirectory(repoPath)) {
      console.warn(`[ConfigManager] ${HOME_GIT_SCAN_WARNING}`);
      return '';
    }
    return repoPath;
  }

  isVerbose(): boolean {
    return this.config.verbose || false;
  }

  /**
   * Whether PTY spawns should be routed through the isolated ptyHost
   * `UtilityProcess`. On by default on Windows. The `PANE_USE_PTY_HOST=1` env var is
   * honored as a dev override so testing doesn't require flipping the config.
   */
  getUsePtyHost(): boolean {
    if (process.env.PANE_USE_PTY_HOST === '1') return true;
    return this.config.usePtyHost === true;
  }

  getDatabasePath(): string {
    return path.join(this.configDir, 'sessions.db');
  }

  getAnthropicApiKey(): string | undefined {
    return this.config.anthropicApiKey;
  }

  getSystemPromptAppend(): string | undefined {
    return this.config.systemPromptAppend;
  }

  getRunScript(): string[] | undefined {
    return this.config.runScript;
  }

  getStravuApiKey(): string | undefined {
    return this.config.stravuApiKey;
  }

  getStravuServerUrl(): string {
    return this.config.stravuServerUrl || ''; // Stravu integration disabled
  }

  getDefaultModel(): string {
    return this.config.defaultModel || 'sonnet';
  }

  getSessionCreationPreferences() {
    return this.config.sessionCreationPreferences || {
      sessionCount: 1,
      toolType: 'none',
      selectedTools: {
        claude: false
      },
      claudeConfig: {
        model: 'auto',
        permissionMode: 'ignore',
        ultrathink: false
      },
      showAdvanced: false,
      startPinned: false
    };
  }

  getAnalyticsSettings() {
    return this.config.analytics || defaultAnalyticsConfig();
  }

  isAnalyticsEnabled(): boolean {
    return this.config.analytics?.enabled ?? true;
  }

  getAnalyticsDistinctId(): string | undefined {
    return this.config.analytics?.distinctId;
  }

  private ensureAnalyticsConfig(): NonNullable<AppConfig['analytics']> {
    if (!this.config.analytics) {
      this.config.analytics = defaultAnalyticsConfig();
    }
    return this.config.analytics;
  }

  async getOrCreateAnalyticsInstallId(): Promise<string> {
    const analytics = this.ensureAnalyticsConfig();
    if (!analytics.installId) {
      analytics.installId = `install_${randomUUID()}`;
      await this.saveConfig();
    }
    return analytics.installId;
  }

  async setAnalyticsDistinctId(distinctId: string): Promise<void> {
    const analytics = this.ensureAnalyticsConfig();
    analytics.distinctId = distinctId;
    await this.saveConfig();
  }

  async setAnalyticsIdentity(identity: AnalyticsIdentity): Promise<void> {
    const analytics = this.ensureAnalyticsConfig();
    analytics.distinctId = identity.distinctId;
    analytics.identitySource = identity.identitySource;
    analytics.installId = identity.installId ?? analytics.installId;
    analytics.githubUsername = identity.githubUsername;
    analytics.githubEmail = identity.githubEmail;
    analytics.gitEmail = identity.gitEmail;
    analytics.gitEmailHash = identity.gitEmailHash;
    analytics.gitUserName = identity.gitUserName;
    await this.saveConfig();
  }

  /**
   * Get the user's preferred shell for terminal sessions.
   * Validates the preference against allowed values and returns 'auto' if invalid.
   * @returns One of: 'auto', 'gitbash', 'powershell', 'pwsh', 'cmd'
   */
  getPreferredShell(): string {
    const pref = this.config.preferredShell || 'auto';
    const validPrefs = ['auto', 'gitbash', 'powershell', 'pwsh', 'cmd'];
    return validPrefs.includes(pref) ? pref : 'auto';
  }

  /**
   * Get the configured worktree file sync entries.
   * Returns defaults if no entries are configured.
   */
  getWorktreeFileSyncEntries(): WorktreeFileSyncEntry[] {
    return this.config.worktreeFileSync ?? DEFAULT_WORKTREE_FILE_SYNC_ENTRIES;
  }
}
