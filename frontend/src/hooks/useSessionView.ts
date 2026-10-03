import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useTheme } from '../contexts/ThemeContext';
import { useErrorStore } from '../stores/errorStore';
import { API, GitErrorResponse } from '../utils/api';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Session, GitCommands, GitErrorDetails, AttachedImage, AttachedText } from '../types/session';
import { getScriptTerminalTheme } from '../utils/terminalTheme';
import { createVisibilityAwareInterval } from '../utils/performanceUtils';
import { useHotkey } from './useHotkey';
import { useConfigStore } from '../stores/configStore';

interface PromptMarker {
  id: number;
  session_id?: string;
  panel_id?: string;
  prompt_text: string;
  output_index: number;
  output_line?: number;
  timestamp: string;
  completion_timestamp?: string;
}

export const useSessionView = (
  activeSession: Session | undefined,
) => {
  const { theme } = useTheme();
  const activeSessionId = activeSession?.id;
  const activeSessionStatus = activeSession?.status;
  const activeSessionOutputLength = activeSession?.output?.length ?? 0;
  const activeSessionMessageLength = activeSession?.jsonMessages?.length ?? 0;
  const activeSessionRunStartedAt = activeSession?.runStartedAt;
  const isRemoteMode = useConfigStore((state) => state.config?.remoteDaemon?.client.mode === 'remote');

  // Terminal instances
  const scriptTerminalInstance = useRef<Terminal | null>(null);
  const scriptFitAddon = useRef<FitAddon | null>(null);

  // States
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [scriptOutput, setScriptOutput] = useState<string[]>([]);
  const [isPathCollapsed, setIsPathCollapsed] = useState(true);
  const [input, setInput] = useState('');
  const [ultrathink, setUltrathink] = useState(false);
  const [isLoadingOutput, setIsLoadingOutput] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isMergingAndArchiving, setIsMergingAndArchiving] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outputLoadState, setOutputLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [gitCommands, setGitCommands] = useState<GitCommands | null>(null);
  const [hasChangesToRebase, setHasChangesToRebase] = useState<boolean>(false);
  const [hasStash, setHasStash] = useState<boolean>(false);
  const [showCommitMessageDialog, setShowCommitMessageDialog] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [dialogType, setDialogType] = useState<'rebase' | 'squash' | 'commit'>('rebase');
  const [showGitErrorDialog, setShowGitErrorDialog] = useState(false);
  const [gitErrorDetails, setGitErrorDetails] = useState<GitErrorDetails | null>(null);
  const [shouldSquash, setShouldSquash] = useState(true);
  const [isWaitingForFirstOutput, setIsWaitingForFirstOutput] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isOpeningIDE, setIsOpeningIDE] = useState(false);
  const [contextCompacted, setContextCompacted] = useState(false);
  const [compactedContext, setCompactedContext] = useState<string | null>(null);
  const [hasConversationHistory, setHasConversationHistory] = useState(false);

  // Archive confirm dialog state (triggered by Ctrl+Shift+W)
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);

  // Folder archive dialog state
  const [showFolderArchiveDialog, setShowFolderArchiveDialog] = useState(false);
  const [folderArchiveSessionId, setFolderArchiveSessionId] = useState<string | null>(null);
  const [folderArchiveFolderId, setFolderArchiveFolderId] = useState<string | null>(null);
  const [folderSessionCount, setFolderSessionCount] = useState(0);

  const [, forceUpdate] = useState({});
  const [shouldReloadOutput, setShouldReloadOutput] = useState(false);

  // Refs
  const previousSessionIdRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const loadingSessionIdRef = useRef<string | null>(null); // Track which session is loading
  const lastProcessedScriptOutputLength = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousStatusRef = useRef<string | null>(null);
  const isContinuingConversationRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const outputLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Force reset stuck state
  const forceResetLoadingState = useCallback(() => {
    loadingRef.current = false;
    loadingSessionIdRef.current = null;
    setIsLoadingOutput(false);
    setOutputLoadState('idle');
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (outputLoadTimeoutRef.current) {
      clearTimeout(outputLoadTimeoutRef.current);
      outputLoadTimeoutRef.current = null;
    }
  }, []);


  const loadOutputContent = useCallback(async (sessionId: string, retryCount = 0) => {
    
    // Cancel any existing load request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Clear any pending timeout
    if (outputLoadTimeoutRef.current) {
      clearTimeout(outputLoadTimeoutRef.current);
      outputLoadTimeoutRef.current = null;
    }
    
    // Check if already loading this session
    if (loadingRef.current && loadingSessionIdRef.current === sessionId) {
      return;
    }
    
    // If loading a different session, abort the old one
    if (loadingRef.current && loadingSessionIdRef.current !== sessionId) {
      loadingRef.current = false;
      loadingSessionIdRef.current = null;
    }
    
    // Check if session is still active
    const currentActiveSession = useSessionStore.getState().getActiveSession();
    if (!currentActiveSession || currentActiveSession.id !== sessionId) {
      return;
    }

    // Set loading state - CRITICAL: Must be reset in all code paths
    loadingRef.current = true;
    loadingSessionIdRef.current = sessionId;
    setIsLoadingOutput(true);
    setOutputLoadState('loading');
    setLoadError(null);

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();

    try {
      const response = await API.sessions.getOutput(sessionId);
      if (!response.success) {
        // Check if the session was archived (404 error)
        if (response.error && response.error.includes('not found')) {
          // CRITICAL: Reset loading state before returning
          loadingRef.current = false;
          loadingSessionIdRef.current = null;
          setIsLoadingOutput(false);
          setOutputLoadState('idle');
          return;
        }
        throw new Error(response.error || 'Failed to load output');
      }
      
      const outputs = response.data || [];
      
      // Check if still the active session after async operation
      const stillActiveSession = useSessionStore.getState().getActiveSession();
      if (!stillActiveSession || stillActiveSession.id !== sessionId) {
        // CRITICAL: Reset loading state before returning
        loadingRef.current = false;
        loadingSessionIdRef.current = null;
        setIsLoadingOutput(false);
        setOutputLoadState('idle');
        return;
      }
      
      // Set outputs
      useSessionStore.getState().setSessionOutputs(sessionId, outputs);
      
      // Outputs have been set
      
      setOutputLoadState('loaded');
      
      if (isWaitingForFirstOutput && outputs.length > 0) {
        setIsWaitingForFirstOutput(false);
      }
      
      // Reset continuing conversation flag after successfully loading output
      if (isContinuingConversationRef.current) {
        isContinuingConversationRef.current = false;
      }
      
      setLoadError(null);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        // CRITICAL: Reset loading state before returning
        loadingRef.current = false;
        loadingSessionIdRef.current = null;
        setIsLoadingOutput(false);
        setOutputLoadState('idle');
        return;
      }
      
      console.error(`[loadOutputContent] Error loading output for session ${sessionId}:`, error);
      setOutputLoadState('error');
      
      // Retry logic for new sessions only
      const isNewSession = activeSession?.status === 'initializing';
      const maxRetries = isNewSession ? 3 : 0;
      
      if (retryCount < maxRetries) {
        const delay = 1000 * (retryCount + 1);
        // Reset loading state before retry
        loadingRef.current = false;
        loadingSessionIdRef.current = null;
        setIsLoadingOutput(false);
        outputLoadTimeoutRef.current = setTimeout(() => {
          const currentActiveSession = useSessionStore.getState().getActiveSession();
          if (currentActiveSession && currentActiveSession.id === sessionId) {
            loadOutputContent(sessionId, retryCount + 1);
          }
        }, delay);
      } else {
        setLoadError(error instanceof Error ? error.message : 'Failed to load output content');
      }
    } finally {
      // Always reset loading state
      loadingRef.current = false;
      loadingSessionIdRef.current = null;
      setIsLoadingOutput(false);
    }
  }, [activeSession?.status, isWaitingForFirstOutput]);

  useEffect(() => {
    if (!activeSessionId) return;
    // Performance optimization: Check session status only, not entire state
    let previousStatus = activeSessionStatus;
    const unsubscribe = useSessionStore.subscribe((state) => {
      const updatedSession = state.activeMainRepoSession?.id === activeSessionId
        ? state.activeMainRepoSession
        : state.sessions.find(s => s.id === activeSessionId);
      
      // Only trigger update if status actually changed
      if (updatedSession && updatedSession.status !== previousStatus) {
        previousStatus = updatedSession.status;
        if (activeSessionStatus === 'initializing' && updatedSession.status === 'running') {
          // Only clear terminal and reload for new sessions, not when continuing conversations
          const hasExistingOutput = (updatedSession.output?.length ?? 0) > 0;
          if (!hasExistingOutput && !isContinuingConversationRef.current) {
            setShouldReloadOutput(true);
          }
        }
        forceUpdate({});
      }
    });
    const handleStatusChange = (event: CustomEvent) => {
      if (event.detail.sessionId === activeSessionId) forceUpdate({});
    };
    // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
    window.addEventListener('session-status-changed', handleStatusChange as EventListener);
    return () => {
      unsubscribe();
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      window.removeEventListener('session-status-changed', handleStatusChange as EventListener);
    };
  }, [activeSessionId, activeSessionStatus]);

  useEffect(() => {
    if (!activeSessionId) {
      setScriptOutput([]);
      return;
    }
    // Performance optimization: Track previous terminal output to avoid unnecessary updates
    let previousOutput = useSessionStore.getState().terminalOutput[activeSessionId];
    const unsubscribe = useSessionStore.subscribe((state) => {
      const sessionTerminalOutput = state.terminalOutput[activeSessionId] || [];
      // Only update if output actually changed
      if (sessionTerminalOutput !== previousOutput) {
        previousOutput = sessionTerminalOutput;
        setScriptOutput(sessionTerminalOutput);
        // Terminal is now independent - no automatic unread indicators
        // Users explicitly interact with the terminal, so they know when there's output
      }
    });
    setScriptOutput(useSessionStore.getState().terminalOutput[activeSessionId] || []);
    return unsubscribe;
  }, [activeSessionId]);

  useEffect(() => {
    const currentSessionId = activeSessionId || null;
    if (currentSessionId === previousSessionIdRef.current) return;

    previousSessionIdRef.current = currentSessionId;
    
    // Force reset any stuck loading state when switching sessions
    forceResetLoadingState();
    
    // View mode and activity tracking removed - handled by panels
    
    // Reset context compaction state when switching sessions
    setContextCompacted(false);
    setCompactedContext(null);
    
    if (!activeSessionId) {
      // Clear any error states when no session is active
      setLoadError(null);
      setOutputLoadState('idle');
      return;
    }
    let cancelled = false;
    
    // Check if session has conversation history
    const checkConversationHistory = async () => {
      try {
        const response = await API.sessions.getConversationMessageCount(activeSessionId);
        const hasMessages = (response.data ?? 0) > 0;
        if (cancelled) return;
        if (response.success) {
          setHasConversationHistory(hasMessages);
        }
      } catch (error) {
        console.error('Failed to check conversation history:', error);
        if (cancelled) return;
        setHasConversationHistory(false);
      }
    };
    checkConversationHistory();
    
    // Don't reset the terminal when switching sessions - preserve the state
    // if (scriptTerminalInstance.current) {
    //   scriptTerminalInstance.current.reset();
    // }
    
    // Reset output tracking
    lastProcessedScriptOutputLength.current = 0;

    const hasOutput = activeSessionOutputLength > 0;
    const hasMessages = activeSessionMessageLength > 0;
    const isNewSession = activeSessionStatus === 'initializing' || (activeSessionStatus === 'running' && !hasOutput && !hasMessages);
    
    
    if (isNewSession) {
      setIsWaitingForFirstOutput(true);
    } else {
      setIsWaitingForFirstOutput(false);
    }
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, activeSessionStatus, activeSessionOutputLength, activeSessionMessageLength, forceResetLoadingState]);

  // Consolidated effect for loading output
  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    let loadTimeout: NodeJS.Timeout | null = null;
    
    // Skip initial load if continuing conversation, but allow explicit reloads
    if (isContinuingConversationRef.current && outputLoadState === 'idle' && !shouldReloadOutput) {
      return;
    }
    
    // Check if session has output data
    
    
    // Check for stuck loading state and force reset if needed
    if (loadingRef.current && outputLoadState === 'idle') {
      // Stuck loading state detected - debug logging removed
      forceResetLoadingState();
    }
    
    // Determine if we need to load output
    let shouldLoad = false;
    let loadDelay = 0;
    
    if (outputLoadState === 'idle') {
      // Always load when idle - let the backend be the source of truth
      shouldLoad = true;
      loadDelay = activeSessionStatus === 'initializing' ? 500 : 200;
    } else if (shouldReloadOutput) {
      // Explicit reload requested
      shouldLoad = true;
      loadDelay = 0;
      setShouldReloadOutput(false);
    } else if (outputLoadState === 'error' && !loadingRef.current) {
      // Retry after error if not currently loading
      shouldLoad = true;
      loadDelay = 1000;
    }
    
    if (shouldLoad && !loadingRef.current) {
      if (loadDelay > 0) {
        loadTimeout = setTimeout(() => {
          if (!loadingRef.current) {
            loadOutputContent(activeSessionId);
          }
        }, loadDelay);
        outputLoadTimeoutRef.current = loadTimeout;
      } else {
        loadOutputContent(activeSessionId);
      }
    }
    return () => {
      if (loadTimeout) {
        clearTimeout(loadTimeout);
        if (outputLoadTimeoutRef.current === loadTimeout) {
          outputLoadTimeoutRef.current = null;
        }
      }
    };
  }, [
    activeSessionId,
    activeSessionStatus,
    activeSessionOutputLength,
    activeSessionMessageLength,
    outputLoadState,
    shouldReloadOutput,
    loadOutputContent,
    forceResetLoadingState
  ]);
  
  // Listen for output available events with aggressive throttling for performance
  useEffect(() => {
    let reloadDebounceTimer: NodeJS.Timeout | null = null;
    let lastReloadTime = 0;
    // PERFORMANCE: Adaptive reload interval based on output size
    const getMinReloadInterval = () => {
      const sessionState = useSessionStore.getState();
      const currentSession = sessionState.activeMainRepoSession?.id === activeSessionId
        ? sessionState.activeMainRepoSession
        : sessionState.sessions.find(session => session.id === activeSessionId);
      const outputSize = currentSession?.output?.length ?? 0;
      if (outputSize > 2000) return 3000; // 3 seconds for very large outputs
      if (outputSize > 1000) return 2000; // 2 seconds for large outputs  
      if (outputSize > 500) return 1500;  // 1.5 seconds for medium outputs
      return 1000; // 1 second for small outputs
    };
    const MIN_RELOAD_INTERVAL = getMinReloadInterval();
    
    const handleOutputAvailable = (event: CustomEvent) => {
      const { sessionId } = event.detail;
      
      // Check if this is for the active session
      if (activeSessionId === sessionId) {
        // Trigger reload if we're loaded or if we're continuing a conversation
        if (outputLoadState === 'loaded' || isContinuingConversationRef.current) {
          const now = Date.now();
          const timeSinceLastReload = now - lastReloadTime;
          
          // PERFORMANCE FIX: Throttle reloads to prevent CPU overload
          if (timeSinceLastReload < MIN_RELOAD_INTERVAL) {
            // Schedule for later if too soon
            if (reloadDebounceTimer) {
              clearTimeout(reloadDebounceTimer);
            }
            reloadDebounceTimer = setTimeout(() => {
              setShouldReloadOutput(true);
              lastReloadTime = Date.now();
              reloadDebounceTimer = null;
            }, MIN_RELOAD_INTERVAL - timeSinceLastReload);
          } else {
            // Can reload immediately
            setShouldReloadOutput(true);
            lastReloadTime = now;
          }
        }
      }
    };
    
    // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
    window.addEventListener('session-output-available', handleOutputAvailable as EventListener);
    return () => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      window.removeEventListener('session-output-available', handleOutputAvailable as EventListener);
      if (reloadDebounceTimer) {
        clearTimeout(reloadDebounceTimer);
      }
    };
  }, [activeSessionId, outputLoadState]);



  useEffect(() => {
    if (!scriptTerminalInstance.current || !activeSessionId) return;
    // Don't reset terminal on session change - this causes the terminal to clear
    // scriptTerminalInstance.current.reset();
    // Instead, just reset the tracking counter
    lastProcessedScriptOutputLength.current = 0;
  }, [activeSessionId]);

  // Performance: Memoize terminal output join operation
  const fullScriptOutputMemo = useMemo(() => {
    if (!scriptOutput || scriptOutput.length === 0) return '';
    
    // CRITICAL PERFORMANCE FIX: Even more aggressive limit for terminal output
    const MAX_TERMINAL_OUTPUT = 100; // Further reduced from 300 to prevent blocking
    
    // Early warning for very large terminal outputs
    if (scriptOutput.length > 2000) {
      console.warn(`[Performance] Script output too large (${scriptOutput.length} items), showing recent ${MAX_TERMINAL_OUTPUT} items only`);
    }
    
    const outputToProcess = scriptOutput.length > MAX_TERMINAL_OUTPUT
      ? scriptOutput.slice(-MAX_TERMINAL_OUTPUT)
      : scriptOutput;
    
    // PERFORMANCE: Direct string building without intermediate arrays
    if (outputToProcess.length > 25) {
      let result = '';
      const batchSize = 15; // Very small batches for terminal output
      
      for (let i = 0; i < outputToProcess.length; i += batchSize) {
        const endIndex = Math.min(i + batchSize, outputToProcess.length);
        let batchResult = '';
        
        // Build each batch directly
        for (let j = i; j < endIndex; j++) {
          batchResult += outputToProcess[j];
        }
        result += batchResult;
      }
      
      return result;
    } else {
      return outputToProcess.join('');
    }
  }, [scriptOutput]);
  
  useEffect(() => {
    if (!scriptTerminalInstance.current || !activeSession) return;
    const existingOutput = fullScriptOutputMemo;
    if (existingOutput && lastProcessedScriptOutputLength.current === 0) {
      scriptTerminalInstance.current.write(existingOutput);
      lastProcessedScriptOutputLength.current = existingOutput.length;
    }
  }, [activeSessionId, fullScriptOutputMemo, activeSession]);
  
  useEffect(() => {
    if (!scriptTerminalInstance.current || !activeSessionId) return;
    const currentTerminalOutput = useSessionStore.getState().terminalOutput[activeSessionId] || [];
    if (lastProcessedScriptOutputLength.current === 0 && currentTerminalOutput.length > 0) {
      const existingOutput = currentTerminalOutput.join('');
      scriptTerminalInstance.current.write(existingOutput);
      lastProcessedScriptOutputLength.current = existingOutput.length;
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (!scriptTerminalInstance.current || !activeSession) return;
    const fullScriptOutput = fullScriptOutputMemo;
    
    // Handle case where output was cleared (e.g., user clicked clear button)
    if (fullScriptOutput.length === 0 && lastProcessedScriptOutputLength.current > 0) {
      // Only reset if the output was explicitly cleared to 0
      scriptTerminalInstance.current.reset();
      lastProcessedScriptOutputLength.current = 0;
    } else if (fullScriptOutput.length < lastProcessedScriptOutputLength.current) {
      // Output got shorter but not cleared - this might be a sync issue
      // Don't reset, just update the tracking
      lastProcessedScriptOutputLength.current = fullScriptOutput.length;
    } else if (fullScriptOutput.length > lastProcessedScriptOutputLength.current) {
      const newOutput = fullScriptOutput.substring(lastProcessedScriptOutputLength.current);
      scriptTerminalInstance.current.write(newOutput);
      lastProcessedScriptOutputLength.current = fullScriptOutput.length;
      // Only auto-scroll if user is already at the bottom
      const buffer = scriptTerminalInstance.current.buffer.active;
      const isAtBottom = buffer.viewportY >= buffer.length - scriptTerminalInstance.current.rows;
      
      if (isAtBottom) {
        scriptTerminalInstance.current.scrollToBottom();
      }
    }
  }, [fullScriptOutputMemo, activeSessionId, activeSession]);

  useEffect(() => {
    // Listen for session deletion events
    const handleSessionDeleted = (event: CustomEvent) => {
      // The event detail contains just { id } from the backend
      if (event.detail?.id === activeSessionId) {
        // Force reset loading states
        forceResetLoadingState();
      }
    };

    // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
    window.addEventListener('session-deleted', handleSessionDeleted as EventListener);

    return () => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      window.removeEventListener('session-deleted', handleSessionDeleted as EventListener);
      // Cancel any pending operations
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (outputLoadTimeoutRef.current) {
        clearTimeout(outputLoadTimeoutRef.current);
      }
      scriptTerminalInstance.current?.dispose();
      scriptTerminalInstance.current = null;
    };
  }, [activeSessionId, forceResetLoadingState]);

  useEffect(() => {
    const handleResize = () => {
      scriptFitAddon.current?.fit();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    // Add a small delay to ensure CSS has propagated
    const timer = setTimeout(() => {
      if (scriptTerminalInstance.current) {
        const newScriptTheme = getScriptTerminalTheme();
        scriptTerminalInstance.current.options.theme = newScriptTheme;
        // Force refresh to apply new colors
        scriptTerminalInstance.current.refresh(0, scriptTerminalInstance.current.rows - 1);
      }
    }, 50); // Small delay to ensure CSS updates have propagated
    
    return () => clearTimeout(timer);
  }, [theme]);

  useEffect(() => {
    if (!activeSessionStatus) return;
    if (['running', 'initializing'].includes(activeSessionStatus)) {
      const sessionStartTime = activeSessionRunStartedAt ? new Date(activeSessionRunStartedAt).getTime() : Date.now();
      setElapsedTime(Math.floor((Date.now() - sessionStartTime) / 1000));
      // Use visibility-aware interval that slows down when tab is not visible
      const cleanup = createVisibilityAwareInterval(
        () => setElapsedTime(Math.floor((Date.now() - sessionStartTime) / 1000)),
        5000, // 5 seconds when visible
        30000 // 30 seconds when not visible
      );
      return cleanup;
    } else {
      setElapsedTime(0);
    }
  }, [activeSessionStatus, activeSessionRunStartedAt, activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) {
      setGitCommands(null);
      setHasChangesToRebase(false);
      setHasStash(false);
      return;
    }
    let cancelled = false;
    const loadGitData = async () => {
      try {
        const [commandsResponse, changesResponse, stashResponse] = await Promise.all([
          API.sessions.getGitCommands(activeSessionId),
          API.sessions.hasChangesToRebase(activeSessionId),
          API.sessions.hasStash(activeSessionId)
        ]);
        if (cancelled) return;
        if (commandsResponse.success) setGitCommands(commandsResponse.data);
        if (changesResponse.success) setHasChangesToRebase(changesResponse.data);
        if (stashResponse.success) setHasStash(stashResponse.data);
      } catch (error) { console.error('Error loading git data:', error); }
    };
    loadGitData();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const { scrollHeight } = textareaRef.current;
      textareaRef.current.style.height = `${Math.min(Math.max(scrollHeight, 42), 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (!activeSessionStatus) return;
    const status = activeSessionStatus;
    const prevStatus = previousStatusRef.current;
    
    if (prevStatus === 'initializing' && status === 'running') {
      // Reset the flag after status changes to running
      if (isContinuingConversationRef.current) {
        isContinuingConversationRef.current = false;
      }
    }
    
    // Trigger reload when status changes indicate output might be available
    if (prevStatus && prevStatus !== status) {
      if (prevStatus === 'stopped' && status === 'initializing') {
        setShouldReloadOutput(true);
      } else if (prevStatus === 'initializing' && status === 'running') {
        setShouldReloadOutput(true);
      }
    }
    
    previousStatusRef.current = status;
  }, [activeSessionStatus, activeSessionId]);
  
  const isSessionBusy = activeSession?.status === 'running' || activeSession?.status === 'initializing';
  const getGitCommandDisabledReason = (command: 'commit' | 'push' | 'undo' | 'pull' | 'rebase' | 'merge'): string | null => {
    if (!activeSession) return 'No active session';
    if (isMerging) return 'Git operation already in progress';
    if (isSessionBusy) return 'Session is currently running';
    if (activeSession.isMainRepo) return 'Only available in worktree panes';

    switch (command) {
      case 'commit':
        return (activeSession.gitStatus?.hasUncommittedChanges || activeSession.gitStatus?.hasUntrackedFiles)
          ? null
          : 'No changes to commit';
      case 'push':
        return (activeSession.gitStatus?.ahead ?? 0) > 0 ? null : 'No commits to push';
      case 'undo':
        return (activeSession.gitStatus?.ahead ?? 0) > 0 ? null : 'No local commits to undo';
      case 'pull':
        return null;
      case 'rebase':
        return hasChangesToRebase ? null : 'No changes to rebase from main';
      case 'merge':
        return !!activeSession.gitStatus?.totalCommits && activeSession.gitStatus.totalCommits > 0 && (activeSession.gitStatus?.ahead ?? 0) > 0
          ? null
          : 'No commits to merge';
    }
  };

  useHotkey({
    id: 'git-commit',
    label: 'Git: Commit',
    keys: 'mod+shift+k',
    category: 'session',
    action: () => {
      setDialogType('commit');
      setShowCommitMessageDialog(true);
    },
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo &&
      ((activeSession.gitStatus?.hasUncommittedChanges ?? false) || (activeSession.gitStatus?.hasUntrackedFiles ?? false)),
    disabledReason: () => getGitCommandDisabledReason('commit'),
  });

  useHotkey({
    id: 'git-push',
    label: 'Git: Push',
    keys: 'mod+shift+u',
    category: 'session',
    action: () => handleGitPush(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo && (activeSession.gitStatus?.ahead ?? 0) > 0,
    disabledReason: () => getGitCommandDisabledReason('push'),
  });

  useHotkey({
    id: 'git-soft-reset',
    label: 'Git: Undo Last Commit',
    keys: 'mod+alt+z',
    category: 'session',
    action: () => handleGitSoftReset(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo && (activeSession.gitStatus?.ahead ?? 0) > 0,
    disabledReason: () => getGitCommandDisabledReason('undo'),
  });

  useHotkey({
    id: 'git-pull',
    label: 'Git: Pull',
    keys: 'mod+shift+l',
    category: 'session',
    action: () => handleGitPull(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo,
    disabledReason: () => getGitCommandDisabledReason('pull'),
  });

  useHotkey({
    id: 'git-rebase-from-main',
    label: 'Git: Rebase from Main',
    keys: 'mod+shift+r',
    category: 'session',
    action: () => handleRebaseMainIntoWorktree(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo && hasChangesToRebase,
    disabledReason: () => getGitCommandDisabledReason('rebase'),
  });

  useHotkey({
    id: 'git-merge-to-main',
    label: 'Git: Merge to Main',
    keys: 'mod+shift+m',
    category: 'session',
    action: () => handleSquashAndRebaseToMain(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo &&
      !!activeSession.gitStatus?.totalCommits && activeSession.gitStatus.totalCommits > 0 &&
      (activeSession.gitStatus?.ahead ?? 0) > 0,
    disabledReason: () => getGitCommandDisabledReason('merge'),
  });

  const handleSendInput = async (attachedImages?: AttachedImage[], attachedTexts?: AttachedText[]) => {
    if (!input.trim() || !activeSession) {
      return;
    }
    
    let finalInput = ultrathink ? `${input}\nultrathink` : input;
    
    // Check if we have compacted context to inject
    if (contextCompacted && compactedContext) {
      finalInput = `<session_context>\n${compactedContext}\n</session_context>\n\n${finalInput}`;
      
      // Clear the compacted context after using it
      setContextCompacted(false);
      setCompactedContext(null);
    }
    
    // Collect all attachments (text and images)
    const attachmentPaths = [];
    
    // If there are attached texts, save them and collect paths
    if (attachedTexts && attachedTexts.length > 0) {
      try {
        for (const text of attachedTexts) {
          // Save text to file via IPC
          const textFilePath = await window.electronAPI.sessions.saveLargeText(
            activeSession.id,
            text.content
          );
          
          attachmentPaths.push(textFilePath);
        }
      } catch (error) {
        console.error('Failed to save attached text to file:', error);
        // Continue without text files on error
      }
    }
    
    // If there are attached images, save them and collect paths
    if (attachedImages && attachedImages.length > 0) {
      try {
        // Save images via IPC
        const imagePaths = await window.electronAPI.sessions.saveImages(
          activeSession.id,
          attachedImages.map(img => ({
            name: img.name,
            dataUrl: img.dataUrl,
            type: img.type,
          }))
        );
        
        attachmentPaths.push(...imagePaths);
      } catch (error) {
        console.error('Failed to save images:', error);
        // Continue without images on error
      }
    }
    
    // If we have any attachments, wrap them in <attachments> tags
    if (attachmentPaths.length > 0) {
      const attachmentsMessage = `\n\n<attachments>\nPlease look at these files which may provide additional instructions or context:\n${attachmentPaths.join('\n')}\n</attachments>`;
      finalInput = `${finalInput}${attachmentsMessage}`;
    }
    
    const response = await API.sessions.sendInput(activeSession.id, `${finalInput}\n`);
    if (response.success) {
      setInput('');
      setUltrathink(false);
    }
  };

  const handleContinueConversation = async (
    attachedImages?: AttachedImage[],
    attachedTexts?: AttachedText[],
    modelOverride?: string
  ) => {
    if (!input.trim() || !activeSession) return;
    
    // Mark that we're continuing a conversation to prevent output reload
    isContinuingConversationRef.current = true;
    
    let finalInput = ultrathink ? `${input}\nultrathink` : input;
    
    // Check if we have compacted context to inject
    if (contextCompacted && compactedContext) {
      finalInput = `<session_context>\n${compactedContext}\n</session_context>\n\n${finalInput}`;
      
      // Clear the compacted context after using it
      setContextCompacted(false);
      setCompactedContext(null);
    }
    
    // Collect all attachments (text and images)
    const attachmentPaths = [];
    
    // If there are attached texts, save them and collect paths
    if (attachedTexts && attachedTexts.length > 0) {
      try {
        for (const text of attachedTexts) {
          // Save text to file via IPC
          const textFilePath = await window.electronAPI.sessions.saveLargeText(
            activeSession.id,
            text.content
          );
          
          attachmentPaths.push(textFilePath);
        }
      } catch (error) {
        console.error('Failed to save attached text to file:', error);
        // Continue without text files on error
      }
    }
    
    // If there are attached images, save them and collect paths
    if (attachedImages && attachedImages.length > 0) {
      try {
        // Save images via IPC
        const imagePaths = await window.electronAPI.sessions.saveImages(
          activeSession.id,
          attachedImages.map(img => ({
            name: img.name,
            dataUrl: img.dataUrl,
            type: img.type,
          }))
        );
        
        attachmentPaths.push(...imagePaths);
      } catch (error) {
        console.error('Failed to save images:', error);
        // Continue without images on error
      }
    }
    
    // If we have any attachments, wrap them in <attachments> tags
    if (attachmentPaths.length > 0) {
      const attachmentsMessage = `\n\n<attachments>\nPlease look at these files which may provide additional instructions or context:\n${attachmentPaths.join('\n')}\n</attachments>`;
      finalInput = `${finalInput}${attachmentsMessage}`;
    }
    
    const response = await API.sessions.continue(activeSession.id, finalInput, modelOverride);
    if (response.success) {
      setInput('');
      setUltrathink(false);
      // Output will be loaded automatically when session status changes to 'initializing'
      // No need to manually reload here as it can cause timing issues
    }
  };

  const handleTerminalCommand = async () => {
    if (!input.trim() || !activeSession) return;
    const response = await API.sessions.runTerminalCommand(activeSession.id, input);
    if (response.success) setInput('');
  };

  const handleStopSession = async () => {
    if (activeSession) await API.sessions.stop(activeSession.id);
  };
  
  const handleGitPull = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitPull(activeSession.id);
      if (!response.success) {
        if (response.error?.includes('conflict') || response.error?.includes('merge')) {
          setGitErrorDetails({
            title: 'Pull Failed - Merge Conflicts',
            message: 'There are merge conflicts that need to be resolved manually.',
            command: 'git pull',
            output: response.details || response.error || 'No output available',
            workingDirectory: activeSession.worktreePath,
          });
          setShowGitErrorDialog(true);
          setMergeError('Merge conflicts detected. You\'ll need to resolve them manually or ask Claude to help.');
        } else {
          setMergeError(response.error || 'Failed to pull from remote');
        }
      // Removed viewMode check - panels handle their own refresh
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to pull from remote');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitPush = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
        const response = await API.sessions.gitPush(activeSession.id);
        if(!response.success) setMergeError(response.error || 'Failed to push to remote');
    } catch (error) {
        setMergeError(error instanceof Error ? error.message : 'Failed to push to remote');
    } finally {
        setIsMerging(false);
    }
  };

  const handleCreatePr = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.createPr(activeSession.id);
      if (!response.success) {
        setMergeError(response.error || 'Failed to create pull request');
        return;
      }

      if (response.data?.url) {
        await window.electronAPI?.openExternal(response.data.url);
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to create pull request');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitSoftReset = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitSoftReset(activeSession.id);
      if (!response.success) setMergeError(response.error || 'Failed to undo commit');
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to undo commit');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitFetch = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitFetch(activeSession.id);
      if (!response.success) {
        setMergeError(response.error || 'Failed to fetch from remote');
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to fetch from remote');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitStash = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitStash(activeSession.id);
      if (!response.success) {
        setMergeError(response.error || 'Failed to stash changes');
      } else {
        // Refresh stash status after successful stash
        API.sessions.hasStash(activeSession.id).then(stashResponse => {
          if (stashResponse.success) setHasStash(stashResponse.data);
        }).catch(() => {});
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to stash changes');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitStashPop = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitStashPop(activeSession.id);
      if (!response.success) {
        setMergeError(response.error || 'Failed to pop stash');
      } else {
        // Refresh stash status after successful pop
        API.sessions.hasStash(activeSession.id).then(stashResponse => {
          if (stashResponse.success) setHasStash(stashResponse.data);
        }).catch(() => {});
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to pop stash');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitStageAndCommit = async (message: string) => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitStageAndCommit(activeSession.id, message);
      if (!response.success) {
        setMergeError(response.error || 'Failed to commit changes');
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to commit changes');
    } finally {
      setIsMerging(false);
    }
  };

  const handleSetUpstream = async (remoteBranch: string): Promise<boolean> => {
    if (!activeSession) return false;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.setUpstream(activeSession.id, remoteBranch);
      if (!response.success) {
        setMergeError(response.error || 'Failed to set tracking branch');
        return false;
      }
      return true;
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to set tracking branch');
      return false;
    } finally {
      setIsMerging(false);
    }
  };

  const handleRebaseMainIntoWorktree = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response: GitErrorResponse = await API.sessions.rebaseMainIntoWorktree(activeSession.id);
      
      if (!response.success) {
        if (response.gitError) {
          const gitError = response.gitError;
          setGitErrorDetails({
            title: gitError.hasConflicts ? 'Rebase Conflicts Detected' : 'Rebase Failed',
            message: response.error || 'Failed to rebase main into worktree',
            command: gitError.command,
            output: gitError.output || 'No output available',
            workingDirectory: gitError.workingDirectory,
            isRebaseConflict: gitError.output?.toLowerCase().includes('conflict') || gitError.hasConflicts || false,
            hasConflicts: gitError.hasConflicts,
            conflictingFiles: gitError.conflictingFiles,
            conflictingCommits: gitError.conflictingCommits,
          });
          setShowGitErrorDialog(true);
        } else {
          setMergeError(response.error || 'Failed to rebase main into worktree');
        }
      } else {
        // Run this in the background and don't let it block the finally block
        API.sessions.hasChangesToRebase(activeSession.id).then(changesResponse => {
          if (changesResponse.success) setHasChangesToRebase(changesResponse.data);
        }).catch(error => {
          console.error(`[handleRebaseMainIntoWorktree] hasChangesToRebase failed`, error);
        });
      }
    } catch (error) {
      console.error(`[handleRebaseMainIntoWorktree] Error in try block`, error);
      setMergeError(error instanceof Error ? error.message : 'Failed to rebase main into worktree');
    } finally {
      setIsMerging(false);
    }
  };

  const handleAbortRebaseAndUseClaude = async () => {
    if (!activeSession) return;
    setShowGitErrorDialog(false);
    setIsLoadingOutput(true);
    try {
      const response = await API.sessions.abortRebaseAndUseClaude(activeSession.id);
      if (response.success) {
        setMergeError(null);
        setGitErrorDetails(null);
      } else {
        setMergeError(response.error || 'Failed to abort rebase and use Claude Code');
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to abort rebase and use Claude Code');
    } finally {
      setIsLoadingOutput(false);
    }
  };
  
  const generateDefaultCommitMessage = async () => {
    if (!activeSession) return '';
    try {
      const promptsResponse = await API.sessions.getPrompts(activeSession.id);
      if (promptsResponse.success && promptsResponse.data?.length > 0) {
        return promptsResponse.data.map((p: PromptMarker) => p.prompt_text).filter(Boolean).join('\n\n');
      }
    } catch (error) {
      console.error('Error generating default commit message:', error);
    }
    const comparisonBaseBranch = gitCommands?.comparisonBaseBranch || 'main';
    return dialogType === 'squash'
      ? `Squashed commits from ${gitCommands?.currentBranch || 'feature branch'}`
      : `Rebase from ${comparisonBaseBranch}`;
  };

  const handleSquashAndRebaseToMain = async () => {
    if (!activeSession) return;

    // Check if worktree needs to be rebased onto main first
    try {
      const changesResponse = await API.sessions.hasChangesToRebase(activeSession.id);
      if (changesResponse.success && changesResponse.data === true) {
        // Show warning that rebase is needed first
        setGitErrorDetails({
          title: 'Rebase Required',
          message: `Your worktree has changes from ${gitCommands?.comparisonBaseBranch || 'main'} that need to be rebased first.\n\nYou must rebase your worktree before merging to prevent conflicts.`,
          output: `Your worktree branch is behind ${gitCommands?.comparisonBaseBranch || 'main'}.\n\nClick "Rebase from ${gitCommands?.comparisonBaseBranch || 'Main'}" first to update your worktree, then try merging again.`,
          workingDirectory: activeSession.worktreePath,
        });
        setShowGitErrorDialog(true);
        return;
      }
    } catch (error) {
      console.error('Error checking if rebase needed:', error);
      // Continue with merge dialog on error - let the merge fail with proper error handling
    }

    const defaultMessage = await generateDefaultCommitMessage();
    setCommitMessage(defaultMessage);
    setDialogType('squash');
    setShouldSquash(true); // Default to squashing for cleaner merge
    setShowCommitMessageDialog(true);
  };

  const performSquashWithCommitMessage = async (message: string) => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    setShowCommitMessageDialog(false);
    try {
      const response: GitErrorResponse = shouldSquash
        ? await API.sessions.squashAndRebaseToMain(activeSession.id, message)
        : await API.sessions.rebaseToMain(activeSession.id);

      if (!response.success) {
        if (response.gitError) {
          const gitError = response.gitError;
          setGitErrorDetails({
            title: 'Merge Failed',
            message: response.error || `Failed to merge to main`,
            commands: gitError.commands,
            output: gitError.output || 'No output available',
            workingDirectory: gitError.workingDirectory,
            projectPath: gitError.projectPath,
          });
          setShowGitErrorDialog(true);
        } else {
          setMergeError(response.error || `Failed to merge to main`);
        }
      } else {
        // Run this in the background and don't let it block the finally block
        API.sessions.hasChangesToRebase(activeSession.id).then(changesResponse => {
          if (changesResponse.success) setHasChangesToRebase(changesResponse.data);
        }).catch(error => {
          console.error(`[performSquashWithCommitMessage] hasChangesToRebase failed`, error);
        });
      }
    } catch (error) {
      console.error(`[performSquashWithCommitMessage] Error in try block`, error);
      setMergeError(error instanceof Error ? error.message : `Failed to merge to main`);
    } finally {
      setIsMerging(false);
    }
  };

  const performSquashWithCommitMessageAndArchive = async (message: string) => {
    if (!activeSession) return;
    setIsMergingAndArchiving(true);
    setMergeError(null);
    setShowCommitMessageDialog(false);
    try {
      const response: GitErrorResponse = shouldSquash
        ? await API.sessions.squashAndRebaseToMain(activeSession.id, message)
        : await API.sessions.rebaseToMain(activeSession.id);

      if (!response.success) {
        if (response.gitError) {
          const gitError = response.gitError;
          setGitErrorDetails({
            title: 'Merge Failed',
            message: response.error || `Failed to merge to main`,
            commands: gitError.commands,
            output: gitError.output || 'No output available',
            workingDirectory: gitError.workingDirectory,
            projectPath: gitError.projectPath,
          });
          setShowGitErrorDialog(true);
        } else {
          setMergeError(response.error || `Failed to merge to main`);
        }
        return;
      }

      // Merge succeeded - check if session is in a folder with other sessions
      const sessionId = activeSession.id;
      const folderId = activeSession.folderId;

      if (folderId) {
        // Check how many sessions are in this folder
        const allSessions = useSessionStore.getState().sessions;
        const sessionsInFolder = allSessions.filter(s => s.folderId === folderId && !s.archived);

        if (sessionsInFolder.length > 1) {
          // There are other sessions in the folder - show dialog
          setFolderArchiveSessionId(sessionId);
          setFolderArchiveFolderId(folderId);
          setFolderSessionCount(sessionsInFolder.length);
          setShowFolderArchiveDialog(true);
          return; // Don't archive yet - wait for user decision
        }
      }

      // No folder or only one session in folder - archive just this session
      await archiveSingleSession(sessionId);
    } catch (error) {
      console.error(`[performSquashWithCommitMessageAndArchive] Error in try block`, error);
      setMergeError(error instanceof Error ? error.message : `Failed to merge to main`);
    } finally {
      setIsMergingAndArchiving(false);
    }
  };

  const archiveSingleSession = async (sessionId: string) => {
    useSessionStore.getState().addDeletingSessionId(sessionId);
    try {
      const archiveResponse = await API.sessions.delete(sessionId);
      if (!archiveResponse.success) {
        console.error('[archiveSingleSession] Archive failed:', archiveResponse.error);
        setMergeError(`Merge succeeded but archive failed: ${archiveResponse.error}`);
      }
      await useSessionStore.getState().setActiveSession(null);
    } catch (archiveError) {
      console.error('[archiveSingleSession] Archive error:', archiveError);
      setMergeError(`Merge succeeded but archive failed: ${archiveError instanceof Error ? archiveError.message : 'Unknown error'}`);
    }
  };

  const handleConfirmArchive = useCallback(async () => {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    useSessionStore.getState().addDeletingSessionId(sessionId);
    try {
      const response = await API.sessions.delete(sessionId);
      if (!response.success) {
        console.error('[handleConfirmArchive] Archive failed:', response.error);
        useSessionStore.getState().removeDeletingSessionId(sessionId);
        return;
      }
      await useSessionStore.getState().setActiveSession(null);
    } catch (error) {
      console.error('[handleConfirmArchive] Archive error:', error);
      useSessionStore.getState().removeDeletingSessionId(sessionId);
    }
  }, [activeSession]);

  const handleArchiveSessionOnly = async () => {
    setShowFolderArchiveDialog(false);
    if (folderArchiveSessionId) {
      await archiveSingleSession(folderArchiveSessionId);
    }
    setFolderArchiveSessionId(null);
    setFolderArchiveFolderId(null);
    setFolderSessionCount(0);
    setIsMergingAndArchiving(false);
  };

  const handleArchiveEntireFolder = async () => {
    setShowFolderArchiveDialog(false);
    if (folderArchiveFolderId) {
      const allSessions = useSessionStore.getState().sessions;
      const sessionsInFolder = allSessions.filter(s => s.folderId === folderArchiveFolderId && !s.archived);

      // Add all sessions to deleting state
      for (const session of sessionsInFolder) {
        useSessionStore.getState().addDeletingSessionId(session.id);
      }

      // Archive all sessions in the folder
      for (const session of sessionsInFolder) {
        try {
          const archiveResponse = await API.sessions.delete(session.id);
          if (!archiveResponse.success) {
            console.error(`[handleArchiveEntireFolder] Archive failed for session ${session.id}:`, archiveResponse.error);
          }
        } catch (archiveError) {
          console.error(`[handleArchiveEntireFolder] Archive error for session ${session.id}:`, archiveError);
        }
      }

      // Delete the folder after archiving all sessions
      try {
        await API.folders.delete(folderArchiveFolderId);
      } catch (folderError) {
        console.error('[handleArchiveEntireFolder] Folder delete error:', folderError);
      }

      await useSessionStore.getState().setActiveSession(null);
    }
    setFolderArchiveSessionId(null);
    setFolderArchiveFolderId(null);
    setFolderSessionCount(0);
    setIsMergingAndArchiving(false);
  };

  const handleCancelFolderArchive = () => {
    setShowFolderArchiveDialog(false);
    setFolderArchiveSessionId(null);
    setFolderArchiveFolderId(null);
    setFolderSessionCount(0);
    setIsMergingAndArchiving(false);
  };

  const handleOpenIDE = async () => {
    if (!activeSession) return;
    if (isRemoteMode) {
      const { showError } = useErrorStore.getState();
      showError({
        title: 'Open IDE unavailable',
        error: 'Open in IDE is only available in local mode. Switch this client back to the local runtime to use your desktop IDE.',
      });
      return;
    }
    
    setIsOpeningIDE(true);
    
    try {
      const response = await API.sessions.openIDE(activeSession.id);
      if (!response.success) {
        // Import and use the error store
        const { showError } = useErrorStore.getState();
        showError({
          title: 'Failed to open IDE',
          error: response.error || 'Unknown error occurred',
        });
      }
    } catch (error) {
      const { showError } = useErrorStore.getState();
      showError({
        title: 'Failed to open IDE',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    } finally {
      setIsOpeningIDE(false);
    }
  };

  const formatElapsedTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleStartEditName = () => {
    if (!activeSession) return;
    setEditName(activeSession.name);
    setIsEditingName(true);
  };

  const handleSaveEditName = async () => {
    if (!activeSession || editName.trim() === '' || editName === activeSession.name) {
      setIsEditingName(false);
      return;
    }
    try {
      await API.sessions.rename(activeSession.id, editName.trim());
      setIsEditingName(false);
    } catch {
      alert('Failed to rename pane');
      setEditName(activeSession.name);
      setIsEditingName(false);
    }
  };

  const handleCancelEditName = () => {
    setIsEditingName(false);
    setEditName('');
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEditName();
    } else if (e.key === 'Escape') {
      handleCancelEditName();
    }
  };

  const formatGitOutput = (output: string): string => {
    if (!output) return '';
    return output
      .replace(/error:/gi, '\x1b[31mERROR:\x1b[0m')
      .replace(/fatal:/gi, '\x1b[31mFATAL:\x1b[0m')
      .replace(/warning:/gi, '\x1b[33mWARNING:\x1b[0m')
      .replace(/hint:/gi, '\x1b[36mHINT:\x1b[0m')
      .replace(/CONFLICT \(.*?\):/g, '\x1b[31mCONFLICT\x1b[0m ($1):')
      .replace(/Auto-merging (.*)/g, '\x1b[33mAuto-merging\x1b[0m $1')
      .replace(/Merge conflict in (.*)/g, '\x1b[31mMerge conflict in\x1b[0m $1');
  };

  const getGitErrorTips = (details: GitErrorDetails): string[] => {
    const tips: string[] = [];
    const output = details.output?.toLowerCase() || '';
    const message = details.message?.toLowerCase() || '';
    
    // Check if conflicts were detected before rebase (new pre-check)
    if (details.hasConflicts) {
      tips.push('• Conflicts were detected before starting the rebase');
      tips.push('• Click "Use Claude Code to Resolve" to let Claude handle the conflicts');
      tips.push('• Alternatively, you can manually resolve conflicts by:');
      tips.push('  1. Running the rebase manually: git rebase <branch>');
      tips.push('  2. Fixing conflicts in the listed files');
      tips.push('  3. Running: git add <fixed-files> && git rebase --continue');
      if (details.conflictingFiles && details.conflictingFiles.length > 0) {
        tips.push(`• ${details.conflictingFiles.length} file(s) have conflicts that need resolution`);
      }
    } else if (output.includes('conflict') || message.includes('conflict')) {
      tips.push('• You have merge conflicts that need to be resolved manually');
      tips.push('• Use "git status" to see conflicted files');
      tips.push('• Edit the conflicted files to resolve conflicts, then stage and commit');
      tips.push('• After resolving, run "git rebase --continue" or "git rebase --abort"');
    } else if (output.includes('uncommitted changes') || output.includes('unstaged changes')) {
      tips.push('• You have uncommitted changes that prevent the operation');
      tips.push('• Either commit your changes first or stash them with "git stash"');
      tips.push('• After the operation, you can apply stashed changes with "git stash pop"');
    } else {
      tips.push('• Check if you have uncommitted changes that need to be resolved');
      tips.push('• Verify that the main branch exists and is up to date');
    }
    return tips;
  };

  const handleClearTerminal = useCallback(() => {
    if (scriptTerminalInstance.current) {
      scriptTerminalInstance.current.clear();
      
      // Also clear the stored script output for this session
      if (activeSession) {
        useSessionStore.getState().clearTerminalOutput(activeSession.id);
        lastProcessedScriptOutputLength.current = 0;
      }
    }
  }, [activeSession]);
  
  const handleCompactContext = async () => {
    if (!activeSession) return;
    
    try {
      // Generate the compacted context
      const response = await API.sessions.generateCompactedContext(activeSession.id);
      
      if (response.success && response.data) {
        const summary = response.data.summary;
        setCompactedContext(summary);
        setContextCompacted(true);
      } else {
        console.error('[Context Compaction] Failed to compact context:', response.error);
      }
    } catch (error) {
      console.error('[Context Compaction] Error during compaction:', error);
    }
  };
  
  return {
    theme,
    isEditingName,
    editName,
    setEditName,
    isPathCollapsed,
    setIsPathCollapsed,
    input,
    setInput,
    ultrathink,
    setUltrathink,
    isLoadingOutput,
    outputLoadState,
    isMerging,
    isMergingAndArchiving,
    mergeError,
    loadError,
    gitCommands,
    hasChangesToRebase,
    hasStash,
    showCommitMessageDialog,
    setShowCommitMessageDialog,
    commitMessage,
    setCommitMessage,
    dialogType,
    setDialogType,
    showGitErrorDialog,
    setShowGitErrorDialog,
    gitErrorDetails,
    shouldSquash,
    setShouldSquash,
    isWaitingForFirstOutput,
    elapsedTime,
    textareaRef,
    handleSendInput,
    handleContinueConversation,
    handleTerminalCommand,
    handleStopSession,
    handleGitPull,
    handleGitPush,
    handleCreatePr,
    handleGitSoftReset,
    handleGitFetch,
    handleGitStash,
    handleGitStashPop,
    handleGitStageAndCommit,
    handleSetUpstream,
    handleRebaseMainIntoWorktree,
    handleAbortRebaseAndUseClaude,
    handleSquashAndRebaseToMain,
    performSquashWithCommitMessage,
    performSquashWithCommitMessageAndArchive,
    handleOpenIDE,
    isOpeningIDE,
    formatElapsedTime,
    handleStartEditName,
    handleSaveEditName,
    handleCancelEditName,
    handleNameKeyDown,
    loadOutputContent,
    formatGitOutput,
    getGitErrorTips,
    forceResetLoadingState,
    handleClearTerminal,
    handleCompactContext,
    contextCompacted,
    hasConversationHistory,
    compactedContext,
    // Archive confirm dialog (Ctrl+Shift+W)
    showArchiveConfirm,
    setShowArchiveConfirm,
    handleConfirmArchive,
    // Folder archive dialog
    showFolderArchiveDialog,
    folderSessionCount,
    handleArchiveSessionOnly,
    handleArchiveEntireFolder,
    handleCancelFolderArchive,
  };
};
