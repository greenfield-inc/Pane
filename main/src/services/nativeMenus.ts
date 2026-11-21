import { app, BrowserWindow, clipboard, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { syntheticInputInFlight } from './browser/pageDriver';
import { externalUrlOrNull } from '../utils/externalUrl';
import { openExternalUrl } from '../utils/openExternalUrl';
import type { ContextMenuEntry } from '../../../shared/types/contextMenu';

export const APP_MENU_ACTION_CHANNEL = 'app:menu-action';
export type AppMenuAction = 'open-about' | 'open-settings';

/** View › Actual Size. Kept off every default in the shortcut catalog (keyboardShortcutCatalog.test.ts). */
export const RESET_ZOOM_ACCELERATOR = 'CmdOrCtrl+Shift+0';

const DOCS_URL = 'https://runpane.com/docs';
const ISSUES_URL = 'https://github.com/dcouple/Pane/issues';

/**
 * macOS gets a native application menu. Windows and Linux keep no menu bar:
 * the window draws its own title bar there, and Chromium handles the edit keys.
 */
export function installApplicationMenu(options: {
  isPackaged: boolean;
  onAction: (action: AppMenuAction) => void;
  /** Keys Pane's commands own now; a menu item with the same key shows it but stops answering it. */
  paneChords?: ReadonlySet<string>;
  /** Settings…'s key: Open Settings' binding, or null when it has none. */
  settingsAccelerator?: string | null;
  /** View › Reset Custom Theme: the one way back in the app that custom CSS can't hide. Enabled while a Custom theme file exists. */
  resetCustomTheme?: { enabled: boolean; onClick: () => void };
}): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const paneChords = options.paneChords ?? new Set<string>();
  // An item whose key a Pane command now owns keeps showing it but lets the
  // window have it, so a remap never also triggers the menu. registerAccelerator
  // covers Windows and Linux; on macOS main takes the key in before-input-event
  // (menuKeyTakenFromWindow, whose chord list matches this menu's).
  const keyed = (item: MenuItemConstructorOptions, chord: string, accelerator: string): MenuItemConstructorOptions => ({
    ...item,
    accelerator,
    registerAccelerator: !paneChords.has(chord),
  });
  const developerItems: MenuItemConstructorOptions[] = options.isPackaged
    ? []
    : [
      keyed({ role: 'reload' }, 'mod+r', 'CmdOrCtrl+R'),
      keyed({ role: 'forceReload' }, 'mod+shift+r', 'CmdOrCtrl+Shift+R'),
      keyed({ role: 'toggleDevTools' }, 'mod+alt+i', 'Alt+CmdOrCtrl+I'),
      { type: 'separator' },
    ];

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: () => options.onAction('open-about') },
        { type: 'separator' },
        // Pane opens Settings with its own key; the menu shows it without answering it.
        { label: 'Settings…', accelerator: options.settingsAccelerator ?? undefined, registerAccelerator: false, click: () => options.onAction('open-settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        keyed({ role: 'hide' }, 'mod+h', 'Command+H'),
        keyed({ role: 'hideOthers' }, 'mod+alt+h', 'Command+Alt+H'),
        { role: 'unhide' },
        { type: 'separator' },
        keyed({ role: 'quit' }, 'mod+q', 'CmdOrCtrl+Q'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        keyed({ role: 'undo' }, 'mod+z', 'CmdOrCtrl+Z'),
        keyed({ role: 'redo' }, 'mod+shift+z', 'Shift+CmdOrCtrl+Z'),
        { type: 'separator' },
        keyed({ role: 'cut' }, 'mod+x', 'CmdOrCtrl+X'),
        keyed({ role: 'copy' }, 'mod+c', 'CmdOrCtrl+C'),
        keyed({ role: 'paste' }, 'mod+v', 'CmdOrCtrl+V'),
        keyed({ role: 'pasteAndMatchStyle' }, 'mod+alt+shift+v', 'Shift+Alt+CmdOrCtrl+V'),
        { role: 'delete' },
        keyed({ role: 'selectAll' }, 'mod+a', 'CmdOrCtrl+A'),
      ],
    },
    {
      label: 'View',
      submenu: [
        ...developerItems,
        // ⌘0 is Focus Sidebar in Pane's VS Code keymap (D-236), so Actual Size moves to ⌘⇧0.
        keyed({ role: 'resetZoom' }, 'mod+shift+0', RESET_ZOOM_ACCELERATOR),
        keyed({ role: 'zoomIn' }, 'mod+=', 'CmdOrCtrl+Plus'),
        keyed({ role: 'zoomOut' }, 'mod+-', 'CmdOrCtrl+-'),
        { type: 'separator' },
        keyed({ role: 'togglefullscreen' }, 'mod+ctrl+f', 'Ctrl+Command+F'),
        ...(options.resetCustomTheme ? [
          { type: 'separator' } as const,
          { label: 'Reset Custom Theme', enabled: options.resetCustomTheme.enabled, click: options.resetCustomTheme.onClick },
        ] : []),
      ],
    },
    {
      role: 'window',
      submenu: [
        // ⌘M is the second step of ⌘K ⌘M too; the hotkey store takes it then.
        keyed({ role: 'minimize' }, 'mod+m', 'CmdOrCtrl+M'),
        { role: 'zoom' },
        { type: 'separator' },
        // Main never lets ⌘W close the window while Pane's keys are on (isWindowCloseInput).
        keyed({ role: 'close' }, 'mod+w', 'CmdOrCtrl+W'),
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Pane Documentation', click: () => void shell.openExternal(DOCS_URL) },
        { label: 'Report an Issue', click: () => void shell.openExternal(ISSUES_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const MAX_LOOK_UP_LABEL = 24;

/** macOS's dictionary item, named after the selection it looks up. */
function lookUpLabel(selection: string): string {
  const shown = selection.length > MAX_LOOK_UP_LABEL ? `${selection.slice(0, MAX_LOOK_UP_LABEL)}…` : selection;
  return `Look Up “${shown}”`;
}
// The close callback is not ordered against the chosen item's click on every
// platform, so a dismissal is only reported after the click has had its turn.
const CONTEXT_MENU_DISMISS_GRACE_MS = 100;

/**
 * Right-click on editable fields, selected text and links opens the native edit menu;
 * a link gets Open in System Browser and Copy Link. `leading` adds items that open the menu
 * anywhere on the page (a browser tab's View live).
 * Pane's own menus (sidebar rows, file tree, terminals through
 * showContextMenu) call preventDefault on the DOM event, so Chromium never
 * raises this event for them.
 */
export function attachEditContextMenu(contents: WebContents, leading: () => MenuItemConstructorOptions[] = () => []): void {
  contents.on('context-menu', (_event, params) => {
    // A right click an agent or another screen sent never opens a menu on this computer's screen.
    if (syntheticInputInFlight(contents.id)) return;
    const { editFlags, isEditable, misspelledWord, dictionarySuggestions } = params;
    const selection = params.selectionText.trim();
    const link = externalUrlOrNull(params.linkURL);
    const first = leading();
    if (!isEditable && !selection && !link && first.length === 0) return;

    const items: MenuItemConstructorOptions[] = [...first];
    if (first.length > 0 && (isEditable || selection || link)) items.push({ type: 'separator' });
    // A link in a browser tab, a chat message or a card can always go to the system browser.
    if (link) {
      items.push(
        { label: 'Open in System Browser', click: () => void openExternalUrl(link).catch(error => console.error('[menu] Did not open the link in the system browser:', error)) },
        { label: 'Copy Link', click: () => clipboard.writeText(link) },
      );
      if (isEditable || selection) items.push({ type: 'separator' });
    }
    if (isEditable && misspelledWord) {
      items.push(...(dictionarySuggestions.length > 0
        ? dictionarySuggestions.map((word): MenuItemConstructorOptions => ({
          label: word,
          click: () => contents.replaceMisspelling(word),
        }))
        : [{ label: 'No Guesses Found', enabled: false }]));
      items.push(
        { label: 'Learn Spelling', click: () => contents.session.addWordToSpellCheckerDictionary(misspelledWord) },
        { type: 'separator' },
      );
    }
    if (selection && process.platform === 'darwin') {
      items.push(
        { label: lookUpLabel(selection), click: () => contents.showDefinitionForSelection() },
        { type: 'separator' },
      );
    }
    if (isEditable) {
      items.push(
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', registerAccelerator: false, enabled: editFlags.canCut, click: () => contents.cut() },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, enabled: editFlags.canCopy, click: () => contents.copy() },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', registerAccelerator: false, enabled: editFlags.canPaste, click: () => contents.paste() },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', registerAccelerator: false, enabled: editFlags.canSelectAll, click: () => contents.selectAll() },
      );
    } else if (selection) {
      items.push({ label: 'Copy', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, enabled: editFlags.canCopy, click: () => contents.copy() });
    }
    // A webview's menu opens over the window that hosts it.
    const window = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents) ?? undefined;
    Menu.buildFromTemplate(items).popup({ window });
  });
}

/**
 * Shows a renderer-described menu natively and resolves with the chosen item's
 * id, or null when it is dismissed. The renderer must have prevented the DOM
 * contextmenu event, or Chromium raises attachEditContextMenu's menu as well.
 *
 * Use it where a surface replaces the native edit menu or needs a native
 * action (paste, look up): today, the terminal's right-click menu. Pane's own
 * row and toolbar menus stay HTML (ui/Dropdown, ContextMenuContext).
 */
export function showContextMenu(contents: WebContents, entries: ContextMenuEntry[]): Promise<string | null> {
  return new Promise((resolve) => {
    const template = entries.map((entry): MenuItemConstructorOptions => {
      if (entry.type === 'separator') return { type: 'separator' };
      if (entry.type === 'look-up') {
        return {
          label: lookUpLabel(entry.text),
          click: () => {
            contents.showDefinitionForSelection();
            resolve(entry.id);
          },
        };
      }
      return {
        label: entry.label,
        enabled: entry.enabled,
        accelerator: entry.accelerator,
        registerAccelerator: false,
        click: () => {
          if (entry.type === 'paste') contents.paste();
          resolve(entry.id);
        },
      };
    });
    const window = BrowserWindow.fromWebContents(contents) ?? undefined;
    Menu.buildFromTemplate(template).popup({
      window,
      callback: () => setTimeout(() => resolve(null), CONTEXT_MENU_DISMISS_GRACE_MS),
    });
  });
}
