import { validateCustomCommandResume } from '../../../shared/types/customCommandResume';
import { EventEmitter } from 'events';
import type { AnalyticsIdentity, AppConfig } from '../types/config';
import { DEFAULT_PANE_CHAT_AGENT, normalizePaneChatAgent } from '../../../shared/types/paneChat';
import { DEFAULT_TERMINAL_FONT_SIZE } from '../../../shared/types/appearance';
import { DEFAULT_AUTO_PAUSE_HOURS, DEFAULT_CHAT_RELEASE_MINUTES } from '../../../shared/types/autoPause';
import { DEFAULT_BACKGROUND_ACTIVITY } from '../../../shared/types/backgroundActivity';
import { createDefaultRemoteDaemonConfig, normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { customLinkSchema, type CustomLink } from '../../../shared/types/customLinks';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';
import { DEFAULT_WORKTREE_FILE_SYNC_ENTRIES } from '../../../shared/types/worktreeFileSync';
import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { HOME_GIT_SCAN_WARNING, isHomeDirectory } from '../utils/gitScanSafety';
import { getAppDirectory } from '../utils/appDirectory';
import { clearShellPathCache } from '../utils/shellPath';
import { restampCardsOn, restampNotifySwitch, restampSharedCredentials } from './sharedCredentials';
import {
  boundary,
  decodeBoundary,
  decodeOptionalBoundary,
  type JsonValue,
} from '../../../shared/validation/boundaryDecoder';
import {
  type KeyboardShortcutOverrides,
  collectActiveBindings,
  findChordConflicts,
  normalizeKeyboardShortcutOverrides,
} from '../../../shared/utils/keyboardBindings';
import { keyPlatformFor } from '../../../shared/utils/keyboardChords';
import { MACHINE_COLOR_NAMES } from '../../../shared/utils/machineColor';
import type { MachineMarkOverride, MachineMarkOverrides } from '../../../shared/utils/machineMarks';
import {
  AppearanceValidationError,
  DEFAULT_APPEARANCE,
  isTheme,
  normalizeAppearance,
} from '../../../shared/types/appearance';

const DEFAULT_POSTHOG_API_KEY = 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1';
const LEGACY_POSTHOG_HOST = 'https://us.i.posthog.com';
const DEFAULT_POSTHOG_HOST = 'https://runpane.com/api/c';
/** Bump when agentContext defaults change for existing configs (2: repo AGENTS.md off). */
export const AGENT_CONTEXT_DEFAULTS_VERSION = 2;

/** DO_NOT_TRACK=1 or a non-empty RUNPANE_TELEMETRY_DISABLED turns off all analytics, whatever config.json says. */
export function analyticsDisabledByEnvironment(): boolean {
  return process.env.DO_NOT_TRACK === '1' || Boolean(process.env.RUNPANE_TELEMETRY_DISABLED);
}

function defaultAnalyticsConfig(): NonNullable<AppConfig['analytics']> {
  return {
    enabled: true,
    posthogApiKey: DEFAULT_POSTHOG_API_KEY,
    posthogHost: DEFAULT_POSTHOG_HOST
  };
}

const machineMarksSchema = boundary.record(boundary.object({
  letters: boundary.optional(boundary.string),
  color: boundary.optional(boundary.enumeration(...MACHINE_COLOR_NAMES)),
}));

/** customLinks as Settings › Links can show them: hand-edited entries missing a field are dropped and logged. */
function decodeCustomLinks(saved: CustomLink[]): CustomLink[] {
  const entries: readonly unknown[] = Array.isArray(saved) ? saved : [saved];
  const links = entries.flatMap((entry) => decodeOptionalBoundary(entry, customLinkSchema) ?? []);
  const dropped = entries.length - links.length;
  if (dropped > 0) {
    console.warn(`[ConfigManager] customLinks: ignored ${dropped} malformed entries in config.json. Each needs enabled, id, label, pattern and urlTemplate; add them again in Settings › Links.`);
  }
  return links;
}

/** Machine marks as saved: only the known parts, and no entry left with nothing in it. */
function decodeMachineMarks(update: MachineMarkOverrides): MachineMarkOverrides {
  const marks: MachineMarkOverrides = {};
  for (const [key, { letters, color }] of Object.entries(decodeBoundary(update, machineMarksSchema))) {
    const mark: MachineMarkOverride = {};
    if (letters) mark.letters = letters;
    if (color) mark.color = color;
    if (mark.letters || mark.color) marks[key] = mark;
  }
  return marks;
}

const MAX_COMMIT_ATTEMPTS = 5;
const WATCH_DEBOUNCE_MS = 150;
const INVALID_CONFIG_RETRY_MS = 2_000;

type DiskRead = { kind: 'missing' } | { kind: 'invalid'; reason: string } | { kind: 'ok'; text: string };
type ConfigKey = keyof AppConfig;

/** The updates whose value differs from `known`: what the caller is changing. */
function pickChanged(known: AppConfig, updates: Partial<AppConfig>): Partial<AppConfig> {
  const changed: Partial<AppConfig> = {};
  // SAFETY: Object.keys of a Partial<AppConfig> are AppConfig keys.
  for (const key of Object.keys(updates) as ConfigKey[]) {
    if (!isDeepStrictEqual(updates[key], known[key])) Object.assign(changed, { [key]: updates[key] });
  }
  return changed;
}

/** `current` with the override ids that `update` sets or removes relative to `known`. */
function mergeChangedOverrides(
  known: KeyboardShortcutOverrides | undefined,
  current: KeyboardShortcutOverrides | undefined,
  update: KeyboardShortcutOverrides | undefined,
): KeyboardShortcutOverrides | undefined {
  const updateIds = decodeOptionalBoundary(update, boundary.jsonObject);
  if (!updateIds || !update) return update;
  const knownIds = { ...decodeOptionalBoundary(known, boundary.jsonObject) };
  const merged = { ...decodeOptionalBoundary(current, boundary.jsonObject) };
  for (const [id, value] of Object.entries(updateIds)) {
    if (!isDeepStrictEqual(value, knownIds[id])) merged[id] = value;
  }
  for (const id of Object.keys(knownIds)) {
    if (!(id in updateIds)) delete merged[id];
  }
  // SAFETY: every value came from one of the three override maps; the map is normalized again at runtime and kept verbatim like a hand edit.
  return merged as KeyboardShortcutOverrides;
}

export class ConfigManager extends EventEmitter {
  private lastLoggedShortcutDiagnostics = '';
  private config: AppConfig;
  private configPath: string;
  private configDir: string;
  private fileWatcher: FSWatcher | null = null;
  private lastConfigJson: string = '';
  private saveConfigQueue: Promise<void> = Promise.resolve();
  private hasReadConfigFile = false;
  /** config.json exists but Pane has never read it, so its analytics settings are unknown. */
  private configUnreadSinceLaunch = false;
  private diskCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keys changed in memory while config.json did not parse; saved once it does. */
  private pendingKeys = new Set<ConfigKey>();
  /** Pane's copy before the first change held back while config.json did not parse. */
  private heldBase: AppConfig | null = null;

  constructor(defaultGitPath?: string) {
    super();
    this.configDir = getAppDirectory();
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = {
      machineId: randomUUID(),
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
      ...DEFAULT_APPEARANCE,
      highContrast: false,
      terminalFontFamily: 'Geist Mono',
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      terminalPowerMode: 'performance',
      defaultPermissionMode: 'ignore',
      defaultModel: 'sonnet',
      defaultOrchestratorAgent: DEFAULT_PANE_CHAT_AGENT,
      // A fresh install opens agents as chat tabs (D-329).
      chatTabsEnabled: true,
      autopilotEnabled: false,
      notesEnabled: false,
      autoStartOnBoot: true,
      keepAwakeWhileSessionsActive: true,
      keepAwakeWhilePluggedIn: false,
      keepAwakeOnBattery: false,
      backgroundActivity: DEFAULT_BACKGROUND_ACTIVITY,
      resumePausedOnOpen: false,
      autoPauseEnabled: true,
      autoPauseAfterHours: DEFAULT_AUTO_PAUSE_HOURS,
      chatIdleReleaseMinutes: DEFAULT_CHAT_RELEASE_MINUTES,
      notifications: {
        playSound: false,
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
        homeSkill: true,
        defaultsVersion: AGENT_CONTEXT_DEFAULTS_VERSION,
        registerMcp: true,
        cleanupPending: false,
      },
      remoteDaemon: createDefaultRemoteDaemonConfig(),
      keyboardShortcutsEnabled: true,
      commandPaletteShortcutEnabled: true,
      // A fresh install starts on the VS Code keymap, so it has nothing to be told.
      keymapNotice: 'seen',
      terminalShortcuts: [
        {
          id: 'default-root-cause',
          label: 'Root cause or symptom?',
          key: 'e',
          text: 'Think hard: is this the root cause or a symptom? How might we solve this at the root?',
          enabled: true
        },
        {
          id: 'default-plan-first',
          label: 'Plan before editing',
          key: 'p',
          text: 'Before you change any code, explain your plan in a few short steps and wait for my go-ahead.',
          enabled: true
        },
        {
          id: 'default-review-diff',
          label: 'Review your own diff',
          key: 'r',
          text: "Before you say you're done, review your own diff. Fix any bugs, leftover debug code, or missed edge cases.",
          enabled: true
        },
        {
          id: 'default-show-it-works',
          label: 'Show it works',
          key: 't',
          text: 'Show me it works: run the relevant tests or the app and share the real output.',
          enabled: true
        }
      ],
      worktreeFileSync: DEFAULT_WORKTREE_FILE_SYNC_ENTRIES
    };
  }

  async initialize(): Promise<void> {
    const { restamped } = await this.enqueueConfigWrite(() => this.initializeFromDisk(true));
    // Lets key sharing pick up a key edited by hand.
    if (restamped) this.emit('config-updated', this.config);
  }

  /**
   * Reads config.json and loads it if it changed since Pane last saw it. Only
   * startup persists a migration here: a reload writes nothing, so it can never
   * race an outside edit, and its migration is saved with the next update.
   */
  private async initializeFromDisk(persistMigration: boolean): Promise<{ changed: boolean; restamped: boolean }> {
    const unchanged = { changed: false, restamped: false };
    await fs.mkdir(this.configDir, { recursive: true });
    for (let attempt = 0; ; attempt++) {
      const disk = await this.readConfigFile();
      if (disk.kind === 'missing') {
        // Config file doesn't exist — create with defaults
        if (await this.commitConfig(this.config, disk) === 'conflict' && attempt < MAX_COMMIT_ATTEMPTS) continue;
        return unchanged;
      }
      if (disk.kind === 'invalid') {
        // Do NOT overwrite the file (user might want to recover it)
        this.logInvalidConfig(disk.reason);
        this.configUnreadSinceLaunch = true;
        return unchanged;
      }
      if (this.hasReadConfigFile && disk.text === this.lastConfigJson) return unchanged;
      const loaded = this.tryLoadConfigText(disk.text);
      if (!loaded) {
        this.configUnreadSinceLaunch = true;
        return unchanged;
      }
      const { persist, emit } = loaded;
      if (persistMigration && persist && await this.commitConfig(this.config, disk) === 'conflict' && attempt < MAX_COMMIT_ATTEMPTS) continue;
      return { changed: true, restamped: emit };
    }
  }

  /** loadConfigText, logging instead of throwing when the file cannot be decoded. */
  private tryLoadConfigText(data: string) {
    try {
      return this.loadConfigText(data);
    } catch (error) {
      this.logInvalidConfig(error instanceof Error ? error.message : 'could not be decoded');
      return null;
    }
  }

  /** Normalizes config.json's text onto the in-memory config. Throws when a field cannot be decoded. */
  private loadConfigText(data: string) {
    const lastRead = this.hasReadConfigFile ? this.config : null;
    // SAFETY: initialize immediately normalizes boundary-sensitive fields before assigning the parsed config.
    const loadedConfig = JSON.parse(data) as AppConfig;
    // Drop keys from the removed Stravu integration so they leave the file on the next save.
    for (const legacyKey of ['stravuApiKey', 'stravuServerUrl']) {
      Reflect.deleteProperty(loadedConfig, legacyKey);
    }
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
      // A config saved without the key had chat tabs off; only a fresh install starts with them on (D-329).
      chatTabsEnabled: loadedConfig.chatTabsEnabled ?? false,
      // Configs saved before the VS Code keymap (D-236) get a one-time notice of the moved keys.
      keymapNotice: loadedConfig.keymapNotice ?? 'pending',
      // Configs saved before this setting existed kept the machine awake while plugged in.
      keepAwakeWhilePluggedIn: loadedConfig.keepAwakeWhilePluggedIn ?? true,
      remoteDaemon: normalizeRemoteDaemonConfig(loadedConfig.remoteDaemon),
      ...(loadedConfig.customLinks !== undefined && { customLinks: decodeCustomLinks(loadedConfig.customLinks) }),
      // Use !== undefined to distinguish "user cleared all entries" (empty array → preserve)
      // from "field absent in config file" (→ use defaults)
      worktreeFileSync: loadedConfig.worktreeFileSync !== undefined
        ? loadedConfig.worktreeFileSync
        : DEFAULT_WORKTREE_FILE_SYNC_ENTRIES
    };

    let shouldPersistMigration = normalizedAppearance.migrated;
    if (loadedConfig.agentContext?.registerMcp === undefined) {
      this.config.agentContext = { ...this.config.agentContext, registerMcp: true };
      shouldPersistMigration = true;
      console.log('[ConfigManager] Pane now registers its MCP server with Claude Code, Codex, and Cursor.');
    }
    if ((loadedConfig.agentContext?.defaultsVersion ?? 0) < AGENT_CONTEXT_DEFAULTS_VERSION) {
      // Version 2 stopped editing repositories by default. Configs saved under
      // the old default carry managedAgentsMd: true without the user choosing
      // it, so turn it off once; the caller then removes Pane's section from
      // repos exactly as the settings toggle does. A later opt-in sticks.
      this.config.agentContext = {
        ...this.config.agentContext,
        managedAgentsMd: false,
        defaultsVersion: AGENT_CONTEXT_DEFAULTS_VERSION,
        cleanupPending: true,
      };
      shouldPersistMigration = true;
    }
    if (this.config.analytics?.posthogHost === LEGACY_POSTHOG_HOST) {
      this.config.analytics.posthogHost = DEFAULT_POSTHOG_HOST;
      shouldPersistMigration = true;
    }
    const restamped = restampSharedCredentials(this.config, 'untimed');
    if (restamped) {
      this.config.sharedCredentials = restamped;
      shouldPersistMigration = true;
    }
    // A switch that changed on disk since the last read here was edited by hand.
    const switchRestamped = lastRead ? restampNotifySwitch(lastRead, this.config) : null;
    if (switchRestamped !== null) {
      this.config.notifyEnabledChangedAt = switchRestamped;
      shouldPersistMigration = true;
    }
    const cardsOnRestamped = lastRead ? restampCardsOn(lastRead, this.config) : null;
    if (cardsOnRestamped !== null) {
      this.config.notifyCardsOnChangedAt = cardsOnRestamped;
      shouldPersistMigration = true;
    }
    // A config from before install ids keeps the id this run created (the defaults' or the last read's).
    if (!loadedConfig.machineId) shouldPersistMigration = true;
    if (!this.applyKeyboardShortcutOverrides(loadedConfig.keyboardShortcutOverrides)) {
      delete this.config.keyboardShortcutOverrides;
    }
    this.hasReadConfigFile = true;
    this.lastConfigJson = data;
    return { persist: shouldPersistMigration, emit: restamped !== null || switchRestamped !== null || cardsOnRestamped !== null };
  }

  private async readConfigFile(): Promise<DiskRead> {
    let text: string;
    try {
      text = await fs.readFile(this.configPath, 'utf-8');
    } catch (error) {
      const { code, message } = decodeBoundary(error, boundary.object({
        code: boundary.optional(boundary.string),
        message: boundary.optional(boundary.string),
      }));
      if (code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'invalid', reason: message ?? 'unreadable' };
    }
    try {
      JSON.parse(text);
    } catch (error) {
      return { kind: 'invalid', reason: error instanceof Error ? error.message : 'not JSON' };
    }
    return { kind: 'ok', text };
  }

  private logInvalidConfig(reason: string): void {
    console.error(
      `[ConfigManager] ${this.configPath} could not be read or is not valid JSON, so Pane is not saving over it. ` +
      'Settings changed meanwhile stay in memory and are saved once the file parses again.',
      reason,
    );
  }

  /**
   * Atomically replaces config.json with `config`, unless the file changed since
   * `basis` was read: then nothing is written and the caller re-reads and retries.
   */
  private async commitConfig(config: AppConfig, basis: DiskRead): Promise<'written' | 'conflict'> {
    const configJson = JSON.stringify(config, null, 2);
    await fs.mkdir(this.configDir, { recursive: true });
    const tmpPath = `${this.configPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpPath, configJson);
      const now = await this.readConfigFile();
      const unchanged = now.kind === basis.kind && (now.kind !== 'ok' || (basis.kind === 'ok' && now.text === basis.text));
      if (!unchanged) {
        await fs.unlink(tmpPath).catch(() => {});
        return 'conflict';
      }
      await fs.rename(tmpPath, this.configPath);
      // What Pane wrote is what it has read: the watcher and the next write skip reloading it.
      this.lastConfigJson = configJson;
      this.hasReadConfigFile = true;
      return 'written';
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

  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * Reload config from disk. Use this when external processes (like setup scripts)
   * may have modified the config file. Emits 'config-updated' when it changed.
   */
  async reloadFromDisk(): Promise<AppConfig> {
    const { changed } = await this.enqueueConfigWrite(() => this.initializeFromDisk(false));
    if (changed) {
      console.log('[ConfigManager] Reloaded config from disk');
      this.emit('config-updated', this.config);
    }
    return this.config;
  }

  /**
   * Watch config.json for outside edits (by hand, a script, another agent):
   * each settles for a moment, then reloads and emits 'config-updated'. Pane's
   * own writes are recognised by their content and ignored.
   */
  startWatching(): void {
    if (this.fileWatcher) return;
    const fileName = path.basename(this.configPath);
    try {
      // The directory, not the file: an atomic replace (tmp + rename) swaps the file's inode.
      this.fileWatcher = watch(this.configDir, { persistent: false }, (_eventType, changed) => {
        if (changed !== null && changed !== fileName) return;
        this.scheduleDiskCheck(WATCH_DEBOUNCE_MS);
      });
      this.fileWatcher.on('error', (error) => console.error('[ConfigManager] Config file watcher failed:', error));
      console.log('[ConfigManager] Watching config file for external changes');
    } catch (err) {
      console.error('[ConfigManager] Failed to start file watcher:', err);
    }
  }

  stopWatching(): void {
    if (this.diskCheckTimer) clearTimeout(this.diskCheckTimer);
    this.diskCheckTimer = null;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
      console.log('[ConfigManager] Stopped watching config file');
    }
  }

  /** Reloads after an outside edit, and saves settings held back while the file did not parse. */
  private scheduleDiskCheck(delayMs: number): void {
    if (this.diskCheckTimer) clearTimeout(this.diskCheckTimer);
    this.diskCheckTimer = setTimeout(() => {
      this.diskCheckTimer = null;
      void this.checkDisk();
    }, delayMs);
    this.diskCheckTimer.unref?.();
  }

  private async checkDisk(): Promise<void> {
    try {
      if (this.pendingKeys.size > 0) {
        await this.updateConfigWith(() => ({}));
        return;
      }
      if ((await this.enqueueConfigWrite(() => this.initializeFromDisk(false))).changed) {
        console.log('[ConfigManager] Config file changed externally, reloaded');
        this.emit('config-updated', this.config);
      }
    } catch (err) {
      console.error('[ConfigManager] Error reloading config after file change:', err);
    }
  }

  async updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
    if (updates.defaultSessionResume) validateCustomCommandResume(updates.defaultSessionResume);
    for (const command of updates.customCommands ?? []) {
      if (command.resume) validateCustomCommandResume(command.resume);
    }
    return this.updateConfigWith(() => updates);
  }

  /**
   * Applies `update` to config.json as it is on disk now, not to Pane's last
   * copy: the file is re-read first, only the keys `update` changes are
   * applied, and the write is retried if the file changes before it lands.
   * Edits made outside Pane to other keys survive. If the file does not parse,
   * it is left alone: the change is kept in memory and saved once it does.
   */
  async updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<AppConfig> {
    return this.enqueueConfigWrite(async () => {
      const known = this.config;
      let reloaded = false;
      try {
        for (let attempt = 0; ; attempt++) {
          const disk = await this.readConfigFile();
          if (disk.kind === 'ok' && (!this.hasReadConfigFile || disk.text !== this.lastConfigJson)) {
            if (!this.tryLoadConfigText(disk.text)) return this.holdUpdate(known, update(this.config));
            reloaded = true;
          }
          if (disk.kind === 'invalid') {
            this.logInvalidConfig(disk.reason);
            return this.holdUpdate(known, update(this.config));
          }
          // Held changes apply against the copy they changed, so a fixed file still holding the old value doesn't undo them.
          const current = this.heldBase ? this.applyUpdates(this.heldBase, this.config, this.pendingUpdates(known)) : this.config;
          const updates = update(current);
          const next = this.applyUpdates(known, current, updates);
          const result = await this.commitConfig(next, disk);
          if (result === 'conflict' && attempt < MAX_COMMIT_ATTEMPTS) continue;
          if (result === 'conflict') {
            throw new Error(`[ConfigManager] ${this.configPath} kept changing while Pane saved; nothing was written`);
          }
          this.pendingKeys.clear();
          this.heldBase = null;
          this.config = next;
          if ('additionalPaths' in updates) {
            clearShellPathCache();
            console.log('[ConfigManager] Additional paths updated, cleared PATH cache');
          }
          this.emit('config-updated', this.config);
          return this.getConfig();
        }
      } catch (error) {
        // The save failed, but an outside edit it loaded is already Pane's copy: say so.
        if (reloaded) this.emit('config-updated', this.config);
        throw error;
      }
    });
  }

  /** The file does not parse: apply the change in memory only, and save it once the file is fixed. */
  private holdUpdate(known: AppConfig, rawUpdates: Partial<AppConfig>): AppConfig {
    // Before the file was ever read, an analytics write builds on defaults, not the person's settings: drop it.
    const updates = this.hasReadConfigFile ? rawUpdates : { ...rawUpdates, analytics: known.analytics };
    // SAFETY: Object.keys of a Partial<AppConfig> are AppConfig keys.
    const changedKeys = Object.keys(pickChanged(known, updates)) as ConfigKey[];
    if (changedKeys.length > 0) {
      this.heldBase ??= known;
      for (const key of changedKeys) this.pendingKeys.add(key);
      this.config = this.applyUpdates(known, known, updates);
      this.emit('config-updated', this.config);
    }
    if (this.pendingKeys.size > 0) this.scheduleDiskCheck(INVALID_CONFIG_RETRY_MS);
    return this.getConfig();
  }

  /** Settings held back while the file did not parse, as updates against the file now. */
  private pendingUpdates(known: AppConfig): Partial<AppConfig> {
    const held: Partial<AppConfig> = {};
    for (const key of this.pendingKeys) Object.assign(held, { [key]: known[key] });
    return held;
  }

  /**
   * `current` (config.json as just read) with the keys in `updates` that differ
   * from `known` (Pane's copy the caller saw) applied. Partial objects (notify,
   * analytics, agentContext) merge field by field; the shortcut override map
   * applies only the ids that changed from `known`, so an id another writer
   * added survives a save of a map that predates it, and an id removed from
   * `known` is still removed.
   */
  private applyUpdates(known: AppConfig, current: AppConfig, rawUpdates: Partial<AppConfig>): AppConfig {
    const updates = pickChanged(known, rawUpdates);
    const analytics = updates.analytics !== undefined
      ? { ...defaultAnalyticsConfig(), ...current.analytics, ...updates.analytics }
      : current.analytics;
    const agentContext = updates.agentContext !== undefined
      ? { ...current.agentContext, ...updates.agentContext }
      : current.agentContext;
    // Notify settings arrive one field at a time from Settings and the tray menu.
    const notify = updates.notify !== undefined ? { ...current.notify, ...updates.notify } : current.notify;
    const next: AppConfig = {
      ...current,
      ...updates,
      analytics,
      agentContext,
      notify,
      defaultOrchestratorAgent: 'defaultOrchestratorAgent' in updates
        ? normalizePaneChatAgent(updates.defaultOrchestratorAgent)
        : current.defaultOrchestratorAgent,
      remoteDaemon: 'remoteDaemon' in updates
        ? normalizeRemoteDaemonConfig(updates.remoteDaemon)
        : current.remoteDaemon,
    };
    if ('keyboardShortcutOverrides' in updates) {
      next.keyboardShortcutOverrides = mergeChangedOverrides(
        known.keyboardShortcutOverrides,
        current.keyboardShortcutOverrides,
        updates.keyboardShortcutOverrides,
      );
    }

    if (updates.machineMarks !== undefined) next.machineMarks = decodeMachineMarks(updates.machineMarks);
    if (updates.agentContext !== undefined) {
      decodeBoundary(updates.agentContext, boundary.object({
        managedAgentsMd: boundary.optional(boundary.boolean),
        homeSkill: boundary.optional(boundary.boolean),
        defaultsVersion: boundary.optional(boundary.number),
      }));
    }
    next.sharedCredentials = restampSharedCredentials(next, 'now') ?? next.sharedCredentials;
    // A value from another machine arrives with that machine's time; anything else is the person, here.
    if (!('notifyEnabledChangedAt' in rawUpdates)) {
      next.notifyEnabledChangedAt = restampNotifySwitch(current, next) ?? next.notifyEnabledChangedAt;
    }
    if (!('notifyCardsOnChangedAt' in rawUpdates)) {
      next.notifyCardsOnChangedAt = restampCardsOn(current, next) ?? next.notifyCardsOnChangedAt;
    }
    this.validateAppearanceUpdate(updates);
    if (!this.applyKeyboardShortcutOverrides(next.keyboardShortcutOverrides, next)) {
      delete next.keyboardShortcutOverrides;
    }
    return next;
  }

  /**
   * Logs anything malformed or conflicting in the override map (once per
   * distinct message set) and says whether the map stays in config: any
   * non-empty object is kept verbatim, so unknown ids and malformed values from
   * hand edits or newer versions survive a downgrade and are only ignored at
   * runtime; `{}` and non-objects are dropped.
   */
  private applyKeyboardShortcutOverrides(rawOverrides: JsonValue | undefined, config: AppConfig = this.config): boolean {
    const normalized = normalizeKeyboardShortcutOverrides(rawOverrides);
    const messages = normalized.diagnostics.map(message =>
      `[ConfigManager] keyboardShortcutOverrides: ${message}`
    );
    const conflicts = findChordConflicts(collectActiveBindings({
      overrides: rawOverrides,
      terminalShortcuts: config.terminalShortcuts,
      customCommands: config.customCommands,
      keyPlatform: keyPlatformFor(process.platform),
      // No platform gate: a Windows host can open a WSL project where
      // platform-limited commands (Cursor) are active.
    }));
    for (const conflict of conflicts) {
      messages.push(
        `[ConfigManager] keyboardShortcutOverrides conflict: ${conflict.chord} is bound to ${conflict.ids.join(' and ')}`
      );
    }
    const diagnosticKey = messages.join('\n');
    if (diagnosticKey !== this.lastLoggedShortcutDiagnostics) {
      this.lastLoggedShortcutDiagnostics = diagnosticKey;
      for (const message of messages) console.warn(message);
    }
    const parsed = decodeOptionalBoundary(rawOverrides, boundary.jsonObject);
    return parsed !== undefined && Object.keys(parsed).length > 0;
  }

  private validateAppearanceUpdate(updates: Partial<AppConfig>): void {
    if ('appearanceMode' in updates && updates.appearanceMode !== 'system' && updates.appearanceMode !== 'fixed') {
      throw new AppearanceValidationError('appearanceMode must be system or fixed');
    }
    if ('theme' in updates && !isTheme(updates.theme)) {
      throw new AppearanceValidationError('theme must be a valid palette');
    }
    if ('systemLightTheme' in updates && !isTheme(updates.systemLightTheme)) {
      throw new AppearanceValidationError('systemLightTheme must be a valid palette');
    }
    if ('systemDarkTheme' in updates && !isTheme(updates.systemDarkTheme)) {
      throw new AppearanceValidationError('systemDarkTheme must be a valid palette');
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

  /** Off while the environment opts out, or while a config.json that may hold analytics off has never been read. */
  isAnalyticsEnabled(): boolean {
    const unread = this.configUnreadSinceLaunch && !this.hasReadConfigFile;
    return !analyticsDisabledByEnvironment() && !unread && (this.config.analytics?.enabled ?? true);
  }

  getAnalyticsDistinctId(): string | undefined {
    return this.config.analytics?.distinctId;
  }

  async getOrCreateAnalyticsInstallId(): Promise<string> {
    const existing = this.config.analytics?.installId;
    if (existing) return existing;
    const created = `install_${randomUUID()}`;
    const config = await this.updateConfigWith(current => (
      current.analytics?.installId ? {} : { analytics: { ...current.analytics!, installId: created } }
    ));
    return config.analytics?.installId ?? created;
  }

  async setAnalyticsDistinctId(distinctId: string): Promise<void> {
    await this.updateConfigWith(current => ({ analytics: { ...current.analytics!, distinctId } }));
  }

  async setAnalyticsIdentity(identity: AnalyticsIdentity): Promise<void> {
    await this.updateConfigWith(current => ({
      analytics: {
        ...current.analytics!,
        distinctId: identity.distinctId,
        identitySource: identity.identitySource,
        installId: identity.installId ?? current.analytics?.installId,
        githubUsername: identity.githubUsername,
        githubEmail: identity.githubEmail,
        gitEmail: identity.gitEmail,
        gitEmailHash: identity.gitEmailHash,
        gitUserName: identity.gitUserName,
      },
    }));
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
