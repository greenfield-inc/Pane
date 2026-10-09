import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { API } from '../utils/api';
import type { CreateSessionRequest } from '../types/session';
import type { Project } from '../types/project';
import { useErrorStore } from '../stores/errorStore';
import { GitBranch, ChevronRight, ChevronDown, X, Search, Check, GitFork, MessageSquare, Pin } from 'lucide-react';
import { Toggle } from './ui/Toggle';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { useSessionPreferencesStore, type SessionCreationPreferences } from '../stores/sessionPreferencesStore';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../stores/configStore';
import { generatePaneName, sanitizePaneName } from '../utils/paneName';

// Interface for branch information
interface BranchInfo {
  name: string;
  isCurrent: boolean;
  hasWorktree: boolean;
  isRemote: boolean;
}

interface CreateSessionDialogProps {
  onSubmittingChange?: (submitting: boolean) => void;
  header?: React.ReactNode;
  repositoryPicker?: React.ReactNode;
  onBranchDropdownOpenChange?: (open: boolean) => void;
  isOpen: boolean;
  onClose: () => void;
  projectName?: string;
  projectId?: number;
  initialSessionName?: string;
  initialBaseBranch?: string;
  initialFolderId?: string; // Folder to create the new session in
  // Callback called after session is successfully created (for "Discard and Retry" to archive old session)
  onSessionCreated?: () => void;
}

export function CreateSessionDialog(props: CreateSessionDialogProps) {
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  return <Modal isOpen={props.isOpen} onClose={props.onClose} size="lg" closeOnOverlayClick={false} closeOnEscape={!branchDropdownOpen}>
    <CreatePaneForm {...props} onBranchDropdownOpenChange={setBranchDropdownOpen} />
  </Modal>;
}

