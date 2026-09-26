import { decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';
import { terminalPathContextSchema, type TerminalPathContext } from '../../../../../shared/types/terminalPaths';
import type { TerminalFilePath } from '../resolveTerminalPath';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { LinkProviderConfig } from '../linkProviders/types';
import { registerAllLinkProviders } from '../linkProviders';
import { panelApi } from '../../../services/panelApi';
import { openFileInEditor } from '../../../services/openFileInEditor';
import { usePanelStore } from '../../../stores/panelStore';
import { useConfigStore } from '../../../stores/configStore';
import type { BrowserPanelState, ToolPanel } from '../../../../../shared/types/panels';

export interface UseTerminalLinksConfig {
  workingDirectory: string;
  sessionId: string;
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
      onOpenUrl: (url) => {
        window.electronAPI.openExternal(url);
      },
    };

    const disposables = registerAllLinkProviders(providerConfig);

    return () => {
      disposables.forEach((d) => d.dispose());
    };
  }, [terminal, config.workingDirectory, githubRemoteUrl, pathContext]);

  // Listen for selection changes
  useEffect(() => {
    if (!terminal) return;

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
  }, [terminal]);

  // Get panel store methods
  const addPanel = usePanelStore((state) => state.addPanel);
  const setActivePanelInStore = usePanelStore((state) => state.setActivePanel);
  const updatePanelState = usePanelStore((state) => state.updatePanelState);

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
