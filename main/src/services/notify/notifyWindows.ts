import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import path from 'path';
import type { NotifyPosition, NotifyWindowSize } from '../../../../shared/types/notify';

type NotifyView = 'strip' | 'round';

/** Gap between the strip and the edge of the screen's work area (above the Dock or taskbar). */
const EDGE_GAP = 8;
const INITIAL_SIZE = {
  strip: { width: 680, height: 220 },
  round: { width: 720, height: 420 },
} satisfies Record<NotifyView, NotifyWindowSize>;

/**
 * Native Wayland can't place a window, keep it on top, or show it without focus, so strips only
 * show inside Pane there. Electron uses Wayland natively since v38 when the session offers it.
 */
export function canFloatOverOtherApps(): boolean {
  if (process.platform !== 'linux') return true;
  return !(process.env.XDG_SESSION_TYPE === 'wayland' && process.env.WAYLAND_DISPLAY && !process.argv.includes('--ozone-platform=x11'));
}

/**
 * The two floating windows: the strip, which appears over any app without taking focus, and the
 * round, a centered panel that takes the keyboard. Both render frontend/notify.html.
 */
export class NotifyWindows {
  private strip: BrowserWindow | null = null;
  private round: BrowserWindow | null = null;
  private stripSize: NotifyWindowSize = INITIAL_SIZE.strip;
  private roundSize: NotifyWindowSize = INITIAL_SIZE.round;
  /** The work area the strip was placed on; it stays there until it hides. */
  private stripArea: Rectangle | null = null;

  constructor(private readonly options: {
    rendererArguments: () => string[];
    position: () => NotifyPosition;
    onRoundClosed: () => void;
  }) {}

  showStrip(): void {
    const window = this.strip ?? this.createStrip();
    if (!this.stripArea) this.stripArea = displayUnderPointer();
    this.placeStrip(window);
    if (!window.isVisible()) window.showInactive();
  }

  hideStrip(): void {
    this.stripArea = null;
    if (!this.strip || this.strip.isDestroyed() || !this.strip.isVisible()) return;
    this.strip.hide();
    // A strip that took focus for a field gives it back when it hides.
    if (process.platform !== 'linux') this.strip.setFocusable(false);
  }

  /** The person clicked into the strip's text or note field. */
  focusStrip(): void {
    const window = this.strip;
    if (!window || window.isDestroyed()) return;
    if (process.platform !== 'linux') window.setFocusable(true);
    window.focus();
  }

  openRound(itemId?: string): void {
    const existing = this.round;
    // The round starts on the question it was opened for, so a reopen for another one reloads it.
    if (existing && itemId) this.load(existing, 'round', itemId);
    const window = existing ?? this.createRound(itemId);
    this.placeRound(window);
    window.show();
    window.focus();
  }

  closeRound(): void {
    if (!this.round || this.round.isDestroyed() || !this.round.isVisible()) return;
    this.round.hide();
    // A macOS panel window doesn't emit 'hide', so the strip would stay away until the next change.
    this.options.onRoundClosed();
  }

  isRoundOpen(): boolean {
    return Boolean(this.round && !this.round.isDestroyed() && this.round.isVisible());
  }

  resize(sender: Electron.WebContents, size: NotifyWindowSize): void {
    const rounded = { width: Math.ceil(size.width), height: Math.ceil(size.height) };
    if (this.strip && sender === this.strip.webContents) {
      this.stripSize = rounded;
      if (this.strip.isVisible()) this.placeStrip(this.strip);
    } else if (this.round && sender === this.round.webContents) {
      this.roundSize = rounded;
      this.placeRound(this.round);
    }
  }

  isNotifyWindow(sender: Electron.WebContents): boolean {
    return sender === this.strip?.webContents || sender === this.round?.webContents;
  }

  webContents(): Electron.WebContents[] {
    return [this.strip, this.round].flatMap(window => (window && !window.isDestroyed() ? [window.webContents] : []));
  }

  destroy(): void {
    for (const window of [this.strip, this.round]) if (window && !window.isDestroyed()) window.destroy();
    this.strip = null;
    this.round = null;
  }

  private createStrip(): BrowserWindow {
    const window = new BrowserWindow({
      ...this.baseOptions(INITIAL_SIZE.strip),
      // Linux can't switch focusability at runtime, so it shows inactive and stays focusable.
      focusable: process.platform === 'linux',
    });
    // Over every Space, full-screen ones included (D-1: no automatic hiding in v1).
    window.setAlwaysOnTop(true, 'pop-up-menu');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.on('blur', () => {
      if (process.platform !== 'linux' && !window.isDestroyed()) window.setFocusable(false);
    });
    window.on('closed', () => { this.strip = null; });
    this.load(window, 'strip');
    this.strip = window;
    return window;
  }

  private createRound(itemId?: string): BrowserWindow {
    const window = new BrowserWindow({ ...this.baseOptions(INITIAL_SIZE.round), focusable: true });
    window.setAlwaysOnTop(true, 'pop-up-menu');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // Like Spotlight: clicking elsewhere ends the round; the questions keep waiting.
    window.on('blur', () => this.closeRound());
    window.on('hide', () => this.options.onRoundClosed());
    window.on('closed', () => { this.round = null; this.options.onRoundClosed(); });
    this.load(window, 'round', itemId);
    this.round = window;
    return window;
  }

  private baseOptions(size: NotifyWindowSize): BrowserWindowConstructorOptions {
    const options: BrowserWindowConstructorOptions = {
      ...size,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, '../../preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: this.options.rendererArguments(),
      },
    };
    // macOS: a non-activating panel shows over other apps and can take a field's keys without activating Pane.
    if (process.platform === 'darwin') options.type = 'panel';
    if (process.platform === 'linux') options.type = 'notification';
    return options;
  }

  private load(window: BrowserWindow, view: NotifyView, itemId?: string): void {
    const query = new URLSearchParams({ view });
    if (itemId) query.set('id', itemId);
    const loaded = app.isPackaged || process.env.NODE_ENV === 'production'
      ? window.loadFile(path.join(app.getAppPath(), 'frontend/dist/notify.html'), { search: query.toString() })
      : window.loadURL(`http://localhost:${process.env.VITE_PORT || process.env.PORT || '4521'}/notify.html?${query}`);
    loaded.catch(error => console.error(`[Notify] Could not load the ${view} window:`, error));
  }

  private placeStrip(window: BrowserWindow): void {
    const area = this.stripArea ?? displayUnderPointer();
    const { width, height } = this.stripSize;
    const position = this.options.position();
    const x = position === 'bottom-center'
      ? area.x + Math.round((area.width - width) / 2)
      : area.x + area.width - width - EDGE_GAP;
    const y = position === 'top-right' ? area.y + EDGE_GAP : area.y + area.height - height - EDGE_GAP;
    window.setBounds({ x, y, width, height });
  }

  private placeRound(window: BrowserWindow): void {
    const area = displayUnderPointer();
    const { width, height } = this.roundSize;
    // A little above center, where Spotlight and Raycast sit.
    window.setBounds({
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 3),
      width,
      height,
    });
  }
}

function displayUnderPointer(): Rectangle {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
}
