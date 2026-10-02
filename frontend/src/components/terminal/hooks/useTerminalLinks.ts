import { useState, useEffect, useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { LinkProviderConfig } from '../linkProviders/types';
import { registerAllLinkProviders } from '../linkProviders';
import { panelApi } from '../../../services/panelApi';
import { openFileInEditor } from '../../../services/openFileInEditor';
import { usePanelStore } from '../../../stores/panelStore';
import { useConfigStore } from '../../../stores/configStore';
import type { BrowserPanelState, ToolPanel } from '../../../../../shared/types/panels';
import { copyTerminalText } from '../../../utils/terminalClipboard';

export interface UseTerminalLinksConfig {
  workingDirectory: string;
  sessionId: string;
  onCopyError: () => void;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  hint: string;
}

interface FilePopoverState {
  visible: boolean;
  x: number;
  y: number;
  path: string;
  line: number;
}

interface SelectionPopoverState {
  visible: boolean;
  x: number;
  y: number;
  text: string;
}

function getBrowserPanelTitle(url: string): string {
  try {
    return new URL(url).host || 'Browser';
  } catch {
    return 'Browser';
  }
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
    path: '',
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
  const { onCopyError } = config;
  const mousePositionRef = useRef({ x: 0, y: 0 });

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
      workingDirectory: config.workingDirectory,
      githubRemoteUrl: githubRemoteUrl ?? undefined,
      onShowTooltip: (event, text, hint) => {
        setTooltip({ visible: true, x: event.clientX, y: event.clientY, text, hint });
      },
      onHideTooltip: () => {
        setTooltip((prev) => ({ ...prev, visible: false }));
      },
      onShowFilePopover: (event, path, line) => {
        setFilePopover({ visible: true, x: event.clientX, y: event.clientY, path, line: line ?? 0 });
      },
      onOpenUrl: (url) => {
        window.electronAPI.openExternal(url);
      },
    };

    const disposables = registerAllLinkProviders(providerConfig);

    return () => {
      disposables.forEach((d) => d.dispose());
    };
  }, [terminal, config.workingDirectory, githubRemoteUrl]);

  // Listen for selection changes
  useEffect(() => {
    if (!terminal) return;

    // Remote mode copies a finished mouse selection straight to this machine's
    // clipboard instead of offering the selection popover.
    if (isRemoteMode) {
      const element = terminal.element;
      if (!element) return;
      const doc = element.ownerDocument;
      const copySelection = () => {
        if (!terminal.hasSelection()) return;
        void copyTerminalText(terminal.getSelection()).catch(onCopyError);
      };
      // A drag can end outside the terminal (auto-scroll, overshoot), so the
      // release is caught on the document, as xterm does to finish the selection.
      const watchRelease = () => {
        doc.addEventListener('mouseup', copySelection, { once: true });
      };
      element.addEventListener('mousedown', watchRelease);
      return () => {
        element.removeEventListener('mousedown', watchRelease);
        doc.removeEventListener('mouseup', copySelection);
      };
    }

    const disposable = terminal.onSelectionChange(() => {
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
  }, [terminal, isRemoteMode, onCopyError]);

  // Get panel store methods
  const addPanel = usePanelStore((state) => state.addPanel);
  const setActivePanelInStore = usePanelStore((state) => state.setActivePanel);
  const updatePanelState = usePanelStore((state) => state.updatePanelState);

  // File popover action handlers
  const handleOpenInEditor = useCallback(async () => {
    const { path, line } = filePopover;

    // Check if file exists - file:exists returns a bare boolean
    const exists = await window.electronAPI.invoke('file:exists', {
      sessionId: config.sessionId,
      filePath: path,
    });

    if (exists) {
      await openFileInEditor({
        sessionId: config.sessionId,
        filePath: path,
        pin: true,
        cursorPosition: line ? { line, column: 1 } : undefined,
      });
    }

    setFilePopover((prev) => ({ ...prev, visible: false }));
  }, [filePopover, config.sessionId]);

  const handleShowInExplorer = useCallback(async () => {
    const { path } = filePopover;

    if (isRemoteMode) {
      console.warn('Show in Explorer is only available in local mode.');
      setFilePopover((prev) => ({ ...prev, visible: false }));
      return;
    }

    try {
      const result: { success: boolean; error?: string } = await window.electronAPI.invoke(
        'app:showItemInFolder',
        path,
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

  const handleOpenInBrowser = useCallback(async (url: string) => {
    const panels = usePanelStore.getState().getSessionPanels(config.sessionId);
    const existingPanel = panels.find((candidate) => candidate.type === 'browser');

    let browserPanel: ToolPanel;
    if (existingPanel) {
      // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
      const existingCustomState = (existingPanel.state.customState ?? {}) as BrowserPanelState;
      browserPanel = {
        ...existingPanel,
        state: {
          ...existingPanel.state,
          customState: {
            ...existingCustomState,
            currentUrl: url,
          },
        },
      };
      await panelApi.updatePanel(browserPanel.id, { state: browserPanel.state });
      updatePanelState(browserPanel);
    } else {
      browserPanel = await panelApi.createPanel({
        sessionId: config.sessionId,
        type: 'browser',
        title: getBrowserPanelTitle(url),
        initialState: {
          customState: {
            currentUrl: url,
          },
        },
      });
      addPanel(browserPanel);
    }

    setActivePanelInStore(config.sessionId, browserPanel.id);
    await panelApi.setActivePanel(config.sessionId, browserPanel.id);

    window.dispatchEvent(new CustomEvent('browser-panel:navigate', {
      detail: { url, sessionId: config.sessionId },
    }));
  }, [config.sessionId, addPanel, setActivePanelInStore, updatePanelState]);

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
