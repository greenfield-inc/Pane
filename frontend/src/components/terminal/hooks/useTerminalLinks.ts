import { useState, useEffect, useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { LinkProviderConfig } from '../linkProviders/types';
import { registerAllLinkProviders } from '../linkProviders';
import { openFileInEditor } from '../../../services/openFileInEditor';
import { canHostSessionBrowser, openUrlInSessionBrowser } from '../../../services/browserPanelNavigation';
import { useConfigStore } from '../../../stores/configStore';
import { useSession } from '../../../contexts/useSession';
import { isMac } from '../../../utils/platformUtils';
import {
  describeUrlGestures,
  routeUrlActivation,
  type LinkActivationEventLike,
  type LinkProvider,
} from '../linkRouting';

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
  const mousePositionRef = useRef({ x: 0, y: 0 });
  const sessionContext = useSession();

  // A Browser panel can only be hosted by an ordinary worktree Session. Project
  // (main-repo) terminals, Pane Chat, and terminals without a session context
  // cannot show one, so Primary+Shift falls back to the external browser there
  // instead of creating a hidden panel.
  const browserAvailable = canHostSessionBrowser(sessionContext?.session);
  const urlHoverHint = describeUrlGestures(isMac(), browserAvailable, 'git');
  const hoverHintFor = useCallback(
    (provider: LinkProvider) => describeUrlGestures(isMac(), browserAvailable, provider),
    [browserAvailable],
  );

  const routeUrl = useCallback(
    (url: string, event: LinkActivationEventLike, provider: LinkProvider) => routeUrlActivation(url, event, provider, {
      isMac: isMac(),
      browserAvailable,
      openExternal: async (target) => {
        try {
          await window.electronAPI.openExternal(target);
        } catch (error) {
          console.error('[useTerminalLinks] Failed to open link externally:', error);
        }
      },
      openInPaneBrowser: async (target) => { await openUrlInSessionBrowser(config.sessionId, target); },
    }),
    [browserAvailable, config.sessionId],
  );
  // xterm's linkHandler and WebLinksAddon are created once per terminal, so
  // they read the latest router through a ref rather than re-creating xterm.
  const routeUrlRef = useRef(routeUrl);
  routeUrlRef.current = routeUrl;

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
      onActivateUrl: (url, event) => {
        void routeUrlRef.current(url, event, 'git');
      },
      urlHoverHint,
    };

    const disposables = registerAllLinkProviders(providerConfig);

    return () => {
      disposables.forEach((d) => d.dispose());
    };
  }, [terminal, config.workingDirectory, githubRemoteUrl, urlHoverHint]);

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
    await openUrlInSessionBrowser(config.sessionId, url);
  }, [config.sessionId]);

  const closeTooltip = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false }));
  }, []);

  const showLinkTooltip = useCallback((event: MouseEvent, text: string, provider: LinkProvider) => {
    setTooltip({ visible: true, x: event.clientX, y: event.clientY, text, hint: hoverHintFor(provider) });
  }, [hoverHintFor]);
  // Consumed by xterm handlers created once per terminal.
  const showLinkTooltipRef = useRef(showLinkTooltip);
  showLinkTooltipRef.current = showLinkTooltip;
  const closeTooltipRef = useRef(closeTooltip);
  closeTooltipRef.current = closeTooltip;

  const closeFilePopover = useCallback(() => {
    setFilePopover((prev) => ({ ...prev, visible: false }));
  }, []);

  const closeSelectionPopover = useCallback(() => {
    setSelectionPopover((prev) => ({ ...prev, visible: false }));
  }, []);

  return {
    onMouseMove,
    routeUrlRef,
    showLinkTooltipRef,
    closeTooltipRef,
    browserAvailable,
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
