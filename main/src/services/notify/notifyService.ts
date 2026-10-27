import { app, BrowserWindow, globalShortcut } from 'electron';
import path from 'path';
import type { ConfigManager } from '../configManager';
import type { AppConfig } from '../../types/config';
import {
  DEFAULT_NOTIFY_SETTINGS,
  type NotifyCaller,
  type NotifyCommand,
  type NotifyInstructionsFile,
  type NotifyRequest,
  type NotifyResult,
  type NotifySettings,
  type NotifySnapshot,
  type NotifySource,
  type NotifyWindowSize,
} from '../../../../shared/types/notify';
import { NotifyQueue } from './notifyQueue';
import { canFloatOverOtherApps, NotifyWindows } from './notifyWindows';
import { NotifyTray } from './notifyTray';
import { syncNotifyInstructions } from './notifyInstructions';

const AGENT_NAMES = new Map([['claude', 'Claude'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['opencode', 'OpenCode']]);

export interface NotifyServiceDependencies {
  configManager: ConfigManager;
  getMainWindow: () => BrowserWindow | null;
  /** The Pane and panel a call came from, when its PANE_SESSION_ID / PANE_PANEL_ID check out. */
  findPane: (caller: NotifyCaller) => { paneId: string; panelId?: string; name: string; agentType?: string } | undefined;
  /** Brings Pane to the front on the asking panel (`runpane panes focus`). */
  focusPanel: (paneId: string, panelId?: string) => Promise<void>;
  /** Arguments the main window's renderer reads before its first paint (theme). */
  rendererArguments: () => string[];
}

/**
 * Pane Notify in the main process: the queue plus every surface that shows it (the floating
 * strip and round, the tray icon, the main window) and the answer-all shortcut.
 */
export class NotifyService {
  readonly queue: NotifyQueue;
  private readonly windows: NotifyWindows;
  private readonly tray: NotifyTray;
  private shortcut: string | null = null;
  private shortcutRegistered = true;
  private broadcastPending = false;
  private lastSettings: NotifySettings;
  private lastAppearance: string;
  private instructionFiles: NotifyInstructionsFile[] = [];

  constructor(private readonly deps: NotifyServiceDependencies) {
    this.lastSettings = this.settings();
    this.lastAppearance = appearanceKey(deps.configManager.getConfig());
    this.queue = new NotifyQueue({
      settings: () => this.settings(),
      showOutsideSupported: canFloatOverOtherApps(),
      shortcutRegistered: () => this.shortcutRegistered,
      instructionFiles: () => this.instructionFiles,
    });
    this.windows = new NotifyWindows({
      rendererArguments: deps.rendererArguments,
      position: () => this.settings().position,
      onRoundClosed: () => this.queue.setRoundOpen(false),
    });
    this.tray = new NotifyTray({
      openRound: (itemId) => this.openRound(itemId),
      setShowOutsidePane: (show) => {
        this.updateSettings({ showOutsidePane: show }).catch((error: Error) => {
          // The menu flipped its checkbox; redraw it from the setting that is still saved.
          console.error(`[Notify] Show outside Pane was not saved because Pane could not write its config (${error.message}). The setting is unchanged. Free disk space or fix the config folder's permissions, then try again in Settings → Notify.`);
          this.scheduleBroadcast();
        });
      },
      pause: () => this.queue.run({ type: 'pause', minutes: 60 }),
      resume: () => this.queue.run({ type: 'resume' }),
      openInbox: () => this.navigate('inbox'),
      openSettings: () => this.navigate('settings'),
    });
    this.queue.on('change', () => this.scheduleBroadcast());
    this.queue.on('chime', () => this.sendToMainWindow('notify:chime'));
    deps.configManager.on('config-updated', (config: AppConfig) => {
      this.applySettings(notifySettings(config));
      // The floating windows read the palette when they load, so a new palette recreates them.
      const appearance = appearanceKey(config);
      if (appearance === this.lastAppearance) return;
      this.lastAppearance = appearance;
      this.windows.destroy();
      this.scheduleBroadcast();
    });
    this.applyShortcut(this.lastSettings);
    this.syncInstructions(this.lastSettings.enabled);
    this.scheduleBroadcast();
  }

  settings(): NotifySettings {
    return notifySettings(this.deps.configManager.getConfig());
  }

  /** The `runpane:notify` daemon command. */
  ask(request: NotifyRequest, signal?: AbortSignal): Promise<NotifyResult> {
    const { resume, returnAfterMs, caller, ...question } = request;
    return this.queue.ask({
      question: question.ui && question.title !== undefined ? { ...question, ui: question.ui, title: question.title } : undefined,
      resume,
      returnAfterMs,
      source: this.describeSource(caller),
    }, signal);
  }

  snapshot(): NotifySnapshot {
    return this.queue.snapshot();
  }

  async run(command: NotifyCommand): Promise<void> {
    switch (command.type) {
      case 'open-round': this.openRound(command.id); return;
      case 'close-round': this.windows.closeRound(); return;
      case 'open-inbox': this.navigate('inbox'); return;
      case 'open-in-pane': await this.openInPane(command.id); return;
      default: this.queue.run(command);
    }
  }

  setMainWindowFocused(focused: boolean): void {
    this.queue.setPaneFocused(focused);
  }

  resizeWindow(sender: Electron.WebContents, size: NotifyWindowSize): void {
    this.windows.resize(sender, size);
  }

  focusWindow(sender: Electron.WebContents): void {
    if (this.windows.isNotifyWindow(sender)) this.windows.focusStrip();
  }

  dispose(): void {
    this.queue.dispose();
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    this.tray.destroy();
    this.windows.destroy();
  }

  private openRound(itemId?: string): void {
    if (!this.settings().enabled || !this.queue.hasWaiting()) return;
    this.queue.setRoundOpen(true);
    this.windows.openRound(itemId);
  }

  private async openInPane(itemId: string): Promise<void> {
    const item = this.queue.snapshot().items.find(candidate => candidate.id === itemId);
    if (!item?.source.paneId) return;
    this.windows.closeRound();
    this.queue.run({ type: 'dock', id: itemId });
    await this.deps.focusPanel(item.source.paneId, item.source.panelId);
  }

  private navigate(target: 'inbox' | 'settings'): void {
    const window = this.deps.getMainWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.webContents.send('notify:navigate', target);
  }

  private async updateSettings(update: Partial<NotifySettings>): Promise<void> {
    await this.deps.configManager.updateConfig({ notify: update });
  }

  private applySettings(next: NotifySettings): void {
    const previous = this.lastSettings;
    this.lastSettings = next;
    if (previous.enabled && !next.enabled) this.queue.turnOff();
    if (previous.shortcut !== next.shortcut || previous.enabled !== next.enabled) this.applyShortcut(next);
    if (previous.enabled !== next.enabled) this.syncInstructions(next.enabled);
    this.scheduleBroadcast();
  }

  /** Keeps Pane's Notify block in the agents' user-level instruction files while Notify is on. */
  private syncInstructions(enabled: boolean): void {
    // PANE_DIR isolates app data, not the person's agent configuration: isolated runtimes leave it alone.
    if (process.env.PANE_DISABLE_OS_INTEGRATION === '1') return;
    this.instructionFiles = syncNotifyInstructions(enabled);
  }

  private applyShortcut(settings: NotifySettings): void {
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    this.shortcut = null;
    this.shortcutRegistered = true;
    if (!settings.enabled || !settings.shortcut) return;
    try {
      // register() returns false when another app already holds the shortcut.
      this.shortcutRegistered = globalShortcut.register(settings.shortcut, () => this.openRound());
    } catch (error) {
      console.warn(`[Notify] ${settings.shortcut} is not a shortcut Pane can register:`, error);
      this.shortcutRegistered = false;
    }
    if (this.shortcutRegistered) this.shortcut = settings.shortcut;
  }

  private describeSource(caller: NotifyCaller): NotifySource {
    const pane = this.deps.findPane(caller);
    const agent = caller.agent?.trim() || (pane?.agentType ? AGENT_NAMES.get(pane.agentType) : undefined) || 'Agent';
    if (pane) {
      const source: NotifySource = { paneId: pane.paneId, name: pane.name, agent };
      if (pane.panelId) source.panelId = pane.panelId;
      return source;
    }
    return { name: caller.cwd ? path.basename(caller.cwd) : 'Outside Pane', agent };
  }

  /** Coalesces a burst of queue changes into one snapshot per tick. */
  private scheduleBroadcast(): void {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    setImmediate(() => {
      this.broadcastPending = false;
      this.broadcast();
    });
  }

  private broadcast(): void {
    const snapshot = this.queue.snapshot();
    if (snapshot.stripSurface === 'window') {
      this.windows.showStrip();
      this.queue.noteStripShown();
    } else {
      this.windows.hideStrip();
      if (snapshot.stripSurface === 'pane') this.queue.noteStripShown();
    }
    if (!this.windows.isRoundOpen()) this.queue.setRoundOpen(false);
    this.tray.update({
      settings: snapshot.settings,
      waiting: this.queue.waitingItems(),
      paused: snapshot.pausedUntil !== null,
    });
    this.sendToMainWindow('notify:snapshot', snapshot);
    for (const contents of this.windows.webContents()) contents.send('notify:snapshot', snapshot);
  }

  private sendToMainWindow(channel: string, ...args: unknown[]): void {
    const window = this.deps.getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
  }
}

function notifySettings(config: AppConfig): NotifySettings {
  return { ...DEFAULT_NOTIFY_SETTINGS, ...config.notify };
}

function appearanceKey(config: AppConfig): string {
  return JSON.stringify([config.appearanceMode, config.theme, config.systemLightTheme, config.systemDarkTheme, config.highContrast]);
}