export function CreatePaneForm({
  onSubmittingChange,
  header,
  repositoryPicker,
  onBranchDropdownOpenChange,
  isOpen,
  onClose,
  projectName,
  projectId,
  initialSessionName,
  initialBaseBranch,
  initialFolderId,
  onSessionCreated
}: CreateSessionDialogProps) {
  const branchListboxId = useId();
  const advancedOptionsId = useId();
  const [sessionName, setSessionName] = useState<string>(initialSessionName || '');
  const [sessionCount, setSessionCount] = useState<number>(1);
  const [formData, setFormData] = useState<CreateSessionRequest>({
    prompt: '',
    worktreeTemplate: '',
    count: 1,
    permissionMode: 'ignore',
    baseBranch: initialBaseBranch
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesProjectId, setBranchesProjectId] = useState<number | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [useWorktree, setUseWorktree] = useState(true);
  const [startPinned, setStartPinned] = useState(false);
  const [addToSession, setAddToSession] = useState(true);
  const openSession = useOrchestrationSessionStore(state => state.sessions.find(session => session.id === state.selectedSessionId && session.archived !== true));
  const sessionViewShowing = useNavigationStore(state => state.activeView === 'pane-chat');
  const targetSession = sessionViewShowing ? openSession : undefined;
  // A Pane that joins a Session is listed under it, so it cannot start pinned.
  const joiningSession = addToSession && targetSession !== undefined;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSessionOptions, setShowSessionOptions] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false);
  const [highlightedBranchIndex, setHighlightedBranchIndex] = useState(0);
  const setBranchDropdownOpen = useCallback((open: boolean) => {
    setIsBranchDropdownOpen(open);
    onBranchDropdownOpenChange?.(open);
  }, [onBranchDropdownOpenChange]);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const branchListRef = useRef<HTMLDivElement>(null);
  const { showError } = useErrorStore();
  const { preferences, loadPreferences, updatePreferences } = useSessionPreferencesStore();
  const existingSessions = useSessionStore(state => state.sessions);
  const keyboardShortcutsEnabled = useConfigStore((state) => areKeyboardShortcutsEnabled(state.config));

  // Load session creation preferences when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadPreferences();
      // Only clear session name if there's no initialSessionName
      if (!initialSessionName) {
        setSessionName('');
      } else {
        setSessionName(initialSessionName);
      }
      setSessionCount(1);
      setAddToSession(true);
      setFormData(prev => ({ ...prev, count: 1, baseBranch: initialBaseBranch }));
    }
  }, [isOpen, loadPreferences, initialSessionName, initialBaseBranch]);

  // Apply loaded preferences to state
  useEffect(() => {
    if (preferences) {
      setShowAdvanced(preferences.showAdvanced);
      setShowSessionOptions(preferences.showSessionOptions ?? false);
      setStartPinned(preferences.startPinned ?? false);
    }
  }, [preferences]);

  // Save preferences when certain settings change
  const savePreferences = useCallback(async (updates: Partial<SessionCreationPreferences>) => {
    await updatePreferences(updates);
  }, [updatePreferences]);

  useEffect(() => {
    if (!isOpen || !projectId) return;

    let cancelled = false;
    // Only branch-derived fields belong to this repository. Keep the user's
    // worktree/count/pinning choices and any name they have typed.
    setBranches([]);
    setBranchesProjectId(null);
    setIsLoadingBranches(true);
    setFormData(current => ({ ...current, baseBranch: initialBaseBranch }));
    setBranchDropdownOpen(false);
    setBranchSearch('');
    setHighlightedBranchIndex(0);
    // First get the project to get its path
    API.projects.getAll().then(projectsResponse => {
      if (!projectsResponse.success || !projectsResponse.data) {
        throw new Error('Failed to fetch projects');
      }
      const project = projectsResponse.data.find((p: Project) => p.id === projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      return Promise.all([
        API.projects.listBranches(projectId.toString()),
        // Get the main branch for this project using its path
        API.projects.detectBranch(project.path)
      ]);
    }).then(([branchesResponse, mainBranchResponse]) => {
      if (cancelled) return;
      if (branchesResponse.success && branchesResponse.data) {
        setBranches(branchesResponse.data);
        setBranchesProjectId(projectId);
      }

      if (mainBranchResponse.success && mainBranchResponse.data) {
        // Main branch detected but not currently used in UI
      }
    }).catch((err: Error) => {
      if (!cancelled) console.error('Failed to fetch branches:', err);
    }).finally(() => {
      if (!cancelled) setIsLoadingBranches(false);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId, initialBaseBranch, setBranchDropdownOpen]);

  useEffect(() => {
    if (!isOpen || branchesProjectId !== projectId || formData.baseBranch || branches.length === 0) return;

    // Prefer a remote main branch for tracking, then fall back to the current branch.
    const remoteMain = branches.find((branch) =>
      branch.isRemote && (branch.name === 'origin/main' || branch.name === 'origin/master')
    );
    const defaultBranch = remoteMain ?? branches.find((branch) => branch.isCurrent);
    if (!defaultBranch) return;

    setFormData((current) => ({ ...current, baseBranch: defaultBranch.name }));
  }, [branches, branchesProjectId, formData.baseBranch, isOpen, projectId]);

  // Filtered branches based on search term
  const filteredBranches = useMemo(() => {
    if (!branchSearch.trim()) return branches;
    const search = branchSearch.toLowerCase();
    return branches.filter(b => b.name.toLowerCase().includes(search));
  }, [branches, branchSearch]);

  // Flat list of filtered branches for keyboard navigation (remote first, then local)
  const flatFilteredBranches = useMemo(() => {
    const remote = filteredBranches.filter(b => b.isRemote);
    const local = filteredBranches.filter(b => !b.isRemote);
    return [...remote, ...local];
  }, [filteredBranches]);

  // Click outside handler for branch dropdown
  useEffect(() => {
    if (!isBranchDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setBranchDropdownOpen(false);
        setBranchSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isBranchDropdownOpen, setBranchDropdownOpen]);

  // Reset branch search state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setBranchDropdownOpen(false);
      setBranchSearch('');
      setHighlightedBranchIndex(0);
    }
  }, [isOpen, setBranchDropdownOpen]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!isBranchDropdownOpen || !branchListRef.current) return;
    const items = branchListRef.current.querySelectorAll('[data-branch-item]');
    const highlighted = items[highlightedBranchIndex];
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedBranchIndex, isBranchDropdownOpen]);

  // Shown as the name placeholder and used when the name field is left empty.
  const suggestedName = useMemo(() => (
    formData.baseBranch
      ? generatePaneName(formData.baseBranch, new Set(existingSessions.map(s => s.name)), branches)
      : ''
  ), [branches, existingSessions, formData.baseBranch]);
  const nameToSubmit = sessionName.trim() || suggestedName;

  const selectBranch = useCallback((branchName: string) => {
    setFormData(prev => ({ ...prev, baseBranch: branchName }));
    savePreferences({ baseBranch: branchName });
    setBranchDropdownOpen(false);
    setBranchSearch('');
    setHighlightedBranchIndex(0);
  }, [savePreferences, setBranchDropdownOpen]);

  const handleBranchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isBranchDropdownOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setBranchDropdownOpen(true);
        return;
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedBranchIndex(prev =>
          prev < flatFilteredBranches.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedBranchIndex(prev => (prev > 0 ? prev - 1 : 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (flatFilteredBranches[highlightedBranchIndex]) {
          selectBranch(flatFilteredBranches[highlightedBranchIndex].name);
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setBranchDropdownOpen(false);
        setBranchSearch('');
        setHighlightedBranchIndex(0);
        break;
    }
  }, [isBranchDropdownOpen, flatFilteredBranches, highlightedBranchIndex, selectBranch, setBranchDropdownOpen]);

  // Add keyboard shortcut handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      // Cmd/Ctrl + Enter to submit
      if (keyboardShortcutsEnabled && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
        const form = document.getElementById('create-session-form') as HTMLFormElement;
        if (form) {
          const submitEvent = new Event('submit', { cancelable: true, bubbles: true });
          form.dispatchEvent(submitEvent);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, keyboardShortcutsEnabled]);

  // Auto-focus name input on dialog open (always available immediately)
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
        const input = document.getElementById('worktreeTemplate') as HTMLInputElement;
        if (input) input.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Block submission while branches are still loading
    if (isSubmitting || isLoadingBranches) return;

    if (!nameToSubmit) {
      showError({
        title: 'Pane Name Required',
        error: 'Please provide a pane name.'
      });
      return;
    }

    // Sanitize the session name before submission
    const cleanedName = sanitizePaneName(nameToSubmit);
    if (!cleanedName.trim()) {
      showError({
        title: 'Invalid Pane Name',
        error: 'Pane name is empty after removing invalid characters.'
      });
      return;
    }

    setIsSubmitting(true);
    onSubmittingChange?.(true);

    try {
      // Determine if we need to create a folder
      // Create folder when: multiple sessions (sessionCount > 1)
      // But NOT if we already have an initialFolderId (from "Discard and Retry")
      const shouldCreateFolder = !initialFolderId && sessionCount > 1;

      // Use initialFolderId if provided, otherwise create folder if needed
      let folderId: string | undefined = initialFolderId;
      if (shouldCreateFolder && projectId) {
        try {
          const folderResponse = await API.folders.create(cleanedName, projectId);
          if (folderResponse.success && folderResponse.data) {
            folderId = folderResponse.data.id;
          }
        } catch (error) {
          console.error('[CreateSessionDialog] Failed to create folder:', error);
          // Continue without folder - sessions will be created at project level
        }
      }

      const response = await API.sessions.create({
        prompt: '',
        worktreeTemplate: cleanedName,
        count: sessionCount,
        toolType: 'none',
        permissionMode: 'ignore',
        projectId,
        folderId,
        isMainRepo: !useWorktree,
        baseBranch: formData.baseBranch,
        startPinned: joiningSession ? undefined : startPinned,
        associateSessionId: joiningSession ? targetSession.id : undefined
      });

      if (!response.success) {
        showError({
          title: 'Failed to Create Pane',
          error: response.error || 'An error occurred while creating the pane.',
          details: response.details,
          command: response.command
        });
        return;
      }

      // Call onSessionCreated callback (e.g., to archive old session in "Discard and Retry")
      if (onSessionCreated) {
        onSessionCreated();
      }

      onClose();
    } catch (error: unknown) {
      console.error('Error creating session:', error);
      const errorMessage = error instanceof Error ? error.message : 'An error occurred while creating the pane.';
      const errorDetails = error instanceof Error ? (error.stack || error.toString()) : String(error);
      showError({
        title: 'Failed to Create Pane',
        error: errorMessage,
        details: errorDetails
      });
    } finally {
      setIsSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  return (
    <>
      {header ?? <ModalHeader title={`New Pane${projectName ? ` in ${projectName}` : ''}`} />}

      <ModalBody className="p-0">
        <div className="flex-1 overflow-y-auto">
          <form id="create-session-form" onSubmit={handleSubmit}>
            {repositoryPicker}
            {/* 1. Base Branch (select first, auto-populates session name) */}
            {isLoadingBranches && branches.length === 0 ? (
              <div className="px-6 pt-6 pb-5 border-b border-border-primary animate-pulse">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-4 h-4 bg-surface-tertiary rounded" />
                  <div className="w-24 h-4 bg-surface-tertiary rounded" />
                </div>
                <div className="w-full h-9 bg-surface-tertiary rounded-md" />
                <div className="w-64 h-3 bg-surface-tertiary rounded mt-2" />
              </div>
            ) : branches.length > 0 ? (
              <div className="px-6 pt-6 pb-5 border-b border-border-primary">
                <div className="flex items-center gap-2 mb-2">
                  <GitBranch className="w-4 h-4 text-text-tertiary" />
                  <label htmlFor="baseBranch" className="text-sm font-medium text-text-primary">
                    Base Branch
                  </label>
                </div>
                <div ref={branchDropdownRef} className="relative">
                  <div
                    className={`flex items-center w-full border rounded-md bg-surface-secondary ${
                      isBranchDropdownOpen
                        ? 'border-interactive ring-2 ring-interactive'
                        : 'border-border-primary'
                    } ${isLoadingBranches ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <Search className="w-4 h-4 text-text-tertiary ml-3 shrink-0" />
                    <input
                      ref={branchInputRef}
                      id="baseBranch"
                      type="text"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={isBranchDropdownOpen}
                      aria-controls={branchListboxId}
                      aria-activedescendant={isBranchDropdownOpen && flatFilteredBranches[highlightedBranchIndex]
                        ? `${branchListboxId}-option-${highlightedBranchIndex}`
                        : undefined}
                      value={isBranchDropdownOpen ? branchSearch : (formData.baseBranch || '')}
                      onChange={(e) => {
                        setBranchSearch(e.target.value);
                        setHighlightedBranchIndex(0);
                        if (!isBranchDropdownOpen) {
                          setBranchDropdownOpen(true);
                        }
                      }}
                      onFocus={() => {
                        setBranchDropdownOpen(true);
                        setBranchSearch('');
                        setHighlightedBranchIndex(0);
                      }}
                      onKeyDown={handleBranchKeyDown}
                      placeholder={isBranchDropdownOpen ? 'Search branches...' : 'Select a branch'}
                      className="w-full px-2 py-2 bg-transparent text-text-primary text-sm focus:outline-none"
                      autoComplete="off"
                      disabled={isLoadingBranches}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={isBranchDropdownOpen ? 'Close branch options' : 'Open branch options'}
                      onClick={() => {
                        setBranchDropdownOpen(!isBranchDropdownOpen);
                        if (!isBranchDropdownOpen) {
                          setBranchSearch('');
                          setHighlightedBranchIndex(0);
                          branchInputRef.current?.focus();
                        }
                      }}
                      className="px-2 py-2 text-text-tertiary hover:text-text-primary shrink-0"
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${isBranchDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>
                  </div>

                  {isBranchDropdownOpen && (
                    <div
                      id={branchListboxId}
                      ref={branchListRef}
                      role="listbox"
                      aria-label="Branches"
                      className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-md border border-border-primary bg-surface-secondary shadow-lg"
                    >
                      {flatFilteredBranches.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-text-tertiary">
                          No branches match &ldquo;{branchSearch}&rdquo;
                        </div>
                      ) : (
                        <>
                          {/* Remote branches group */}
                          {filteredBranches.some(b => b.isRemote) && (
                            <>
                              <div role="presentation" className="px-3 py-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider bg-surface-primary sticky top-0">
                                Remote Branches
                              </div>
                              {filteredBranches.filter(b => b.isRemote).map(branch => {
                                const flatIndex = flatFilteredBranches.indexOf(branch);
                                return (
                                  <div
                                    id={`${branchListboxId}-option-${flatIndex}`}
                                    key={branch.name}
                                    data-branch-item
                                    role="option"
                                    aria-selected={formData.baseBranch === branch.name}
                                    className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-default ${
                                      flatIndex === highlightedBranchIndex
                                        ? 'bg-interactive/10 text-text-primary'
                                        : 'text-text-secondary hover:bg-surface-hover'
                                    }`}
                                    onMouseEnter={() => setHighlightedBranchIndex(flatIndex)}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      selectBranch(branch.name);
                                    }}
                                  >
                                    <GitBranch className="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
                                    <span className="truncate flex-1">{branch.name}</span>
                                    {formData.baseBranch === branch.name && (
                                      <Check className="w-3.5 h-3.5 shrink-0 text-interactive" />
                                    )}
                                  </div>
                                );
                              })}
                            </>
                          )}

                          {/* Local branches group */}
                          {filteredBranches.some(b => !b.isRemote) && (
                            <>
                              <div role="presentation" className="px-3 py-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider bg-surface-primary sticky top-0">
                                Local Branches
                              </div>
                              {filteredBranches.filter(b => !b.isRemote).map(branch => {
                                const flatIndex = flatFilteredBranches.indexOf(branch);
                                return (
                                  <div
                                    id={`${branchListboxId}-option-${flatIndex}`}
                                    key={branch.name}
                                    data-branch-item
                                    role="option"
                                    aria-selected={formData.baseBranch === branch.name}
                                    className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-default ${
                                      flatIndex === highlightedBranchIndex
                                        ? 'bg-interactive/10 text-text-primary'
                                        : 'text-text-secondary hover:bg-surface-hover'
                                    }`}
                                    onMouseEnter={() => setHighlightedBranchIndex(flatIndex)}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      selectBranch(branch.name);
                                    }}
                                  >
                                    <GitBranch className="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
                                    <span className="truncate flex-1">
                                      {branch.name}
                                      {branch.isCurrent && (
                                        <span className="ml-1.5 text-xs text-text-tertiary">(current)</span>
                                      )}
                                      {branch.hasWorktree && (
                                        <span className="ml-1.5 text-xs text-text-tertiary">(has worktree)</span>
                                      )}
                                    </span>
                                    {formData.baseBranch === branch.name && (
                                      <Check className="w-3.5 h-3.5 shrink-0 text-interactive" />
                                    )}
                                  </div>
                                );
                              })}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                <p className="text-xs text-text-tertiary mt-2">
                  Remote branches will automatically track the remote for git pull/push.
                </p>
              </div>
            ) : null}

            {/* 2. Pane Name (empty uses the name suggested from the branch) */}
            <div className="px-6 pt-6 pb-5 border-b border-border-primary">
              <label htmlFor="worktreeTemplate" className="block text-sm font-medium text-text-primary mb-2">
                Pane Name
              </label>
              <Input
                id="worktreeTemplate"
                type="text"
                value={sessionName}
                onChange={(e) => {
                  const value = sanitizePaneName(e.target.value, { trim: false });
                  setSessionName(value);
                  setFormData({ ...formData, worktreeTemplate: value });
                }}
                placeholder={suggestedName || 'Enter a name for your pane'}
                className="w-full"
              />
              {suggestedName && (
                <p className="text-xs text-text-tertiary mt-2">
                  Leave empty to use {suggestedName}.
                </p>
              )}
              {targetSession && (
                <div className="mt-3 flex items-center gap-4 rounded-lg border border-border-primary px-5 py-4">
                  <MessageSquare className="w-4 h-4 text-text-tertiary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium text-text-primary">Add to {targetSession.name}</div>
                    <div className="text-xs text-text-secondary mt-0.5">List this pane under the Session.</div>
                  </div>
                  <Toggle
                    checked={addToSession}
                    aria-label={`Add to ${targetSession.name}`}
                    onChange={setAddToSession}
                    size="sm"
                  />
                </div>
              )}
            </div>

            {/* 3. Advanced Options Toggle */}
            <div className="px-6 py-4">
              <Button
                type="button"
                onClick={() => {
                  const newShowAdvanced = !showAdvanced;
                  setShowAdvanced(newShowAdvanced);
                  savePreferences({ showAdvanced: newShowAdvanced });
                }}
                aria-expanded={showAdvanced}
                aria-controls={advancedOptionsId}
                variant="ghost"
                size="sm"
                className="text-text-secondary hover:text-text-primary"
              >
                {showAdvanced ? <ChevronDown className="w-4 h-4 mr-1" /> : <ChevronRight className="w-4 h-4 mr-1" />}
                Advanced
              </Button>
            </div>

            {/* Advanced Options - Collapsible */}
            {showAdvanced && (
              <div id={advancedOptionsId} className="px-6 pb-6 border-t border-border-primary pt-5">
                <div className="rounded-lg border border-border-primary overflow-hidden divide-y divide-border-primary">
                  {/* Start Pinned Toggle */}
                  <div className="flex items-center gap-4 px-5 py-4">
                    <Pin className="w-4 h-4 text-text-tertiary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary">Start pinned</div>
                      <div className="text-xs text-text-secondary mt-0.5">
                        {joiningSession ? 'Panes in a Session are listed under it.' : 'Show this pane in the pinned section immediately.'}
                      </div>
                    </div>
                    <Toggle
                      checked={startPinned && !joiningSession}
                      disabled={joiningSession}
                      aria-label="Start pinned"
                      onChange={(checked) => {
                        setStartPinned(checked);
                        savePreferences({ startPinned: checked });
                      }}
                      size="sm"
                    />
                  </div>

                  {/* Worktree Toggle */}
                  <div className="flex items-center gap-4 px-5 py-4">
                    <GitFork className="w-4 h-4 text-text-tertiary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary">Use worktree</div>
                      <div className="text-xs text-text-secondary mt-0.5">Run in an isolated git worktree. Disable to run directly in the project directory.</div>
                    </div>
                    <Toggle
                      checked={useWorktree}
                      aria-label="Use worktree"
                      onChange={(checked) => {
                        setUseWorktree(checked);
                        if (!checked) {
                          setSessionCount(1);
                          setFormData(prev => ({ ...prev, count: 1 }));
                          setShowSessionOptions(false);
                        }
                      }}
                      size="sm"
                    />
                  </div>

                  {/* Number of Panes */}
                  {useWorktree && (
                    <div className="flex items-center gap-4 px-5 py-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">Panes: {sessionCount}</span>
                          {!showSessionOptions && sessionCount === 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setShowSessionOptions(true)}
                              className="text-text-tertiary hover:text-text-primary p-0.5"
                              title="Create multiple panes"
                            >
                              <ChevronRight className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                        {sessionCount > 1 && (
                          <div className="text-xs text-text-secondary mt-0.5">Creating multiple panes with numbered suffixes</div>
                        )}
                      </div>
                      {(showSessionOptions || sessionCount > 1) && (
                        <div className="flex items-center gap-2 shrink-0" style={{ width: '140px' }}>
                          <input
                            id="count"
                            type="range"
                            min="1"
                            max="5"
                            value={sessionCount}
                            onChange={(e) => {
                              const count = parseInt(e.target.value) || 1;
                              setSessionCount(count);
                              setFormData(prev => ({ ...prev, count }));
                            }}
                            className="flex-1"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setShowSessionOptions(false);
                              setSessionCount(1);
                              setFormData(prev => ({ ...prev, count: 1 }));
                            }}
                            className="text-text-tertiary hover:text-text-primary p-0.5"
                            title="Reset to 1"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </form>
        </div>
      </ModalBody>

      <ModalFooter>
        <Button
          type="button"
          onClick={onClose}
          variant="ghost"
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          form="create-session-form"
          disabled={isSubmitting || isLoadingBranches || !nameToSubmit}
          loading={isSubmitting}
          title={
            isSubmitting ? 'Creating pane...' :
            !nameToSubmit ? 'Please enter a pane name' :
            undefined
          }
        >
          {isSubmitting ? 'Creating...' : <>{`Create${sessionCount > 1 ? ` ${sessionCount} Panes` : ''}`}<span className="ml-1.5 opacity-60">↵</span></>}
        </Button>
      </ModalFooter>
    </>
  );
}
