import type { ContextMenuEntry } from '../../../../shared/types/contextMenu';
import { boundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import { resolveTerminalPath, type TerminalFilePath } from './resolveTerminalPath';
import { terminalCopyAccelerator, terminalPasteAccelerator } from '../../utils/terminalClipboard';

const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`[\]]+/;

// File path patterns - detect Unix paths, Windows paths, and relative paths with extensions
const FILE_PATH_PATTERNS = [
  /^[.~]?\/[\w\-./]+/, // Unix absolute or relative paths starting with / ./ ~/
  /^[A-Za-z]:[\\/][\w\-.\\/]+/, // Windows absolute paths C:\ or C:/
  /^[\w\-./\\]+\.[a-z]{1,10}(:\d+)?$/i, // Relative paths with extension like foo.ts, foo.ts:42, or dir\foo.ts
];

/** What selected terminal text points at, which decides the extra actions offered for it. */
export interface SelectionTargets {
  /** The first URL in the text, without the words around it. */
  url: string | null;
  /** The text as a file path, when it is one and holds no URL. */
  file: TerminalFilePath | null;
}

export function findSelectionTargets(text: string, workingDirectory: string, homeDirectory?: string): SelectionTargets {
  const trimmed = text.trim();
  const url = trimmed.match(URL_PATTERN)?.[0] ?? null;
  const isFile = url === null && FILE_PATH_PATTERNS.some((pattern) => pattern.test(trimmed));
  return { url, file: isFile ? resolveTerminalPath(trimmed, workingDirectory, homeDirectory) : null };
}

const TERMINAL_CONTEXT_MENU_ACTIONS = [
  'look-up',
  'copy',
  'paste',
  'select-all',
  'add-to-notes',
  'open-in-browser',
  'open-url',
  'show-in-explorer',
] as const;

export type TerminalContextMenuAction = typeof TERMINAL_CONTEXT_MENU_ACTIONS[number];

/** Main's answer to app:show-context-menu: the chosen item, or null when the menu was dismissed. */
export const terminalContextMenuChoiceSchema: BoundarySchema<TerminalContextMenuAction | null> =
  boundary.nullable(boundary.enumeration(...TERMINAL_CONTEXT_MENU_ACTIONS));

export interface TerminalContextMenuContext {
  selection: string;
  targets: SelectionTargets;
  /** Open in Browser and Add to notes need the Pane the terminal belongs to. */
  hasSession: boolean;
  notesEnabled: boolean;
  isRemoteMode: boolean;
  isMac: boolean;
  /** Off macOS, Ctrl+V pastes only while Pane keyboard shortcuts are on. */
  keyboardShortcutsEnabled: boolean;
}

/**
 * The terminal's right-click menu: macOS Look Up for a selection, the
 * clipboard items, then whatever the selection popover would offer for the
 * selected text.
 */
export function terminalContextMenuEntries(context: TerminalContextMenuContext): ContextMenuEntry[] {
  const { selection, targets, hasSession, notesEnabled, isRemoteMode, isMac, keyboardShortcutsEnabled } = context;
  const hasSelection = selection.length > 0;
  const item = (id: TerminalContextMenuAction, label: string, enabled = true): ContextMenuEntry =>
    ({ type: 'item', id, label, enabled });

  const extras: ContextMenuEntry[] = [];
  if (hasSelection && notesEnabled && hasSession) extras.push(item('add-to-notes', 'Add to notes'));
  if (targets.url && hasSession) extras.push(item('open-in-browser', 'Open in Browser'));
  if (targets.url) extras.push(item('open-url', 'Open URL'));
  if (targets.file) {
    extras.push(isRemoteMode
      ? item('show-in-explorer', 'Show in Explorer (local only)', false)
      : item('show-in-explorer', 'Show in Explorer', targets.file.absolutePath !== null));
  }

  const lookUpText = isMac ? selection.trim() : '';
  const entries: ContextMenuEntry[] = [
    ...(lookUpText ? [{ type: 'look-up', id: 'look-up', text: lookUpText } as const, { type: 'separator' } as const] : []),
    { type: 'item', id: 'copy', label: 'Copy', enabled: hasSelection, accelerator: terminalCopyAccelerator(isMac) },
    { type: 'paste', id: 'paste', label: 'Paste', enabled: true, accelerator: terminalPasteAccelerator(isMac, keyboardShortcutsEnabled) },
    { type: 'separator' },
    item('select-all', 'Select All'),
  ];
  if (extras.length > 0) entries.push({ type: 'separator' }, ...extras);
  return entries;
}
