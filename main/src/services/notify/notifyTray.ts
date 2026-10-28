import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import path from 'path';
import type { NotifyItem, NotifySettings } from '../../../../shared/types/notify';

const TRAY_ASSETS = path.join(__dirname, '../../../assets/tray');
/** The menu lists this many waiting questions; the round holds the rest. */
const MENU_QUESTION_LIMIT = 8;

export interface NotifyTrayState {
  settings: NotifySettings;
  waiting: NotifyItem[];
  paused: boolean;
}

export interface NotifyTrayActions {
  openRound: (itemId?: string) => void;
  setShowOutsidePane: (show: boolean) => void;
  pause: () => void;
  resume: () => void;
  openInbox: () => void;
  openSettings: () => void;
}

/**
 * Pane's menu-bar (macOS) or system-tray icon. It carries an amber dot while any question
 * waits, and its menu holds the quick toggles. It exists only while Notify is on.
 */
export class NotifyTray {
  private tray: Tray | null = null;
  private dotted: boolean | null = null;

  constructor(private readonly actions: NotifyTrayActions) {}

  update(state: NotifyTrayState): void {
    if (!state.settings.enabled) {
      this.destroy();
      return;
    }
    if (!this.tray) {
      this.tray = new Tray(image(false));
      this.dotted = false;
      this.tray.setToolTip('Pane Notify');
    }
    const dotted = state.waiting.length > 0;
    if (dotted !== this.dotted) {
      this.tray.setImage(image(dotted));
      this.dotted = dotted;
    }
    this.tray.setContextMenu(Menu.buildFromTemplate(this.menu(state)));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    this.dotted = null;
  }

  private menu({ settings, waiting, paused }: NotifyTrayState): MenuItemConstructorOptions[] {
    const count = waiting.length;
    const questions: MenuItemConstructorOptions[] = waiting.slice(0, MENU_QUESTION_LIMIT).map(item => ({
      label: `${truncate(item.title, 48)} · ${item.source.name}`,
      click: () => this.actions.openRound(item.id),
    }));
    return [
      { label: 'Pane Notify', enabled: false },
      count > 0
        ? { label: `${count} ${count === 1 ? 'question' : 'questions'} waiting`, accelerator: settings.shortcut, registerAccelerator: false, click: () => this.actions.openRound() }
        : { label: 'Nothing waiting', enabled: false },
      ...questions,
      { type: 'separator' },
      { label: 'Show outside Pane', type: 'checkbox', checked: settings.showOutsidePane, click: (menuItem) => this.actions.setShowOutsidePane(menuItem.checked) },
      paused
        ? { label: 'Resume notifications', click: () => this.actions.resume() }
        : { label: 'Pause for 1 hour', click: () => this.actions.pause() },
      { label: 'Open Notify inbox', click: () => this.actions.openInbox() },
      { type: 'separator' },
      { label: 'Notify settings…', click: () => this.actions.openSettings() },
    ];
  }
}

function image(dotted: boolean): Electron.NativeImage {
  // tray@2x.png sits beside tray.png, so Electron picks the sharp one on high-DPI screens.
  return nativeImage.createFromPath(path.join(TRAY_ASSETS, dotted ? 'tray-dot.png' : 'tray.png'));
}

function truncate(text: string, length: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}
