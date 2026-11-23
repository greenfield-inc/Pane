import { decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';
import { terminalPathContextSchema, type TerminalPathContext } from '../../../../../shared/types/terminalPaths';
import type { TerminalFilePath } from '../resolveTerminalPath';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { LinkProviderConfig } from '../linkProviders/types';
import { registerAllLinkProviders } from '../linkProviders';
import { openInPaneTab, openLink, opensLink, swapsDestination } from '../../../utils/openLink';
import { hoverLink, hoveredLink, leaveLink, showLinkPopover } from '../../links/linkPopoverState';
import { openFileInEditor } from '../../../services/openFileInEditor';
import { isCopyOnSelectEnabled, useConfigStore } from '../../../stores/configStore';
import { isMac } from '../../../utils/platformUtils';
import { copyTerminalText } from '../../../utils/terminalClipboard';
import { useCommittedRef } from '../../../hooks/useCommittedRef';

export interface UseTerminalLinksConfig {
  workingDirectory: string;
  sessionId: string;
  onCopyError: () => void;
  /** While true, selection changes (find selecting a match) show no copy popover. */
  suppressSelectionPopover?: () => boolean;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  hint: string;
}

interface FilePopoverState extends TerminalFilePath {
  visible: boolean;
  x: number;
  y: number;
  line: number;
}

interface SelectionPopoverState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
}

/**
 * A click on a web link in a terminal opens it (Cmd/Ctrl-click in the other place). xterm activates
 * a link on the mouseup of any button, so a right-click, which shows the link popover, opens nothing.
 */
export function openTerminalLink(url: string, paneId: string, event: MouseEvent): Promise<void> {
  if (!opensLink(event)) return Promise.resolve();
  return openLink(url, paneId, { swap: swapsDestination(event) });
}

/** The pointer rests on a web link in a terminal: the link popover shows just below the pointer. */
export function hoverTerminalLink(url: string, paneId: string, event: MouseEvent): void {
  hoverLink({ url, paneId, x: event.clientX, y: event.clientY + 12, flipY: event.clientY - 12 });
}

