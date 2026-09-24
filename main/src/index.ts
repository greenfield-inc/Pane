// Load ReadableStream polyfill before any other imports
import './polyfills/readablestream';

import { hasHeadlessDaemonLaunchArg, hasRemoteSetupLaunchArg } from './utils/runtimeMode';
import { getAppDirectory } from './utils/appDirectory';
import { readFileSync } from 'fs';
import { join } from 'path';
import { boundary, decodeBoundary } from '../../shared/validation/boundaryDecoder';
import type { PaneEventArgument } from './core/eventSink';

const launchHeadlessDaemon = hasHeadlessDaemonLaunchArg();
const launchRemoteSetup = hasRemoteSetupLaunchArg();

// Fix GTK 2/3 and GTK 4 conflict on Linux (Electron 36 issue)
// This MUST be done before importing electron
import { app } from 'electron';

if (process.platform === 'darwin') {
  // Work around unrecoverable Skia Graphite rendering glitches on macOS.
  // https://github.com/electron/electron/pull/49608
  app.commandLine.appendSwitch('disable-skia-graphite');
}

function getStartupTerminalPowerMode(): 'performance' | 'batterySaver' {
  try {
    const rawConfig = decodeBoundary(JSON.parse(
      readFileSync(join(getAppDirectory(), 'config.json'), 'utf-8'),
    ), boundary.object({ terminalPowerMode: boundary.optional(boundary.string) }));

    return rawConfig.terminalPowerMode === 'batterySaver'
      ? 'batterySaver'
      : 'performance';
  } catch {
    return 'performance';
  }
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3');

  if (launchHeadlessDaemon || launchRemoteSetup) {
    // Ozone has already picked its platform by the time this script runs, so
    // appending --ozone-platform here cannot select headless: no-display Linux
    // launches must pass `--ozone-platform=headless` as argv. (Before Electron
    // 38, ELECTRON_OZONE_PLATFORM_HINT=headless did that for us; the variable
    // was removed in 38 and is a no-op from 39 on.) --disable-gpu is still read
    // late enough to take effect here.
    app.commandLine.appendSwitch('disable-gpu');
  }
}

if (getStartupTerminalPowerMode() === 'batterySaver') {
  app.commandLine.appendSwitch('force_low_power_gpu');
}

// Set Windows AUMID to match electron-builder's appId so Windows resolves
// the installed Start Menu shortcut for notification icon and display name.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.dcouple.pane');
}

// Now import the rest of electron
import { BrowserWindow, Menu, ipcMain, shell, dialog, session, WebContents, webContents, WebContentsView, type BrowserWindowConstructorOptions } from 'electron';
import * as path from 'path';
import * as os from 'os';
import type { SessionManager } from './services/sessionManager';
import { isCliAgentType, resolveAgentTypeFromCommand } from './services/agents/agentIdentity';
import type { ConfigManager } from './services/configManager';
import { areKeyboardShortcutsEnabled, shouldForwardCommandPaletteShortcut } from './utils/keyboardShortcuts';
import {
  parseStoredOverlayColors,
  shouldEnableWindowControlsOverlay,
  WINDOW_CONTROLS_OVERLAY_ARG,
  WINDOW_CONTROLS_OVERLAY_COLORS_KEY,
  WINDOW_CONTROLS_OVERLAY_HEIGHT,
  type WindowControlsOverlayColors,
} from './utils/windowControlsOverlay';
import { parseStoredBackgroundColors, WINDOW_BACKGROUND_COLORS_KEY } from './utils/windowBackgroundColor';
import {
  applyNativeThemeSource,
  buildWindowAppearanceOptions,
  ensureNativeThemeForwarding,
  resolveOsPrefersDark,
} from './services/appearanceService';
import type { AppConfig } from './types/config';
import { normalizeAppearance } from '../../shared/types/appearance';
import type { WorktreeManager } from './services/worktreeManager';
import type { GitStatusManager } from './services/gitStatusManager';
import type { DatabaseService } from './database/database';
import type { RunCommandManager } from './services/runCommandManager';
import type { VersionChecker } from './services/versionChecker';
import type { Logger } from './utils/logger';
import type { ArchiveProgressManager } from './services/archiveProgressManager';
import type { AnalyticsManager } from './services/analyticsManager';
import { readWebAttribution, resolveAnalyticsIdentity } from './services/analyticsIdentity';
import { resourceMonitorService } from './services/resourceMonitorService';
import { applyAppDirectoryOverrideFromArgs, migrateDataDirectory } from './utils/appDirectory';
import { getCurrentWorktreeName } from './utils/worktreeUtils';
import { setupAutoUpdater } from './autoUpdater';
import type { CliManagerFactory } from './services/cliManagerFactory';
import { setupConsoleWrapper } from './utils/consoleWrapper';
import * as fs from 'fs';
import { terminalPanelManager } from './services/terminalPanelManager';
import { panelManager } from './services/panelManager';
import { worktreePoolManager } from './services/worktreePoolManager';
import { usageManager } from './services/usage/usageManager';
import { LeaderboardService } from './services/leaderboardService';
import { registerLeaderboardHandlers } from './ipc/leaderboard';
import { PtyHostSupervisor } from './ptyHost/ptyHostSupervisor';
import { syncAutoStartOnBoot } from './utils/autoStart';
import { createPaneDaemonHost, type PaneDaemonHost } from './daemon/bootstrap';
import { remotePaneClientController } from './daemon/client/remotePaneClient';
import { startHeadlessPaneProcess } from './daemon/startHeadless';
import { runRemoteSetupCli } from './daemon/setupRemoteHostCli';
import { PowerSaveManager } from './services/powerSaveManager';

export let mainWindow: BrowserWindow | null = null;

// Map webContentsId → {panelId, sessionId} for webview popup interception.
// Populated by browser-panel:register-webview IPC, consumed by did-attach-webview handler.
export const webviewContextMap = new Map<number, { panelId: string; sessionId: string }>();

// Active DevTools WebContentsViews, keyed by the page webContentsId they inspect
const activeDevToolsViews = new Map<number, Electron.WebContentsView>();
let devToolsHandlersRegistered = false;
let appearanceConfigSyncRegistered = false;

// Track partitions that already have the localhost header-stripping hook registered,
// so we don't add duplicate listeners when multiple webviews share the same partition.
const registeredPartitions = new Set<string>();

// Module-level shutdown guard to prevent multiple shutdown attempts
let shutdownInProgress = false;
interface AnalyticsLaunchContext {
  appVersion?: string;
  previousVersion?: string | null;
  isFirstLaunch?: boolean;
}

let analyticsLaunchContext: AnalyticsLaunchContext = {};

type RendererDiagnosticPayload = {
  kind?: string;
  message?: string;
  stack?: string;
  componentStack?: string;
  url?: string;
  line?: number;
  column?: number;
};

