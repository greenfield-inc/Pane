import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';

export const APP_MENU_ACTION_CHANNEL = 'app:menu-action';
export type AppMenuAction = 'open-about' | 'open-settings';

const DOCS_URL = 'https://runpane.com/docs';
const ISSUES_URL = 'https://github.com/dcouple/Pane/issues';

/**
 * macOS gets a native application menu. Windows and Linux keep no menu bar:
 * the window draws its own title bar there, and Chromium handles the edit keys.
 */
export function installApplicationMenu(options: {
  isPackaged: boolean;
  onAction: (action: AppMenuAction) => void;
}): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const developerItems: MenuItemConstructorOptions[] = options.isPackaged
    ? []
    : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }];

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: () => options.onAction('open-about') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => options.onAction('open-settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...developerItems,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' },
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

/**
 * Right-click on editable fields and selected text opens the native edit menu.
 * Pane's own menus (sidebar rows, file tree) call preventDefault on the DOM
 * event, so Chromium never raises this event for them.
 */
export function attachEditContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const { editFlags, isEditable, misspelledWord, dictionarySuggestions } = params;
    const selection = params.selectionText.trim();
    if (!isEditable && !selection) return;

    const items: MenuItemConstructorOptions[] = [];
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
      const label = selection.length > MAX_LOOK_UP_LABEL ? `${selection.slice(0, MAX_LOOK_UP_LABEL)}…` : selection;
      items.push(
        { label: `Look Up “${label}”`, click: () => contents.showDefinitionForSelection() },
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
    } else {
      items.push({ label: 'Copy', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, enabled: editFlags.canCopy, click: () => contents.copy() });
    }
    // A webview's menu opens over the window that hosts it.
    const window = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents) ?? undefined;
    Menu.buildFromTemplate(items).popup({ window });
  });
}