export function useTerminalLinks(terminal: Terminal | null, config: UseTerminalLinksConfig) {
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    text: '',
    hint: '',
  });

  const [filePopover, setFilePopover] = useState<FilePopoverState>({
    visible: false,
    x: 0,
    y: 0,
    absolutePath: null,
    relativePath: null,
    line: 0,
  });

  const [selectionPopover, setSelectionPopover] = useState<SelectionPopoverState>({
    visible: false,
    x: 0,
    y: 0,
    text: '',
  });

  const [githubRemoteUrl, setGithubRemoteUrl] = useState<string | null>(null);
  const isRemoteMode = useConfigStore((state) => state.config?.remoteDaemon?.client.mode === 'remote');
  const copyOnSelect = useConfigStore((state) => isCopyOnSelectEnabled(state.config));
  const customLinks = useConfigStore((state) => state.config?.customLinks);
  const { onCopyError } = config;
  const suppressSelectionPopoverRef = useCommittedRef(config.suppressSelectionPopover);
  const mousePositionRef = useRef({ x: 0, y: 0 });

  const [pathContext, setPathContext] = useState<TerminalPathContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPathContext(null);
    window.electronAPI.invoke('terminal:getPathContext', config.sessionId)
      .then((value) => {
        const context = decodeBoundary(value, terminalPathContextSchema);
        if (!cancelled) setPathContext(context);
      })
      .catch(error => console.error('Failed to load terminal path context:', error));
    return () => { cancelled = true; };
  }, [config.sessionId]);

  // Track mouse position for selection popover
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    mousePositionRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Fetch GitHub remote URL on mount
  useEffect(() => {
    window.electronAPI
      .invoke('git:get-github-remote', config.sessionId)
      .then((result: { success: boolean; data?: string | null }) => {
        if (result.success) {
          setGithubRemoteUrl(result.data ?? null);
        }
      })
      .catch((error) => {
        console.error('Failed to fetch GitHub remote:', error);
      });
  }, [config.sessionId]);

  // Register link providers when terminal is ready
  useEffect(() => {
    if (!terminal) return;

    const providerConfig: LinkProviderConfig = {
      terminal,
      customLinks,
      workingDirectory: pathContext?.workingDirectory ?? config.workingDirectory,
      homeDirectory: pathContext?.homeDirectory ?? undefined,
      githubRemoteUrl: githubRemoteUrl ?? undefined,
      onShowTooltip: (event, text, hint) => {
        setTooltip({ visible: true, x: event.clientX, y: event.clientY, text, hint });
      },
      onHideTooltip: () => {
        setTooltip((prev) => ({ ...prev, visible: false }));
      },
      onShowFilePopover: (event, path, line) => {
        setFilePopover({ visible: true, x: event.clientX, y: event.clientY, ...path, line: line ?? 0 });
      },
      onOpenUrl: (url, event) => {
        void openTerminalLink(url, config.sessionId, event);
      },
      onHoverUrl: (url, event) => hoverTerminalLink(url, config.sessionId, event),
      onLeaveUrl: leaveLink,
    };

    const disposables = registerAllLinkProviders(providerConfig);

    return () => {
      disposables.forEach((d) => d.dispose());
    };
  }, [terminal, config.workingDirectory, config.sessionId, customLinks, githubRemoteUrl, pathContext]);

  // Right-clicking a web link shows the link popover instead of the terminal's menu, unless text is
  // selected: then the menu's Copy and Paste stay, and it offers the URL's actions itself. This runs
  // before xterm's and SelectionPopover's handlers on the same element, so neither sees the click.
  useEffect(() => {
    const element = terminal?.element;
    if (!element) return;
    const onContextMenu = (event: MouseEvent) => {
      const link = hoveredLink();
      if (!link || terminal.hasSelection()) return;
      event.preventDefault();
      event.stopPropagation();
      showLinkPopover({ ...link, x: event.clientX, y: event.clientY });
    };
    element.addEventListener('contextmenu', onContextMenu, { capture: true });
    return () => element.removeEventListener('contextmenu', onContextMenu, { capture: true });
  }, [terminal]);

  // Listen for selection changes
  useEffect(() => {
    if (!terminal) return;

    // Copy on select (Settings › Terminal) copies a finished mouse selection instead of offering
    // the selection popover. Remote mode always does, so it lands on this machine's clipboard.
    if (copyOnSelect) {
      const element = terminal.element;
      if (!element) return;
      const doc = element.ownerDocument;
      const copySelection = () => {
        if (!terminal.hasSelection()) return;
        void copyTerminalText(terminal.getSelection()).catch(onCopyError);
      };
      // A drag can end outside the terminal (auto-scroll, overshoot), so the
      // release is caught on the document, as xterm does to finish the selection.
      // Left button only, and not macOS Ctrl+click (a right-click that reports
      // button 0): a right-click selects the word under the pointer on macOS,
      // and copying it would overwrite what the menu's Paste pastes.
      const watchRelease = (event: MouseEvent) => {
        if (event.button !== 0 || (event.ctrlKey && isMac())) return;
        doc.addEventListener('mouseup', copySelection, { once: true });
      };
      element.addEventListener('mousedown', watchRelease);
      return () => {
        element.removeEventListener('mousedown', watchRelease);
        doc.removeEventListener('mouseup', copySelection);
      };
    }

    const disposable = terminal.onSelectionChange(() => {
      if (suppressSelectionPopoverRef.current?.()) {
        setSelectionPopover((prev) => (prev.visible ? { ...prev, visible: false } : prev));
        return;
      }
      if (terminal.hasSelection()) {
        const text = terminal.getSelection();
        const { x, y } = mousePositionRef.current;
        setSelectionPopover({ visible: true, x, y, text });
      } else {
        setSelectionPopover((prev) => ({ ...prev, visible: false }));
      }
    });

    return () => {
      disposable.dispose();
    };
  }, [terminal, copyOnSelect, onCopyError, suppressSelectionPopoverRef]);

  // File popover action handlers
  const handleOpenInEditor = useCallback(async () => {
    const { relativePath, line } = filePopover;
    if (relativePath === null) return;

    // Check if file exists - file:exists returns a bare boolean
    const exists = await window.electronAPI.invoke('file:exists', {
      sessionId: config.sessionId,
      filePath: relativePath,
    });

    if (exists) {
      await openFileInEditor({
        sessionId: config.sessionId,
        filePath: relativePath,
        pin: true,
        cursorPosition: line ? { line, column: 1 } : undefined,
      });
    }

    setFilePopover((prev) => ({ ...prev, visible: false }));
  }, [filePopover, config.sessionId]);

  const handleShowInExplorer = useCallback(async () => {
    const { absolutePath } = filePopover;
    if (!absolutePath) return;

    if (isRemoteMode) {
      console.warn('Show in Explorer is only available in local mode.');
      setFilePopover((prev) => ({ ...prev, visible: false }));
      return;
    }

    try {
      const result: { success: boolean; error?: string } = await window.electronAPI.invoke(
        'app:showItemInFolder',
        absolutePath,
        config.sessionId
      );
      if (!result?.success) {
        console.error('Failed to show item in folder:', result?.error);
      }
    } catch (error) {
      console.error('Failed to show item in folder:', error);
    }

    setFilePopover((prev) => ({ ...prev, visible: false }));
  }, [filePopover, isRemoteMode, config.sessionId]);

  // Open in Pane's browser, from the selection popover and the right-click menu.
  const handleOpenInBrowser = useCallback((url: string) => openInPaneTab(config.sessionId, url), [config.sessionId]);

  const closeTooltip = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false }));
  }, []);

  const closeFilePopover = useCallback(() => {
    setFilePopover((prev) => ({ ...prev, visible: false }));
  }, []);

  const closeSelectionPopover = useCallback(() => {
    setSelectionPopover((prev) => ({ ...prev, visible: false }));
  }, []);

  return {
    onMouseMove,
    pathContext,
    tooltip,
    filePopover,
    isRemoteMode,
    selectionPopover,
    handleOpenInEditor,
    handleOpenInBrowser,
    handleShowInExplorer,
    closeTooltip,
    closeFilePopover,
    closeSelectionPopover,
  };
}