function safeDiagnosticValue(value: PaneEventArgument, maxLength = 4_000): string {
  let serialized: string;
  if (value instanceof Error) {
    serialized = `${value.name}: ${value.message}\n${value.stack || ''}`;
  } else if (decodeString(value) !== undefined) {
    serialized = decodeString(value) ?? '';
  } else {
    try {
      serialized = JSON.stringify(value) ?? String(value);
    } catch {
      serialized = String(value);
    }
  }

  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength)} ... [truncated ${serialized.length - maxLength} chars]`
    : serialized;
}

function decodeString(value: PaneEventArgument): string | undefined {
  try {
    return decodeBoundary(value, boundary.string);
  } catch {
    return undefined;
  }
}

function formatRendererDiagnostic(payload: RendererDiagnosticPayload): string {
  return [
    `kind=${JSON.stringify(payload.kind || 'unknown')}`,
    `message=${JSON.stringify(safeDiagnosticValue(payload.message || ''))}`,
    payload.url ? `url=${JSON.stringify(payload.url)}` : undefined,
    payload.line !== undefined ? `line=${payload.line}` : undefined,
    payload.column !== undefined ? `column=${payload.column}` : undefined,
    payload.stack ? `stack=${JSON.stringify(safeDiagnosticValue(payload.stack))}` : undefined,
    payload.componentStack ? `componentStack=${JSON.stringify(safeDiagnosticValue(payload.componentStack))}` : undefined,
  ].filter(Boolean).join(' ');
}

/**
 * Set the application title based on development mode and worktree
 */
function setAppTitle() {
  if (!app.isPackaged) {
    const worktreeName = getCurrentWorktreeName(process.cwd());
    if (worktreeName) {
      const title = `Pane [${worktreeName}]`;
      if (mainWindow) {
        mainWindow.setTitle(title);
      }
      return title;
    }
  }
  
  // Default title
  const title = 'Pane';
  if (mainWindow) {
    mainWindow.setTitle(title);
  }
  return title;
}
// Service instances (configManager exported for shell preference access)
export let configManager: ConfigManager;
let logger: Logger;
export let sessionManager: SessionManager;
let worktreeManager: WorktreeManager;
let cliManagerFactory: CliManagerFactory;
let gitStatusManager: GitStatusManager;
let databaseService: DatabaseService;
let runCommandManager: RunCommandManager;
let versionChecker: VersionChecker;
let archiveProgressManager: ArchiveProgressManager;
let leaderboardService: LeaderboardService;
let analyticsManager: AnalyticsManager;
let paneDaemonHost: PaneDaemonHost | null = null;
let powerSaveManager: PowerSaveManager | null = null;

// ptyHost supervisor — forked as an Electron UtilityProcess on app ready,
// but only when the `usePtyHost` setting is enabled (default: on for Windows). When
// disabled, the supervisor is never forked and every manager transparently
// falls through to the legacy in-main `pty.spawn` path.
let ptyHostSupervisor: PtyHostSupervisor | null = null;

/**
 * Getter for the ptyHost supervisor. Managers route spawn/write/resize/kill
 * through this when `configManager.getUsePtyHost()` returns true and the
 * supervisor fork succeeded. Returns null when the setting is off OR when
 * fork failed — callers must handle the null case and fall back to the
 * legacy `pty.spawn` path.
 */
export function getPtyHostSupervisor(): PtyHostSupervisor | null {
  return ptyHostSupervisor;
}

// Store app start time for session duration tracking
let appStartTime: number;

// Store original console methods before overriding
// These must be captured immediately when the module loads
const originalLog: typeof console.log = console.log;
const originalError: typeof console.error = console.error;
const originalWarn: typeof console.warn = console.warn;
const originalInfo: typeof console.info = console.info;
let isHandlingConsoleError = false;

const isDevelopment = process.env.NODE_ENV !== 'production' && !app.isPackaged;

// Reset debug log files at startup in development mode
if (!launchHeadlessDaemon && !launchRemoteSetup && isDevelopment) {
  const frontendLogPath = path.join(process.cwd(), 'frontend-debug.log');
  const backendLogPath = path.join(process.cwd(), 'backend-debug.log');

  try {
    fs.writeFileSync(frontendLogPath, '');
    fs.writeFileSync(backendLogPath, '');
  } catch (error) {
    // Don't crash if we can't reset the log files
    console.error('Failed to reset debug log files:', error);
  }
}

// Set up console wrapper to reduce logging in production
if (!launchHeadlessDaemon && !launchRemoteSetup) {
  setupConsoleWrapper();
}

if (!launchHeadlessDaemon && !launchRemoteSetup) {
  const overrideDir = applyAppDirectoryOverrideFromArgs();
  if (overrideDir) {
    console.log(`[Main] Using custom Pane directory: ${overrideDir}`);
  }

  // Migrate data directory from ~/.foozol to ~/.pane (one-time migration for existing users)
  migrateDataDirectory();
}

// Install Devtron in development
if (isDevelopment) {
  // Devtron can be installed manually in DevTools console with: require('devtron').install()
}

/**
 * Last overlay colours the renderer derived from the active theme. Read at
 * window creation, which happens before any renderer code runs, so a returning
 * user never sees the system-default plate flash before their theme applies.
 */
function readStoredOverlayColors(): WindowControlsOverlayColors | null {
  try {
    return parseStoredOverlayColors(
      databaseService?.getUserPreference(WINDOW_CONTROLS_OVERLAY_COLORS_KEY) ?? null
    );
  } catch (error) {
    console.error('Failed to read stored window controls overlay colors:', error);
    return null;
  }
}

function readStoredBackgroundColors() {
  try {
    return parseStoredBackgroundColors(
      databaseService?.getUserPreference(WINDOW_BACKGROUND_COLORS_KEY) ?? null,
    );
  } catch (error) {
    console.error('Failed to read stored window background colors:', error);
    return {};
  }
}

async function createWindow() {
  // Strip iframe-blocking headers for localhost URLs (enables embedded browser panel)
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [
      'http://localhost:*/*', 'http://127.0.0.1:*/*',
      'https://localhost:*/*', 'https://127.0.0.1:*/*',
      'http://[::1]:*/*', 'https://[::1]:*/*'
    ] },
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };

      // Remove X-Frame-Options and strip frame-ancestors from CSP (case-insensitive)
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === 'x-frame-options') {
          delete responseHeaders[key];
        }
        if (key.toLowerCase() === 'content-security-policy') {
          responseHeaders[key] = responseHeaders[key].map((value: string) =>
            value.replace(/frame-ancestors\s+[^;]+;?\s*/gi, '')
          );
        }
      }

      callback({ responseHeaders });
    }
  );

  // Remove the default menu bar on Windows/Linux for a cleaner look
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  const windowControlsOverlay = shouldEnableWindowControlsOverlay(process.platform, process.env);
  const appearance = normalizeAppearance(configManager.getConfig()).appearance;
  const osPrefersDark = resolveOsPrefersDark();
  applyNativeThemeSource(appearance);
  // Appearance edits that arrive through the config file watcher (not the
  // config:update IPC) must re-point nativeTheme too, or System mode resolves
  // against a themeSource still pinned by a previous Fixed palette.
  if (!appearanceConfigSyncRegistered) {
    appearanceConfigSyncRegistered = true;
    configManager.on('config-updated', (updated: AppConfig) => {
      applyNativeThemeSource(normalizeAppearance(updated).appearance);
    });
  }
  const appearanceOptions = buildWindowAppearanceOptions(
    appearance,
    osPrefersDark,
    readStoredBackgroundColors(),
  );

  // An icon path Electron cannot load is worse than none: on Windows it sets an
  // empty HICON, which clears the icon the window would otherwise inherit from
  // Pane.exe and leaves the taskbar showing the default. main's copy:assets puts
  // the file here and scripts/verify-packaged-icon.js fails the build if it is
  // ever missing again, so this only guards a broken tree.
  const windowIconPath = path.join(__dirname, '../assets/icon.png');

  const mainWindowOptions: BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    backgroundColor: appearanceOptions.backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // The renderer has to know whether it owns the title bar before its first
      // paint, so this travels in argv rather than over async IPC.
      additionalArguments: [
        ...appearanceOptions.additionalArguments,
        ...(windowControlsOverlay ? [WINDOW_CONTROLS_OVERLAY_ARG] : []),
      ],
    },
  };
  if (fs.existsSync(windowIconPath)) {
    mainWindowOptions.icon = windowIconPath;
  }
  if (process.platform === 'darwin') {
    mainWindowOptions.titleBarStyle = 'hiddenInset';
    mainWindowOptions.trafficLightPosition = { x: 10, y: 10 };
  } else if (windowControlsOverlay) {
    // The OS keeps the buttons (and Windows keeps Snap Layouts with them); the
    // rest of the strip becomes WindowTitleBar. Colours are seeded from the last
    // theme the renderer reported so the plate is not a grey block until the
    // first paint lands — see the theme bridge in ThemeProvider.
    const storedColors = readStoredOverlayColors();
    mainWindowOptions.titleBarStyle = 'hidden';
    mainWindowOptions.titleBarOverlay = storedColors
      ? { ...storedColors, height: WINDOW_CONTROLS_OVERLAY_HEIGHT }
      : { height: WINDOW_CONTROLS_OVERLAY_HEIGHT };
  }
  mainWindow = new BrowserWindow(mainWindowOptions);
  ensureNativeThemeForwarding(() => mainWindow);

  // Set main window on analytics manager for IPC forwarding
  if (analyticsManager) {
    analyticsManager.setMainWindow(mainWindow);
  }

  // Increase max listeners to prevent warning when many panels are active
  // Each panel can register multiple event listeners
  mainWindow.webContents.setMaxListeners(100);

  // Hand the renderer its per-window ptyHost data port on every load. This must
  // be registered before loadURL/loadFile below: those promises resolve on
  // did-finish-load, so a listener added after them never fires and terminals
  // silently drop all output once they switch to the port. `on` (not `once`)
  // re-attaches after renderer reloads, which replace the preload's port.
  mainWindow.webContents.on('did-finish-load', () => {
    if (ptyHostSupervisor && mainWindow && !mainWindow.isDestroyed()) {
      ptyHostSupervisor.attachWindow(mainWindow.webContents);
    }
  });

  // Security hook: strip preload and enforce sandbox on any webview tags
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, _params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  // Set up popup interception on webviews IMMEDIATELY when they attach (before any page loads).
  // This prevents the race condition where a page calls window.open() before dom-ready fires.
  // The context map (panelId/sessionId) is populated later by the browser-panel:register-webview IPC.
  mainWindow.webContents.on('did-attach-webview', (_event, wvContents: WebContents) => {
    wvContents.setWindowOpenHandler(({ url, disposition }) => {
      // Auth popups (Firebase signInWithPopup, OAuth providers, etc.) use window.open()
      // with explicit features (width, height, toolbar=no), which Chromium reports as
      // disposition 'new-window'. Let these open as real BrowserWindows so the
      // postMessage channel between popup and opener remains intact.
      if (disposition === 'new-window') {
        if (!webviewContextMap.has(wvContents.id)) {
          console.warn('[BrowserPanel] Auth popup allowed for unregistered webview (pre-dom-ready), wcId:', wvContents.id);
        }
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: {
              contextIsolation: true,
              sandbox: true,
            },
          },
        };
      }

      // Regular navigations (target="_blank" links, etc.) → open as new browser panel tab
      const ctx = webviewContextMap.get(wvContents.id);
      if (ctx) {
        mainWindow?.webContents.send('browser-panel:popup-requested', {
          url,
          sourceSessionId: ctx.sessionId,
          sourcePanelId: ctx.panelId,
        });
      } else {
        // Context not yet registered (popup fired before dom-ready).
        // Fall back to opening in the system browser so the popup isn't silently lost.
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // Track and manage auth popup windows created by { action: 'allow' }.
    // Clean up when the parent webview is destroyed so popups don't orphan.
    wvContents.on('did-create-window', (popupWindow) => {
      // If the parent webview is destroyed (e.g., panel closed), close the popup too.
      // This is a one-shot listener; safe even if the popup closes first because
      // popupWindow.isDestroyed() is checked before calling close().
      wvContents.once('destroyed', () => {
        if (!popupWindow.isDestroyed()) {
          popupWindow.close();
        }
      });
    });

    wvContents.setBackgroundThrottling(true);

    // Forward app hotkeys from webview to renderer.
    // Webviews are separate processes — keyboard events inside them never reach
    // the renderer's window listener where the hotkey system lives. Only intercept
    // the specific Ctrl/Cmd+key combos that Pane actually handles, so that normal
    // browser shortcuts (Ctrl+F, Ctrl+R, Ctrl+A in inputs, etc.) still work
    // inside embedded browser panels.
    // Whitelist of Pane hotkeys that should be forwarded from webviews.
    // mod+key (no extra modifiers):
    const paneHotkeys: ReadonlySet<string> = new Set([
      'b', ',', 'n', 'a', 'd', 'w', 't', '`',
      // mod+1..9 switch session, mod+Tab/ArrowDown cycle next
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
      'tab', 'arrowdown', 'arrowup',
    ]);
    // mod+shift+key — matched by physical key code (Digit/Key) because
    // input.key reports the shifted symbol (e.g. '!' for Shift+1) which
    // varies by keyboard layout.
    const paneShiftCodes: ReadonlySet<string> = new Set([
      'KeyE', 'KeyN', 'KeyK', 'KeyP', 'KeyZ', 'KeyL', 'KeyR', 'KeyM', 'KeyU',
      'KeyB', 'KeyW', 'KeyD',
      'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
      'Digit6', 'Digit7', 'Digit8', 'Digit9',
      'Tab', // mod+shift+Tab cycles prev session
    ]);
    wvContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mod = input.control || input.meta;
      if (!mod) return;

      const key = input.key.toLowerCase();
      const code = input.code;
      const config = configManager.getConfig();
      if (
        !areKeyboardShortcutsEnabled(config)
        && !shouldForwardCommandPaletteShortcut(config, input)
      ) return;

      // Skip AltGr: on Windows/Linux international layouts, AltGr reports
      // control+alt simultaneously. We detect this as control+alt without
      // meta, and only forward when the physical key is a letter, digit,
      // or slash (the patterns used by Pane's mod+alt shortcuts). This
      // prevents blocking character input like @, €, or \ on those layouts.
      const isAltGr = input.control && input.alt && !input.meta
        && !/^(Key[A-Z]|Digit[0-9]|Slash)$/.test(code);

      // Determine if this combo matches a registered Pane hotkey.
      // mod+alt combos are forwarded (user-configurable terminal shortcuts
      // use mod+alt+<key>), but AltGr character input is excluded above.
      const isPaneHotkey =
        (input.alt && !isAltGr) ||
        (input.shift && !input.alt && paneShiftCodes.has(code)) ||
        (!input.shift && !input.alt && paneHotkeys.has(key));

      if (!isPaneHotkey) return;

      event.preventDefault();
      mainWindow?.webContents.send('synthetic-keydown', {
        key: input.key,
        code: input.code,
        ctrlKey: input.control,
        metaKey: input.meta,
        shiftKey: input.shift,
        altKey: input.alt,
      });
    });

    // Apply the same localhost header-stripping to the webview's session/partition.
    // Without this, webview partitions don't inherit the defaultSession's onHeadersReceived
    // hook, so localhost apps that send X-Frame-Options headers would be blocked.
    // Only register once per partition to avoid duplicate listeners accumulating.
    const wvSession = wvContents.session;
    const partitionKey = wvSession.storagePath ?? 'default';
    if (wvSession !== session.defaultSession && !registeredPartitions.has(partitionKey)) {
      registeredPartitions.add(partitionKey);
      wvSession.webRequest.onHeadersReceived(
        { urls: [
          'http://localhost:*/*', 'http://127.0.0.1:*/*',
          'https://localhost:*/*', 'https://127.0.0.1:*/*',
          'http://[::1]:*/*', 'https://[::1]:*/*'
        ] },
        (details, callback) => {
          const responseHeaders = { ...details.responseHeaders };
          for (const key of Object.keys(responseHeaders)) {
            if (key.toLowerCase() === 'x-frame-options') {
              delete responseHeaders[key];
            }
            if (key.toLowerCase() === 'content-security-policy') {
              responseHeaders[key] = responseHeaders[key].map((value: string) =>
                value.replace(/frame-ancestors\s+[^;]+;?\s*/gi, '')
              );
            }
          }
          callback({ responseHeaders });
        }
      );
    }
  });

  // Inline DevTools: create a WebContentsView overlay at the specified bounds.
  // WebContentsView from the main process satisfies setDevToolsWebContents' requirement
  // that the target has never navigated (webview-to-webview is broken since Electron 3).
  // Guard: only register once (createWindow can be called again on macOS activate).
  if (!devToolsHandlersRegistered) {
  devToolsHandlersRegistered = true;
  ipcMain.handle('browser-panel:open-devtools-inline', async (_, pageWcId: number, bounds: { x: number; y: number; width: number; height: number }) => {
    try {
      const pageWC = webContents.fromId(pageWcId);
      if (!pageWC || !mainWindow) return { success: false, error: 'WebContents or window not found' };

      // Clean up any existing devtools view for this page
      const existing = activeDevToolsViews.get(pageWcId);
      if (existing) {
        mainWindow.contentView.removeChildView(existing);
        existing.webContents.close();
      }

      const devtoolsView = new WebContentsView();
      mainWindow.contentView.addChildView(devtoolsView);
      devtoolsView.setBounds(bounds);

      pageWC.setDevToolsWebContents(devtoolsView.webContents);
      pageWC.openDevTools({ mode: 'detach' });

      activeDevToolsViews.set(pageWcId, devtoolsView);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to open inline devtools:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('browser-panel:resize-devtools', async (_, pageWcId: number, bounds: { x: number; y: number; width: number; height: number }) => {
    const view = activeDevToolsViews.get(pageWcId);
    if (view) view.setBounds(bounds);
    return { success: true };
  });

  ipcMain.handle('browser-panel:close-devtools', async (_, pageWcId: number) => {
    try {
      const view = activeDevToolsViews.get(pageWcId);
      if (view && mainWindow) {
        mainWindow.contentView.removeChildView(view);
        view.webContents.close();
        activeDevToolsViews.delete(pageWcId);
      }
      const pageWC = webContents.fromId(pageWcId);
      if (pageWC) pageWC.closeDevTools();
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to close devtools:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  } // end devToolsHandlersRegistered guard

  // Prevent Ctrl+W / Cmd+W from closing the Electron window so the renderer
  // can use it to close tabs. We intercept at before-input-event and re-emit
  // the key as a DOM keydown via IPC so the renderer's hotkey system sees it.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!areKeyboardShortcutsEnabled(configManager.getConfig())) return;
    if ((input.control || input.meta) && input.key.toLowerCase() === 'w' && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow?.webContents.send('synthetic-keydown', {
        key: input.key,
        code: input.code,
        ctrlKey: input.control,
        metaKey: input.meta,
        shiftKey: input.shift,
        altKey: input.alt,
      });
    }
  });

  if (isDevelopment) {
    const devPort = process.env.VITE_PORT || process.env.PORT || '4521';
    await mainWindow.loadURL(`http://localhost:${devPort}`);
    // DevTools stay closed unless asked for: PANE_OPEN_DEVTOOLS=1 pnpm dev.
    if (process.env.PANE_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools();
    }

  } else {
    // In production, use app.getAppPath() to get the root directory
    // This works correctly whether the app is packaged in ASAR or not
    const indexPath = path.join(app.getAppPath(), 'frontend/dist/index.html');
    console.log('Loading index.html from:', indexPath);

    try {
      await mainWindow.loadFile(indexPath);
    } catch (error) {
      console.error('Failed to load index.html:', error);
      console.error('App path:', app.getAppPath());
      console.error('__dirname:', __dirname);
      
      // Fallback: try relative path (for edge cases)
      const fallbackPath = path.join(__dirname, '../../../../frontend/dist/index.html');
      console.error('Trying fallback path:', fallbackPath);
      try {
        await mainWindow.loadFile(fallbackPath);
      } catch (fallbackError) {
        console.error('Fallback path also failed:', fallbackError);
      }
    }
  }

  // Set the app title based on development mode and worktree
  setAppTitle();

  // Apply persisted UI scale
  const uiScale = configManager.getConfig().uiScale;
  if (uiScale && uiScale !== 1.0) {
    mainWindow.webContents.setZoomFactor(uiScale);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('about:')) {
      return { action: 'deny' };
    }

    void shell.openExternal(url).catch((error) => {
      console.error('Failed to open external URL from window.open:', error);
    });
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Log any console messages from the renderer
  mainWindow.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event;
    // Skip messages that are already prefixed to avoid circular logging
    if (message.includes('[Main Process]') || message.includes('[Renderer]')) {
      return;
    }
    // Also skip Electron security warnings and other system messages
    if (message.includes('Electron Security Warning') || sourceId.includes('electron/js2c')) {
      return;
    }

    // In development, log ALL console messages to help with debugging
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [FRONTEND ${level.toUpperCase()}] ${message}`;

      // Also write to debug log file for Claude Code to read
      const debugLogPath = path.join(process.cwd(), 'frontend-debug.log');
      const logLine = `${logMessage} (${path.basename(sourceId)}:${lineNumber})\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        console.error('Failed to write to debug log:', error);
      }
    }
  });

  // Override console methods to forward to renderer and logger
  console.log = (...args: PaneEventArgument[]) => {
    // Format the message
    const message = args.map(arg => safeDiagnosticValue(arg)).join(' ');

    // Write to logger if available
    if (logger) {
      logger.info(message);
    } else {
      originalLog.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND LOG] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalLog('[Main] Failed to write to backend debug log:', error);
      }
    }

    // Forward to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'log', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalLog('[Main] Failed to send log to renderer:', e);
      }
    }
  };

  console.error = (...args: PaneEventArgument[]) => {
    // Prevent infinite recursion by checking if we're already in an error handler
    if (isHandlingConsoleError) {
      return originalError.apply(console, args);
    }
    
    isHandlingConsoleError = true;
    
    try {
      // If logger is not initialized or we're in the logger itself, use original console
      if (!logger) {
        originalError.apply(console, args);
        return;
      }

      const message = args.map(arg => safeDiagnosticValue(arg)).join(' ');

      // Extract Error object if present
      const errorObj = args.find((arg): arg is Error => arg instanceof Error);

      // Use logger but with recursion protection
      logger.error(message, errorObj);

      // In development, also write to backend debug log file
      if (isDevelopment) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [BACKEND ERROR] ${message}`;
        const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
        const logLine = `${logMessage}\n`;

        try {
          fs.appendFileSync(debugLogPath, logLine);
        } catch (error) {
          // Don't crash if we can't write to the log file
          originalError('[Main] Failed to write to backend debug log:', error);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('main-log', 'error', message);
        } catch (e) {
          // If sending to renderer fails, use original console to avoid recursion
          originalError('[Main] Failed to send error to renderer:', e);
        }
      }
    } catch {
      // If anything fails in the error handler, fall back to original
      originalError.apply(console, args);
    } finally {
      isHandlingConsoleError = false;
    }
  };

  console.warn = (...args: PaneEventArgument[]) => {
    const message = args.map(arg => safeDiagnosticValue(arg)).join(' ');

    // Extract Error object if present for warnings too
    const errorObj = args.find((arg): arg is Error => arg instanceof Error);

    if (logger) {
      logger.warn(message, errorObj);
    } else {
      originalWarn.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND WARNING] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalWarn('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'warn', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalWarn('[Main] Failed to send warning to renderer:', e);
      }
    }
  };

  console.info = (...args: PaneEventArgument[]) => {
    const message = args.map(arg => safeDiagnosticValue(arg)).join(' ');

    if (logger) {
      logger.info(message);
    } else {
      originalInfo.apply(console, args);
    }

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND INFO] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        originalInfo('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'info', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        originalInfo('[Main] Failed to send info to renderer:', e);
      }
    }
  };

  console.debug = (...args: PaneEventArgument[]) => {
    const message = args.map(arg => safeDiagnosticValue(arg)).join(' ');

    // In development, also write to backend debug log file
    if (isDevelopment) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [BACKEND DEBUG] ${message}`;
      const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
      const logLine = `${logMessage}\n`;

      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        // Don't crash if we can't write to the log file
        console.error('[Main] Failed to write to backend debug log:', error);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('main-log', 'debug', message);
      } catch (e) {
        // If sending to renderer fails, use original console to avoid recursion
        console.error('[Main] Failed to send debug to renderer:', e);
      }
    }
  };

  // Handle renderer process crashes with recovery
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[RendererLifecycle] render-process-gone:', details.reason, details);
    if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
      // Attempt to reload the renderer
      console.log('[Main] Attempting to recover renderer...');
      try {
        mainWindow?.webContents.reload();
      } catch (err) {
        console.error('[Main] Failed to reload renderer after crash:', err);
      }
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[RendererLifecycle] unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('[RendererLifecycle] responsive');
  });

  // Handle window focus/blur/minimize for smart git status polling and
  // renderer-side notification gating. Send focus state to renderer so
  // useNotifications can use the reliable BrowserWindow source of truth
  // instead of document.hasFocus() (which lies when DevTools is focused).
  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window:focus-changed', true);
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(false); // false = visible/focused
    }
    resourceMonitorService.handleVisibilityChange(false);
  });

  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window:focus-changed', false);
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(true); // true = hidden/blurred
    }
    resourceMonitorService.handleVisibilityChange(true);
  });

  mainWindow.on('minimize', () => {
    mainWindow?.webContents.send('window:focus-changed', false);
    if (gitStatusManager) {
      gitStatusManager.handleVisibilityChange(true); // true = hidden/minimized
    }
    resourceMonitorService.handleVisibilityChange(true);
  });

  mainWindow.on('restore', () => {
    // Don't assume restore = focused. The OS will fire 'focus' if/when the user
    // actually focuses the window; that is what restarts git/resource work.
    const focused = mainWindow?.isFocused() ?? false;
    mainWindow?.webContents.send('window:focus-changed', focused);
  });
}

