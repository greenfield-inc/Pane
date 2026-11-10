import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';

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
}): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const paneChords = options.paneChords ?? new Set<string>();
  // An item whose key a Pane command now owns keeps showing it but lets the
  // window have it, so a remap never also triggers the menu.
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
