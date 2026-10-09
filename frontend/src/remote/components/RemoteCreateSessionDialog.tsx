import { ChevronDown, FolderGit2, GitBranch, GitFork, Pin, Search, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { generatePaneName, sanitizePaneName } from '../../utils/paneName';
import type { RemoteBranchInfo, RemoteProjectWithSessions, RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import { loadStartPinnedPreference, saveStartPinnedPreference } from '../utils/startPinnedPreference';

/**
 * Remote Pane runs as a browser PWA, not inside Electron. Keep create-dialog
 * preferences on browser-safe storage or daemon adapter calls; do not use the
 * desktop session preference store because it writes through window.electronAPI.
 */
const REMOTE_START_PINNED_PREFERENCE_KEY = 'pane.remoteCreateSession.startPinned';
const EMPTY_REMOTE_BRANCHES: RemoteBranchInfo[] = [];

interface RemoteCreateSessionDialogProps {
  adapter: RemoteRuntimeAdapter;
  projects: RemoteProjectWithSessions[];
  initialProject: RemoteProjectWithSessions;
  restoreFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreated: (projectId: number, sessionName: string) => Promise<void>;
}

export function RemoteCreateSessionDialog({
  adapter,
  projects,
  initialProject,
  restoreFocusRef,
  fallbackFocusRef,
  onClose,
  onCreated,
}: RemoteCreateSessionDialogProps) {
  // A snapshot: host refreshes must not reload branches while the person edits.
  const [project, setProject] = useState(initialProject);
  const [loadedBranches, setLoadedBranches] = useState<RemoteBranchInfo[] | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [paneName, setPaneName] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [useWorktree, setUseWorktree] = useState(true);
  const [startPinned, setStartPinned] = useState(() => loadStartPinnedPreference(REMOTE_START_PINNED_PREFERENCE_KEY));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [activeBranchIndex, setActiveBranchIndex] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [userEditedName, setUserEditedName] = useState(false);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const branchListboxId = useId();
  const branchIdPrefix = useId();
  const branchHelpId = useId();
  const nameHelpId = useId();
  const errorId = useId();
  const paneNameInvalid = error === 'Pane name is required.';
  const branches = loadedBranches ?? EMPTY_REMOTE_BRANCHES;
  const loadingBranches = loadedBranches === null;

  const existingNames = useMemo(() => new Set((project.sessions ?? []).map(session => session.name)), [project.sessions]);

  const filteredBranches = useMemo(() => {
    const normalizedSearch = branchSearch.trim().toLowerCase();
    const source = normalizedSearch
      ? branches.filter(branch => branch.name.toLowerCase().includes(normalizedSearch))
      : branches;
    const remote = source.filter(branch => branch.isRemote);
    const local = source.filter(branch => !branch.isRemote);
    return [...remote, ...local];
  }, [branchSearch, branches]);

  const setSelectedBranch = useCallback((branchName: string) => {
    setBaseBranch(branchName);
    setBranchOpen(false);
    setBranchSearch('');
    if (!userEditedName) {
      setPaneName(generatePaneName(branchName, existingNames, branches));
    }
  }, [branches, existingNames, userEditedName]);

  useEffect(() => {
    setActiveBranchIndex(0);
  }, [branchSearch]);

  useEffect(() => {
    if (loadingBranches) {
      setAnnouncement('Loading branches');
    } else if (!error) {
      setAnnouncement(`${branches.length} ${branches.length === 1 ? 'branch' : 'branches'} available`);
    }
  }, [branches.length, error, loadingBranches]);

  useEffect(() => {
    let cancelled = false;

    async function loadBranches() {
      setLoadedBranches(null);
      setError(null);
      try {
        const [branchList, detectedBranch] = await Promise.all([
          adapter.listProjectBranches(project.id),
          adapter.detectProjectBranch(project.path).catch(() => 'main'),
        ]);
        if (cancelled) return;

        setLoadedBranches(branchList);
        const remoteMain = branchList.find(branch => branch.isRemote && (branch.name === 'origin/main' || branch.name === 'origin/master'));
        const detected = branchList.find(branch => branch.name === detectedBranch || branch.name === `origin/${detectedBranch}`);
        const current = branchList.find(branch => branch.isCurrent);
        const fallbackBranchName = remoteMain?.name ?? detected?.name ?? current?.name ?? branchList[0]?.name ?? detectedBranch;

        if (fallbackBranchName) {
          setBaseBranch(fallbackBranchName);
          setPaneName(generatePaneName(fallbackBranchName, existingNames, branchList));
        }
      } catch (loadError) {
        if (!cancelled) {
          setLoadedBranches([]);
          setError(loadError instanceof Error ? loadError.message : 'Failed to load branches');
        }
      }
    }

    void loadBranches();
    return () => {
      cancelled = true;
    };
  }, [adapter, existingNames, project.id, project.path]);

  useEffect(() => {
    if (!branchOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(event.target as Node)) {
        setBranchOpen(false);
        setBranchSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [branchOpen]);

  const handleBranchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!branchOpen) {
        setBranchOpen(true);
        return;
      }
      if (filteredBranches.length === 0) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveBranchIndex(previous => (previous + direction + filteredBranches.length) % filteredBranches.length);
      return;
    }
    if (event.key === 'Home' && branchOpen) {
      event.preventDefault();
      setActiveBranchIndex(0);
      return;
    }
    if (event.key === 'End' && branchOpen) {
      event.preventDefault();
      setActiveBranchIndex(Math.max(0, filteredBranches.length - 1));
      return;
    }
    if (event.key === 'Enter' && branchOpen) {
      const branch = filteredBranches[activeBranchIndex];
      if (branch) {
        event.preventDefault();
        setSelectedBranch(branch.name);
      }
      return;
    }
    if (event.key === 'Escape' && branchOpen) {
      event.preventDefault();
      setBranchOpen(false);
      setBranchSearch('');
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (loadingBranches || submitting) return;

    const cleanedName = sanitizePaneName(paneName);
    if (!cleanedName) {
      setError('Pane name is required.');
      return;
    }
    if (!baseBranch) {
      setError('Base branch is required.');
      return;
    }

    setAnnouncement(`Creating ${cleanedName}`);
    setSubmitting(true);
    setError(null);
    try {
      await adapter.createSession({
        prompt: '',
        worktreeTemplate: cleanedName,
        count: 1,
        toolType: 'none',
        permissionMode: 'ignore',
        projectId: project.id,
        isMainRepo: !useWorktree,
        baseBranch,
        startPinned,
      });
      await onCreated(project.id, cleanedName);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create pane');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="pane-scrim fixed inset-0 z-[70] bg-black/65" />
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => {
              if (document.activeElement?.closest('[aria-modal="true"]')) return;
              const target = restoreFocusRef.current?.isConnected
                ? restoreFocusRef.current
                : fallbackFocusRef?.current;
              if (target?.isConnected) target.focus();
            });
          }}
          onEscapeKeyDown={(event) => {
            if (submitting || branchOpen) event.preventDefault();
          }}
          onPointerDownOutside={(event) => { if (submitting) event.preventDefault(); }}
        >
          <form
            onSubmit={handleSubmit}
            aria-busy={loadingBranches || submitting}
            className="pane-sheet fixed inset-x-0 bottom-0 z-[71] flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl border border-border-primary bg-surface-primary shadow-2xl outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
          >
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
        <div className="flex shrink-0 items-center justify-between border-b border-border-primary px-5 py-4">
          <Dialog.Title asChild>
            <h2 className="min-w-0 truncate text-lg font-semibold text-text-primary">New Pane in {project.name}</h2>
          </Dialog.Title>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ml-3 rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="border-b border-border-primary p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <FolderGit2 className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
              <label htmlFor="remote-create-repository">Repository</label>
            </div>
            <select
              id="remote-create-repository"
              value={project.id}
              disabled={submitting}
              onChange={(event) => {
                const picked = projects.find(candidate => candidate.id === Number(event.target.value));
                if (picked) setProject(picked);
                setUserEditedName(false);
              }}
              className="h-12 w-full rounded-md border border-border-primary bg-surface-secondary px-3 text-sm text-text-primary outline-none focus:border-interactive focus:ring-2 focus:ring-interactive disabled:opacity-60"
            >
              {projects.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </section>

          <section className="border-b border-border-primary p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <GitBranch className="h-4 w-4 text-text-tertiary" aria-hidden="true" />
              <label htmlFor="remote-create-branch">Base Branch</label>
            </div>
            <div ref={branchDropdownRef} className="relative">
              <div className="flex h-12 w-full items-center gap-2 rounded-md border border-border-primary bg-surface-secondary px-3 focus-within:border-interactive focus-within:ring-2 focus-within:ring-interactive">
                <Search className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                <input
                  ref={branchInputRef}
                  id="remote-create-branch"
                  disabled={loadingBranches || branches.length === 0}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={branchOpen}
                  aria-controls={branchOpen ? branchListboxId : undefined}
                  aria-activedescendant={branchOpen && filteredBranches[activeBranchIndex]
                    ? `${branchIdPrefix}-${activeBranchIndex}`
                    : undefined}
                  aria-describedby={branchHelpId}
                  value={branchOpen ? branchSearch : baseBranch}
                  onFocus={() => setBranchOpen(true)}
                  onClick={() => setBranchOpen(true)}
                  onChange={(event) => {
                    setBranchSearch(event.target.value);
                    setBranchOpen(true);
                  }}
                  onKeyDown={handleBranchKeyDown}
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder={loadingBranches ? 'Loading branches...' : 'Search branches'}
                />
                <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
              </div>

              {branchOpen && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-border-primary bg-surface-primary shadow-xl">
                  <div id={branchListboxId} role="listbox" aria-label="Base branches" className="max-h-56 overflow-y-auto py-1">
                    {filteredBranches.map((branch, index) => (
                      <div
                        key={branch.name}
                        id={`${branchIdPrefix}-${index}`}
                        role="option"
                        aria-selected={branch.name === baseBranch}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          setSelectedBranch(branch.name);
                          branchInputRef.current?.focus();
                        }}
                        onPointerMove={() => setActiveBranchIndex(index)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover ${
                          index === activeBranchIndex ? 'bg-surface-hover text-text-primary' : branch.name === baseBranch ? 'text-text-primary' : 'text-text-secondary'
                        }`}
                      >
                        <span className="truncate">{branch.name}</span>
                        {branch.isCurrent && <span className="shrink-0 text-xs text-text-tertiary">current</span>}
                      </div>
                    ))}
                    {filteredBranches.length === 0 && (
                      <div className="px-3 py-3 text-sm text-text-secondary">No branches match.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <p id={branchHelpId} className="mt-2 text-xs text-text-tertiary">Remote branches will track their remote for git pull/push.</p>
          </section>

          <section className="border-b border-border-primary p-5">
            <label htmlFor="remote-create-name" className="mb-2 block text-sm font-semibold text-text-primary">Pane Name</label>
            <input
              id="remote-create-name"
              aria-describedby={`${nameHelpId}${paneNameInvalid ? ` ${errorId}` : ''}`}
              aria-invalid={paneNameInvalid}
              value={paneName}
              onChange={(event) => {
                setPaneName(event.target.value);
                setUserEditedName(true);
              }}
              className="h-12 w-full rounded-md border border-border-primary bg-surface-secondary px-3 text-text-primary outline-none focus:border-interactive focus:ring-2 focus:ring-interactive"
              placeholder="pane-name"
            />
            <p id={nameHelpId} className="mt-2 text-xs text-text-tertiary">Auto-filled from branch. Edit to customize.</p>
          </section>

          <section className="border-b border-border-primary p-5">
            <RemoteStartPinnedToggle
              checked={startPinned}
              description="Show this pane in the pinned section immediately."
              onChange={(checked) => {
                setStartPinned(checked);
                saveStartPinnedPreference(REMOTE_START_PINNED_PREFERENCE_KEY, checked);
              }}
            />
          </section>

          <section className="p-5">
            <label className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 gap-3">
                <GitFork className="mt-1 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-text-primary">Use worktree</span>
                  <span className="mt-1 block text-sm text-text-secondary">Run in an isolated git worktree.</span>
                </span>
              </span>
              <span className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${useWorktree ? 'bg-interactive' : 'bg-surface-tertiary'}`}>
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(event) => setUseWorktree(event.target.checked)}
                  className="peer sr-only"
                  aria-label="Use worktree"
                />
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-text-on-interactive shadow-sm ring-1 ring-border-primary transition-transform ${useWorktree ? 'translate-x-6' : 'translate-x-1'}`} />
              </span>
            </label>
          </section>

          {error && (
            <div id={errorId} role="alert" className="mx-5 mb-5 rounded-md border border-status-error/40 bg-status-error/10 p-3 text-sm text-status-error">
              {error}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border-primary p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loadingBranches || submitting || !baseBranch}
            aria-busy={submitting}
            className="rounded-md bg-interactive px-5 py-2 text-sm font-semibold text-text-on-interactive transition-colors hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Creating...' : 'Create'}
          </button>
        </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function RemoteStartPinnedToggle({ checked, description, onChange }: {
  checked: boolean;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="flex min-w-0 gap-3">
        <Pin className="mt-1 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-text-primary">Start pinned</span>
          <span className="mt-1 block text-sm text-text-secondary">{description}</span>
        </span>
      </span>
      <span className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? 'bg-interactive' : 'bg-surface-tertiary'}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
          aria-label="Start pinned"
        />
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-text-on-interactive shadow-sm ring-1 ring-border-primary transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </span>
    </label>
  );
}