async function initializeServices() {
  const electronPaneEventSink = {
    send(channel: string, ...args: PaneEventArgument[]) {
      if (!remotePaneClientController.shouldForwardLocalRendererEvent(channel)) {
        return;
      }

      const window = mainWindow;
      if (!window || window.isDestroyed()) {
        return;
      }

      window.webContents.send(channel, ...args);
    },
  };

  paneDaemonHost = await createPaneDaemonHost({
    app,
    getMainWindow: () => mainWindow,
    getPtyHostRuntime: () => ptyHostSupervisor,
    getWebviewContextMap: () => webviewContextMap,
    rendererEventSink: electronPaneEventSink,
  });

  const services = paneDaemonHost.services;
  if (!services.logger || !services.archiveProgressManager || !services.analyticsManager) {
    throw new Error('Pane daemon host did not initialize required core services');
  }
  configManager = services.configManager;
  databaseService = services.databaseService;
  sessionManager = services.sessionManager;
  worktreeManager = services.worktreeManager;
  cliManagerFactory = services.cliManagerFactory;
  gitStatusManager = services.gitStatusManager;
  runCommandManager = services.runCommandManager;
  versionChecker = services.versionChecker;
  logger = services.logger;
  archiveProgressManager = services.archiveProgressManager;
  analyticsManager = services.analyticsManager;
  powerSaveManager = new PowerSaveManager(configManager, sessionManager);
  powerSaveManager.sync();

  leaderboardService = new LeaderboardService(configManager);
  registerLeaderboardHandlers(ipcMain, leaderboardService);

  ipcMain.handle('analytics:get-identity', async () => {
    try {
      const installId = await configManager.getOrCreateAnalyticsInstallId();
      const currentVersion = analyticsLaunchContext.appVersion || app.getVersion();
      const previousVersion =
        analyticsLaunchContext.previousVersion !== undefined
          ? analyticsLaunchContext.previousVersion
          : databaseService.getLastAppVersion();
      const isFirstLaunch = analyticsLaunchContext.isFirstLaunch ?? previousVersion === null;
      const identity = await resolveAnalyticsIdentity(configManager.getAnalyticsDistinctId(), installId);
      const webDistinctId = readWebAttribution(getAppDirectory());
      if (webDistinctId) {
        identity.webDistinctId = webDistinctId;
      }
      identity.appVersion = currentVersion;
      identity.platform = os.platform();
      identity.electronVersion = process.versions.electron;
      identity.webAttributionPresent = webDistinctId !== undefined;
      identity.isFirstLaunch = isFirstLaunch;
      identity.previousVersion = previousVersion;
      await configManager.setAnalyticsIdentity(identity);
      return { success: true, data: identity };
    } catch (error) {
      console.error('[Analytics] Failed to resolve identity:', error);
      return { success: false, error: 'Failed to resolve analytics identity' };
    }
  });

  ipcMain.handle('analytics:redeem-attribution', async () => {
    try {
      await fs.promises.unlink(path.join(getAppDirectory(), 'attribution_ref')).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
      return { success: true };
    } catch (error) {
      console.error('[Analytics] Failed to redeem attribution:', error);
      return { success: false, error: 'Failed to redeem analytics attribution' };
    }
  });

  // Receive the renderer's PostHog distinct ID so shutdown analytics use the same identity
  ipcMain.on('analytics:sync-distinct-id', async (_event: Electron.IpcMainEvent, distinctId: string) => {
    try {
      await configManager.setAnalyticsDistinctId(distinctId);
    } catch (error) {
      console.error('[Analytics] Failed to persist distinct ID:', error);
    }
  });

  // Console log IPC handler. The preload console wrapper (dev-only) forwards
  // every renderer console call here for frontend-debug.log capture. Renderer
  // callers can also invoke this directly and set `toMainLog: true` to also
  // land the message in the main Logger's pane-*.log — used for surfacing
  // WebGL lifecycle events so ARM-Windows validation can confirm WebGL loaded
  // in production builds, where the preload wrapper is inactive.
  ipcMain.handle('console:log', (_event, logData: { level: string; args: string[]; timestamp: string; source: string; toMainLog?: boolean }) => {
    const { level, args, timestamp, source, toMainLog } = logData;
    const message = args.join(' ');

    if (isDevelopment) {
      const logLine = `[${timestamp}] [${source.toUpperCase()} ${level.toUpperCase()}] ${message}\n`;
      const debugLogPath = path.join(process.cwd(), 'frontend-debug.log');
      try {
        fs.appendFileSync(debugLogPath, logLine);
      } catch (error) {
        console.error('Failed to write console log to debug file:', error);
      }
      console.log(`[Frontend ${level}] ${message}`);
    }

    if (toMainLog) {
      const forwarded = `[${source}] ${message}`;
      if (level === 'error') {
        logger.error(forwarded);
      } else if (level === 'warn') {
        logger.warn(forwarded);
      } else {
        logger.info(forwarded);
      }
    }
  });

  ipcMain.handle('diagnostics:renderer-fatal', (_event, payload: RendererDiagnosticPayload) => {
    logger.error(`[RendererFatal] ${formatRendererDiagnostic(payload || {})}`);
    return { success: true };
  });
}

