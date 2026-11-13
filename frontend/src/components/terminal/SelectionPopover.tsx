import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Terminal } from '@xterm/xterm';
import { Copy, ExternalLink, FolderOpen, Globe, FileText, X } from 'lucide-react';
import { TerminalPopover, PopoverButton } from './TerminalPopover';
import { InterceptorToast } from './InterceptorToast';
import NotesDialog from '../panels/notes/NotesDialog';
import type { TerminalFilePath } from './resolveTerminalPath';
import {
  findSelectionTargets,
  terminalContextMenuChoiceSchema,
  terminalContextMenuEntries,
  type SelectionTargets,
  type TerminalContextMenuAction,
} from './terminalSelectionActions';
import { copyTerminalText } from '../../utils/terminalClipboard';
import { isMac } from '../../utils/platformUtils';
import { areKeyboardShortcutsEnabled, isCopyOnSelectEnabled, isNotesEnabled, useConfigStore } from '../../stores/configStore';
import { useCommittedRef } from '../../hooks/useCommittedRef';
import { decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

const NotesPanel = lazy(() => import('../panels/notes/NotesPanel'));

export interface SelectionPopoverProps {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  /** Right-clicking this terminal shows the same actions in a native menu. */
  terminal?: Terminal | null;
  workingDirectory?: string;
  panelTitle?: string;
  homeDirectory?: string;
  sessionId?: string;
  isRemoteMode?: boolean;
  onOpenInBrowser: (url: string) => void | Promise<void>;
  onClose: () => void;
}

const NO_TARGETS: SelectionTargets = { url: null, file: null };

/**
 * What Pane offers for selected terminal text, in two places: the popover
 * that follows a selection, and the native right-click menu, which adds Copy,
 * Paste and Select All.
 */
export const SelectionPopover: React.FC<SelectionPopoverProps> = ({
  visible,
  x,
  y,
  text,
  terminal,
  workingDirectory,
  panelTitle,
  homeDirectory,
  sessionId,
  isRemoteMode = false,
  onOpenInBrowser,
  onClose,
}) => {
  const [capture, setCapture] = useState<{ text: string; source: string; at: string }>();
  const notesEnabled = useConfigStore(state => isNotesEnabled(state.config));
  const copyOnSelect = useConfigStore(state => isCopyOnSelectEnabled(state.config));
  const keyboardShortcutsEnabled = useConfigStore(state => areKeyboardShortcutsEnabled(state.config));
  // Stays mounted while hidden so the error toast can outlive the popover
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // Skip computation when not visible
  const { url, file: filePath } = visible ? findSelectionTargets(text, workingDirectory ?? '', homeDirectory) : NO_TARGETS;
  const isUrl = url !== null;
  const isFile = filePath !== null;

  const copy = async (value: string): Promise<boolean> => {
    try {
      await copyTerminalText(value);
      return true;
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      setErrorToast('Failed to copy terminal text');
      return false;
    }
  };

  const openInBrowser = async (target: string) => {
    try {
      await onOpenInBrowser(target);
    } catch (error) {
      console.error('Failed to open URL in browser panel:', error);
    }
  };

  const showInExplorer = async (target: TerminalFilePath) => {
    if (isRemoteMode) {
      console.warn('Show in Explorer is only available in local mode.');
      return;
    }
    if (!target.absolutePath) return;
    try {
      const result: { success: boolean; error?: string } = await window.electronAPI.invoke(
        'app:showItemInFolder',
        target.absolutePath,
        sessionId
      );
      if (!result?.success) {
        setErrorToast(result?.error || 'Failed to show in file manager');
      }
    } catch (error) {
      console.error('Failed to show in explorer:', error);
      setErrorToast('Failed to show in file manager');
    }
  };

  const addToNotes = (value: string) => {
    setCapture({ text: value, source: [panelTitle, workingDirectory, sessionId].filter(Boolean).join(' · '), at: new Date().toISOString() });
  };

  const handleCopy = async () => {
    if (await copy(text)) onClose();
  };

  const handleOpenUrl = () => {
    if (url) {
      window.electronAPI.openExternal(url);
      onClose();
    }
  };

  const handleOpenInBrowser = async () => {
    if (url && sessionId) {
      await openInBrowser(url);
      onClose();
    }
  };

  const handleShowInExplorer = async () => {
    if (!filePath || (!isRemoteMode && !filePath.absolutePath)) return;
    await showInExplorer(filePath);
    onClose();
  };

  const runMenuAction = async (action: TerminalContextMenuAction, selection: string, targets: SelectionTargets) => {
    switch (action) {
      case 'copy':
        await copy(selection);
        return;
      case 'paste':
      case 'look-up':
        // Main performed these natively, on the terminal it focused.
        return;
      case 'select-all':
        if (!terminal) return;
        terminal.selectAll();
        // A selection copies itself when Copy on select is on, however it was made.
        if (copyOnSelect) await copy(terminal.getSelection());
        return;
      case 'add-to-notes':
        addToNotes(selection);
        return;
      case 'open-in-browser':
        if (targets.url) await openInBrowser(targets.url);
        return;
      case 'open-url':
        if (targets.url) window.electronAPI.openExternal(targets.url);
        return;
      case 'show-in-explorer':
        if (targets.file) await showInExplorer(targets.file);
        return;
    }
  };

  const menuContextRef = useCommittedRef({ workingDirectory, homeDirectory, sessionId, isRemoteMode, notesEnabled, keyboardShortcutsEnabled, onClose, runMenuAction });
  useEffect(() => {
    const element = terminal?.element;
    if (!terminal || !element) return;
    // xterm's own contextmenu handler on this element was registered first, so
    // it has run by now: it may have selected the word under the pointer
    // (macOS) and put the selection in its focused textarea, which Look Up
    // reads. Preventing the event keeps Chromium from raising the generic edit
    // menu as well.
    const showMenu = (event: MouseEvent) => {
      event.preventDefault();
      const context = menuContextRef.current;
      context.onClose();
      const selection = terminal.hasSelection() ? terminal.getSelection() : '';
      const targets = findSelectionTargets(selection, context.workingDirectory ?? '', context.homeDirectory);
      const entries = terminalContextMenuEntries({
        selection,
        targets,
        hasSession: Boolean(context.sessionId),
        notesEnabled: context.notesEnabled,
        isRemoteMode: context.isRemoteMode,
        isMac: isMac(),
        keyboardShortcutsEnabled: context.keyboardShortcutsEnabled,
      });
      // Paste lands in the focused element, so the terminal must hold focus.
      terminal.focus();
      void window.electronAPI.invoke('app:show-context-menu', entries)
        .then((choice) => {
          const action = decodeBoundary(choice, terminalContextMenuChoiceSchema);
          return action ? menuContextRef.current.runMenuAction(action, selection, targets) : undefined;
        })
        .catch((error) => console.error('Failed to show the terminal context menu:', error));
    };
    element.addEventListener('contextmenu', showMenu);
    return () => element.removeEventListener('contextmenu', showMenu);
  }, [terminal, menuContextRef]);

  return (
    <>
    <TerminalPopover visible={visible} x={x} y={y} onClose={onClose}>
      <PopoverButton onClick={handleCopy}>
        <span className="flex items-center gap-2">
          <Copy className="w-4 h-4" />
          Copy
        </span>
      </PopoverButton>
      {notesEnabled && sessionId && <PopoverButton onClick={() => {
        addToNotes(text);
        onClose();
      }}><span className="flex items-center gap-2"><FileText className="h-4 w-4" />Add to notes</span></PopoverButton>}
      {isUrl && sessionId && (
        <PopoverButton onClick={handleOpenInBrowser}>
          <span className="flex items-center gap-2">
            <Globe className="w-4 h-4" />
            Open in Browser
          </span>
        </PopoverButton>
      )}
      {isUrl && (
        <PopoverButton onClick={handleOpenUrl}>
          <span className="flex items-center gap-2">
            <ExternalLink className="w-4 h-4" />
            Open URL
          </span>
        </PopoverButton>
      )}
      {isFile && (
        <PopoverButton
          onClick={handleShowInExplorer}
          disabled={isRemoteMode || !filePath?.absolutePath}
          title={isRemoteMode ? 'Only available in local mode' : !filePath?.absolutePath ? 'Home directory unavailable' : undefined}
        >
          <span className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Show in Explorer{isRemoteMode ? ' (local only)' : ''}
          </span>
        </PopoverButton>
      )}
    </TerminalPopover>
    {notesEnabled && capture && sessionId && <NotesDialog label="Add to notes" onDismiss={() => setCapture(undefined)} className="max-h-[calc(100vh-2rem)] max-w-3xl">
      <div className="flex h-[50px] shrink-0 items-center justify-between border-b border-border-primary px-5">
        <h2 className="text-[15px] font-semibold text-text-primary">Add to notes</h2>
        <button type="button" aria-label="Close" title="Close" className="rounded-md p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus" onClick={() => setCapture(undefined)}><X className="h-4 w-4" /></button>
      </div>
      <div className="min-h-0 flex-1"><Suspense fallback={<p className="p-5 text-[13px] text-text-tertiary">Loading notes…</p>}><NotesPanel paneId={sessionId} capture={capture} viewId="capture" /></Suspense></div>
    </NotesDialog>}
    {errorToast && createPortal(
      <div className="fixed inset-0 z-[10002] pointer-events-none">
        <InterceptorToast
          visible={!!errorToast}
          message={errorToast}
          onHide={() => setErrorToast(null)}
        />
      </div>,
      document.body
    )}
    </>
  );
};