if (launchRemoteSetup) {
  // A rejection here used to go unhandled, which left the process alive with no
  // output instead of failing: remote setup is a print-and-exit path, so a throw
  // that never reaches app.exit() reads as a hang.
  void runRemoteSetupCli(process.argv).then((exitCode) => {
    app.exit(exitCode);
  }).catch((error) => {
    console.error('[Main] Remote setup failed:', error instanceof Error ? (error.stack ?? error.message) : error);
    app.exit(1);
  });
} else if (launchHeadlessDaemon) {
  startHeadlessPaneProcess();
} else {
  app.whenReady().then(async () => {
    appStartTime = Date.now();

    console.log('[Main] App is ready, initializing services...');
    await initializeServices();
    syncAutoStartOnBoot(app, configManager.getConfig().autoStartOnBoot !== false);
    console.log('[Main] Services initialized, creating window...');

  // Register before any renderer loads. useNotifications pulls this on mount
  // and will race a late registration inside createWindow/loadURL.
  ipcMain.handle('window:is-focused', () => mainWindow?.isFocused() ?? true);

  // Start the ptyHost supervisor before the window opens so the renderer's
  // preload listener for 'ptyHost-port' has a port to receive when the window
  // finishes loading. Gated on the `usePtyHost` setting: when off,
  // the supervisor is never forked and every spawn site falls through to the
  // legacy in-main `pty.spawn` path with zero ptyHost code executing.
  if (configManager.getUsePtyHost()) {
    try {
      ptyHostSupervisor = new PtyHostSupervisor();
      await ptyHostSupervisor.start();

      ptyHostSupervisor.on('renderer-ack', (ptyId: string, bytes: number) => {
        terminalPanelManager.acknowledgePtyHostBytes(ptyId, bytes);
      });

      // Auto-reattach: on ptyHost restart, every manager re-enters the spawn
      // path for its live panels. Order (per plan Task 6b / gotcha line 825):
      //   rejectPendingRpcs → keep manager maps → await nextReady → respawnAll
      // The supervisor keeps manager maps intact; the `ready-after-restart`
      // event marks "await nextReady" complete so we can drive respawnAll across
      // every manager in parallel.
      ptyHostSupervisor.on('ready-after-restart', () => {
        console.log('[ptyHost] ready-after-restart; fanning respawnAll across managers');
        const respawnTasks: Array<Promise<void>> = [
          terminalPanelManager.respawnAll(),
        ];
        if (cliManagerFactory) {
          const managers = cliManagerFactory.getAllManagers();
          for (const manager of managers) {
            respawnTasks.push(manager.respawnAll());
          }
        }
        if (runCommandManager) {
          respawnTasks.push(runCommandManager.respawnAll());
        }
        if (sessionManager) {
          respawnTasks.push(sessionManager.respawnAll());
        }
        Promise.all(respawnTasks)
          .then(() => console.log('[ptyHost] respawnAll fan-out complete'))
          .catch((err) => console.error('[ptyHost] respawnAll fan-out error:', err));
      });
    } catch (error) {
      console.error('[ptyHost] supervisor failed to start; legacy pty.spawn path will be used', error);
      ptyHostSupervisor = null;
    }
  } else {
    console.log('[ptyHost] usePtyHost setting is disabled; skipping supervisor fork');
  }

  await createWindow();
  console.log('[Main] Window created successfully');

  // Crash sentinel: detect if the previous session ended uncleanly.
  // We write a file on startup and delete it on clean shutdown.
  // If it exists at startup, the app crashed or the OS killed it.
  const crashSentinelPath = path.join(getAppDirectory(), '.running');
  try {
    if (fs.existsSync(crashSentinelPath)) {
      console.warn('[Main] Unclean shutdown detected — crash sentinel was still present');
      // Notify the renderer once it's ready
      mainWindow?.webContents.once('did-finish-load', () => {
        mainWindow?.webContents.send('app:unclean-shutdown-detected');
      });
    }
    // Write the sentinel for this session
    fs.writeFileSync(crashSentinelPath, `${process.pid}\n${new Date().toISOString()}`);
  } catch (err) {
    console.warn('[Main] Failed to manage crash sentinel:', err);
  }

  // Track app lifecycle events
  try {
    const currentVersion = app.getVersion();
    const lastVersion = databaseService.getLastAppVersion();
    const isFirstLaunch = lastVersion === null;
    analyticsLaunchContext = {
      appVersion: currentVersion,
      previousVersion: lastVersion,
      isFirstLaunch,
    };

    if (lastVersion && lastVersion !== currentVersion) {
      analyticsManager.track('app_updated', {
        previous_version: lastVersion,
        new_version: currentVersion,
      });
    }

    // Reactivation detection — fire BEFORE recording this open so the
    // previous open is the one we compute the gap from. Distinct events
    // for 7d and 30d so dashboards can filter by intent (light churn vs
    // deep churn). PostHog distinct_id dedupes naturally for "how many
    // users came back" counts.
    const lastOpen = databaseService.getLastAppOpen();
    if (lastOpen?.opened_at) {
      const gapMs = Date.now() - new Date(lastOpen.opened_at).getTime();
      const gapDays = Math.floor(gapMs / (1000 * 60 * 60 * 24));
      if (gapDays >= 30) {
        analyticsManager.track('app_reactivated_after_30d', { gap_days: gapDays });
      } else if (gapDays >= 7) {
        analyticsManager.track('app_reactivated_after_7d', { gap_days: gapDays });
      }
    }

    analyticsManager.track('app_opened', {
      is_first_launch: isFirstLaunch,
    });

    databaseService.recordAppOpen(false, false, currentVersion);
  } catch (error) {
    console.error('[Main] Failed to track app lifecycle events:', error);
  }

  // Configure auto-updater
  setupAutoUpdater(() => mainWindow);

  // Check for updates after window is created
  setTimeout(async () => {
    console.log('[Main] Performing startup version check...');
    await versionChecker.checkOnStartup();
  }, 1000); // Small delay to ensure window is fully ready

// Initialize worktree pool — cleanup orphans and seed reserves
  setTimeout(async () => {
    try {
      const projects = databaseService.getAllProjects();
      // Cleanup leftover reserves from previous runs — await before seeding new ones
      await Promise.all(
        projects
          .filter(p => p.path)
          .map(project => {
            const ctx = sessionManager.getProjectContextByProjectId(project.id);
            if (!ctx) return Promise.resolve();
            return worktreePoolManager.cleanupOrphanedReserves(project.path!, ctx.commandRunner).catch(() => {});
          })
      );
      // Seed a reserve for the active project
      const activeProject = sessionManager.getActiveProject();
      if (activeProject?.path) {
        const ctx = sessionManager.getProjectContextByProjectId(activeProject.id);
        if (ctx) {
          const mainBranch = await worktreeManager.getProjectMainBranch(activeProject.path, ctx.commandRunner).catch(() => 'HEAD');
          worktreePoolManager.createReserve(
            activeProject.path,
            mainBranch,
            activeProject.worktree_folder ?? undefined,
            ctx.pathResolver,
            ctx.commandRunner
          ).catch(() => {});
        }
      }
    } catch (error) {
      console.warn('[WorktreePool] Initialization failed:', error);
    }
  }, 5000); // Delay to not slow down app startup

  // Index agent CLI transcripts for the usage page. Read-only, and deferred so
  // a first pass over a large ~/.claude never delays window creation.
  setTimeout(() => {
    void usageManager.start()
      .then(() => leaderboardService.submitOnAppOpen())
      .catch(error => {
        console.warn('[Usage] Failed to start transcript indexing:', error);
      });
  }, 8000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        console.log('[Main] Activating app, creating new window...');
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', async (event) => {
  // Write directly to debug log to ensure shutdown is visible even if console override fails
  const debugLogPath = path.join(process.cwd(), 'backend-debug.log');
  const logToFile = (msg: string) => {
    try {
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] [SHUTDOWN] ${msg}\n`);
    } catch { /* ignore */ }
  };

  logToFile('before-quit fired');

  usageManager.stop();

  // Guard against multiple shutdown attempts
  if (shutdownInProgress) {
    logToFile('shutdown already in progress, skipping');
    return;
  }

  // Prevent default quit behavior - we'll manually exit when ready
  event.preventDefault();
  shutdownInProgress = true;
  logToFile('shutdown started');

  // Check if there are active archive tasks (before try/finally so "Wait" can cancel quit)
  if (archiveProgressManager && archiveProgressManager.hasActiveTasks()) {
    console.log('[Main] Archive tasks in progress, showing warning dialog...');
    const activeCount = archiveProgressManager.getActiveTaskCount();
    const choice = mainWindow
      ? dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          title: 'Archive Tasks In Progress',
          message: `Pane is removing ${activeCount} worktree${activeCount > 1 ? 's' : ''} in the background.`,
          detail: 'Git worktree removal can take time, especially for large repositories with many files. If you quit now, the worktree directories may not be fully cleaned up and you may need to remove them manually.\n\nDo you want to quit anyway?',
          buttons: ['Wait', 'Quit Anyway'],
          defaultId: 0,
          cancelId: 0
        })
      : dialog.showMessageBoxSync({
          type: 'warning',
          title: 'Archive Tasks In Progress',
          message: `Pane is removing ${activeCount} worktree${activeCount > 1 ? 's' : ''} in the background.`,
          detail: 'Git worktree removal can take time, especially for large repositories with many files. If you quit now, the worktree directories may not be fully cleaned up and you may need to remove them manually.\n\nDo you want to quit anyway?',
          buttons: ['Wait', 'Quit Anyway'],
          defaultId: 0,
          cancelId: 0
        });

    if (choice === 0) {
      // User chose to wait - reset guard and cancel quit
      shutdownInProgress = false;
      return;
    }

    // User chose to quit anyway
    archiveProgressManager.clearAll();
  }

  powerSaveManager?.dispose();
  powerSaveManager = null;

  // Safety net: force exit if graceful shutdown takes too long
  // Placed after the dialog so user interaction time isn't counted
  const shutdownSafetyTimeout = setTimeout(() => {
    logToFile('FORCED EXIT: shutdown timed out after 10s');
    app.exit(1);
  }, 10_000);

  try {
    if (paneDaemonHost?.paneDaemonServer) {
      logToFile('Stopping local daemon server early');
      console.log('[Main] Stopping local daemon server early...');
      await paneDaemonHost.paneDaemonServer.stop();
      console.log('[Main] Local daemon server stopped');
    }

    // Stop resource monitoring
    resourceMonitorService.stop();

    // Phase 1: Send Ctrl+C to all terminals to gracefully exit Claude instances
    // Claude needs to exit cleanly so it releases the session ID lock, allowing
    // us to resume with --resume <panelId> on next launch.
    const shutdownStartTime = Date.now();
    logToFile('Phase 1: sending Ctrl+C to all terminals');
    console.log('[Main] Graceful shutdown: sending Ctrl+C to all terminals...');
    const signaledPanels = terminalPanelManager.sendCtrlCToAll();
    logToFile(`Signaled ${signaledPanels.length} terminals: ${signaledPanels.join(', ')}`);
    if (signaledPanels.length > 0) {
      // Send a second Ctrl+C after a short delay to ensure Claude exits
      await new Promise(resolve => setTimeout(resolve, 200));
      terminalPanelManager.sendCtrlCToAll();
      logToFile('Sent second Ctrl+C, waiting 2s...');
      // Wait for Claude to fully exit and release session locks
      console.log(`[Main] Waiting for ${signaledPanels.length} terminal(s) to exit (2s)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      logToFile('2s wait complete');
    }

    // Phase 2: Save terminal states and mark CLI agent terminals as interrupted
    logToFile('Phase 2: saving terminal states');
    console.log('[Main] Saving terminal states...');
    await terminalPanelManager.saveAllTerminalStates();

    const interruptedPanels = new Map<string, string[]>(); // sessionId → panelIds

    // Find all terminal panels running supported CLI agents and mark them as interrupted
    const allTerminalPanelIds = terminalPanelManager.getAllPanelIds();
    for (const panelId of allTerminalPanelIds) {
      const panel = panelManager.getPanel(panelId);
      if (!panel) continue;

      const customState = decodeBoundary(panel.state?.customState ?? {}, boundary.jsonObject);
      const resumeState = decodeBoundary(customState, boundary.object({
        agentType: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor')),
        initialCommand: boundary.optional(boundary.string),
      }));
      const agentType = resumeState.agentType ?? resolveAgentTypeFromCommand(resumeState.initialCommand);

      if (isCliAgentType(agentType)) {
        panel.state.customState = { ...customState, wasInterrupted: true, agentType };
        await panelManager.updatePanel(panelId, { state: panel.state });

        const existing = interruptedPanels.get(panel.sessionId);
        if (existing) {
          existing.push(panelId);
        } else {
          interruptedPanels.set(panel.sessionId, [panelId]);
        }
        logToFile(`Marked terminal panel ${panelId} as interrupted`);
        console.log(`[Main] Marked terminal panel ${panelId} as interrupted (${agentType} CLI)`);
      }
    }

    logToFile(`Found ${interruptedPanels.size} session(s) with interrupted terminals`);

    console.log(`[Main] Graceful shutdown: found ${interruptedPanels.size} session(s) with interrupted terminals`);

    // Phase 3: Mark sessions as interrupted in DB
    for (const [sessionId, panelIds] of interruptedPanels) {
      if (databaseService) {
        databaseService.updateSession(sessionId, { status: 'interrupted' });
        console.log(`[Main] Marked session ${sessionId} as interrupted (${panelIds.length} panel${panelIds.length > 1 ? 's' : ''})`);
      }
    }

    console.log(`[Main] Graceful shutdown: marked ${interruptedPanels.size} session${interruptedPanels.size !== 1 ? 's' : ''} as interrupted`);

    // Kill all terminal panel PTY processes so Claude doesn't survive as an orphan
    logToFile('Destroying all terminal panel processes');
    console.log('[Main] Destroying all terminal panel processes...');
    terminalPanelManager.destroyAllTerminals();
    console.log('[Main] Terminal panel processes destroyed');

    // Phase 4: Host/runtime cleanup
    console.log('[Main] Shutting down daemon host services...');

    if (paneDaemonHost) {
      await paneDaemonHost.shutdown();
      paneDaemonHost = null;
      console.log('[Main] Daemon host services stopped');
    }

    // Track app closed event with session duration.
    // Send directly via HTTP instead of IPC — the renderer may already be
    // tearing down, so an IPC-forwarded event would likely be dropped.
    if (configManager && configManager.isAnalyticsEnabled() && appStartTime) {
      try {
        const settings = configManager.getAnalyticsSettings();
        const apiKey = settings.posthogApiKey || 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1';
        const host = settings.posthogHost || 'https://runpane.com/api/c';
        const distinctId = configManager.getAnalyticsDistinctId() || `anon-${Date.now().toString(36)}`;
        const sessionDurationSeconds = Math.floor((Date.now() - appStartTime) / 1000);

        const { net } = await import('electron');
        await net.fetch(`${host}/capture/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            event: 'app_closed',
            properties: {
              distinct_id: distinctId,
              token: apiKey,
              install_id: settings.installId,
              session_duration_seconds: sessionDurationSeconds,
              app_version: app.getVersion(),
              platform: os.platform(),
              identity_source: settings.identitySource,
              github_username: settings.githubUsername,
              github_email: settings.githubEmail,
              git_email: settings.gitEmail,
              git_email_sha256: settings.gitEmailHash,
              git_user_name: settings.gitUserName,
              $lib: 'posthog-node',
            },
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (error) {
        console.error('[Analytics] Failed to track app_closed event:', error);
      }
    }

    const totalShutdownTime = Date.now() - shutdownStartTime;
    logToFile(`Graceful shutdown complete in ${Date.now() - shutdownStartTime}ms`);
    console.log(`[Main] Graceful shutdown complete in ${totalShutdownTime}ms`);

  } catch (error) {
    logToFile(`ERROR during shutdown: ${error}`);
    console.error('[Main] Error during graceful shutdown:', error);
  } finally {
    clearTimeout(shutdownSafetyTimeout);

    // Remove crash sentinel — this was a clean shutdown
    try {
      const sentinelPath = path.join(getAppDirectory(), '.running');
      if (fs.existsSync(sentinelPath)) {
        fs.unlinkSync(sentinelPath);
      }
    } catch { /* best-effort */ }

    logToFile('Calling app.exit(0)');
    // Exit the app
    app.exit(0);
  }
  });
}

// Export getter function for mainWindow
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
