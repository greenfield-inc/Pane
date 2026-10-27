import { useState, useEffect, useRef } from 'react';
import { API } from '../utils/api';
import { AlertCircle, Star, ExternalLink, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { Modal, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { CloneFromGitHubDialog } from './CloneFromGitHubDialog';
import { capture, type AnalyticsProperties } from '../services/posthog';
import { useNavigationStore } from '../stores/navigationStore';
import { formatTimeAgo } from '../utils/timestampUtils';
import { cn } from '../utils/cn';
import type { FoundRepo, HostRepos, WslRepos } from '../../../shared/types/onboarding';

type OnboardingEnvironmentStatus = 'detecting' | 'git_missing' | 'gh_ready' | 'gh_missing' | 'gh_not_authenticated' | 'gh_missing_scopes' | 'gh_not_ready';

interface EnvironmentInfo {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghReady: boolean;
  ghScopes: string[];
  requiredGhScopes: string[];
  missingGhScopes: string[];
  ghAuthCommand?: string;
  ghInstallUrl: string;
}

interface OnboardingDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SupportPaneDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const GITHUB_CLI_URL = 'https://cli.github.com/';
export const ONBOARDING_REPO_SETUP_PREFERENCE = 'onboarding_repo_setup';
export const ONBOARDING_GH_PROMPT_SHOWN_PREFERENCE = 'onboarding_gh_prompt_shown';
const ONBOARDING_GH_STATUS_AT_FIRST_LAUNCH_PREFERENCE = 'onboarding_gh_status_at_first_launch';
/** Set to OPEN_PROJECT_SCREEN_SEEN when this install showed "Open your project" (never 'true': the test mock answers 'true' to unknown keys). */
const ONBOARDING_OPEN_PROJECT_SCREEN_PREFERENCE = 'onboarding_open_project_screen';
const OPEN_PROJECT_SCREEN_SEEN = 'seen';

function fallbackEnvironment(): EnvironmentInfo {
  return {
    gitInstalled: false,
    ghInstalled: false,
    ghAuthenticated: false,
    ghReady: false,
    ghScopes: [],
    requiredGhScopes: ['user'],
    missingGhScopes: ['user'],
    ghInstallUrl: GITHUB_CLI_URL,
  };
}

function normalizeEnvironment(value: Partial<EnvironmentInfo> | null | undefined): EnvironmentInfo {
  const fallback = fallbackEnvironment();
  return {
    ...fallback,
    ...value,
    ghScopes: Array.isArray(value?.ghScopes) ? value.ghScopes : fallback.ghScopes,
    requiredGhScopes: Array.isArray(value?.requiredGhScopes) ? value.requiredGhScopes : fallback.requiredGhScopes,
    missingGhScopes: Array.isArray(value?.missingGhScopes) ? value.missingGhScopes : fallback.missingGhScopes,
    ghInstallUrl: value?.ghInstallUrl || fallback.ghInstallUrl,
  };
}

function getEnvironmentStatus(env: EnvironmentInfo | null): OnboardingEnvironmentStatus {
  if (!env) return 'detecting';
  if (!env.gitInstalled) return 'git_missing';
  if (env.ghReady) return 'gh_ready';
  if (!env.ghInstalled) return 'gh_missing';
  if (!env.ghAuthenticated) return 'gh_not_authenticated';
  if (env.missingGhScopes.length > 0) return 'gh_missing_scopes';
  return 'gh_not_ready';
}

async function getPreference(key: string): Promise<string | null> {
  if (!window.electronAPI?.preferences) return null;
  return API.preferences.get(key);
}

async function setPreference(key: string, value: string): Promise<void> {
  if (window.electronAPI?.preferences) await API.preferences.set(key, value);
}

async function markOnboardingComplete(): Promise<void> {
  try {
    await setPreference(ONBOARDING_REPO_SETUP_PREFERENCE, 'true');
  } catch {
    // Close even if the preference write fails.
  }
}

async function recordFirstLaunchEnvironmentStatus(status: OnboardingEnvironmentStatus): Promise<void> {
  const existing = await getPreference(ONBOARDING_GH_STATUS_AT_FIRST_LAUNCH_PREFERENCE);
  if (existing) return;
  await setPreference(ONBOARDING_GH_STATUS_AT_FIRST_LAUNCH_PREFERENCE, status);
}

function SupportExplainer() {
  return (
    <div className="space-y-1">
      <p className="text-sm font-semibold text-text-primary">Support Pane with a star and follow</p>
      <p className="text-xs leading-relaxed text-text-secondary">
        Pane is built by Parsa, a self-funded developer. A GitHub star for Pane and a follow are the easiest free way to support the project so it can keep growing.
      </p>
    </div>
  );
}

export function SupportPaneDialog({ isOpen, onClose }: SupportPaneDialogProps) {
  const paneLogo = usePaneLogo();
  const [isSupporting, setIsSupporting] = useState(false);

  const handleSupport = async () => {
    setIsSupporting(true);
    try {
      const supportResult = await window.electronAPI.onboarding.supportProject();
      if (supportResult?.success) {
        capture('onboarding_project_supported_after_setup');
      }
    } catch {
      // Support failure is non-fatal and should not keep nagging.
    } finally {
      setIsSupporting(false);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      ariaLabel="Support Pane"
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      closeOnOverlayClick
      closeOnEscape
      showCloseButton
    >
      <div className="p-6 border-b border-border-primary">
        <div className="flex items-center">
          <img src={paneLogo} alt="Pane" className="h-10 w-10 mr-3" />
          <h1 className="text-lg font-semibold text-text-primary">Support Pane</h1>
        </div>
      </div>
      <ModalBody>
        <div className="flex items-start gap-3">
          <Star className="h-6 w-6 text-interactive flex-shrink-0 mt-0.5" />
          <SupportExplainer />
        </div>
      </ModalBody>
      <ModalFooter className="flex justify-end gap-2">
        <Button onClick={onClose} variant="ghost">
          Not now
        </Button>
        <Button
          onClick={handleSupport}
          variant="primary"
          icon={<Star className="h-4 w-4" />}
          loading={isSupporting}
          loadingText="Supporting"
        >
          Star and follow
        </Button>
      </ModalFooter>
    </Modal>
  );
}


type OnboardingEntry = 'found_repo' | 'chosen_folder' | 'github_clone' | 'sample_repo';
type WslState = { status: 'loading' } | { status: 'ready'; result: WslRepos } | { status: 'unavailable' };
type SampleState = { status: 'idle' } | { status: 'running' } | { status: 'failed'; reason: string };

const NO_HOST_REPOS: HostRepos = { repos: [], shells: [], wslDistro: null };
const NOT_A_REPO = "That folder isn't a Git repo. Choose a repo folder. To start a new repo, skip this and use Add repository.";

async function detectEnvironmentInfo(): Promise<EnvironmentInfo> {
  try {
    const result = await window.electronAPI.onboarding.detectEnvironment();
    // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
    return result.success && result.data ? normalizeEnvironment(result.data as Partial<EnvironmentInfo>) : fallbackEnvironment();
  } catch {
    return fallbackEnvironment();
  }
}

function isWslPath(value: string): boolean {
  return /^\\\\wsl(\.localhost|\$)\\/i.test(value);
}

function parentFolder(displayPath: string): string {
  const index = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'));
  return index > 0 ? displayPath.slice(0, index) : displayPath;
}

function newestRepo(repos: FoundRepo[]): FoundRepo | undefined {
  return repos.reduce<FoundRepo | undefined>((best, repo) => (!best || (repo.lastCommitAt ?? -1) > (best.lastCommitAt ?? -1) ? repo : best), undefined);
}

function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function reasonText(reason: string | undefined, fallback: string): string {
  return (reason || fallback).trim().replace(/\.+$/, '');
}

interface RepoListProps {
  /** null while loading. */
  repos: FoundRepo[] | null;
  /** Shown in place of the rows when nothing was found or the source failed. */
  emptyText: string;
  compact?: boolean;
  label: string;
  selectedPath: string | undefined;
  disabled: boolean;
  onSelect: (repo: FoundRepo) => void;
  onOpen: (repo: FoundRepo) => void;
}

/**
 * Up to five rows. It keeps three rows' height (two in a WSL column) so
 * loading, empty and short lists match.
 */
function RepoList({ repos, emptyText, compact, label, selectedPath, disabled, onSelect, onOpen }: RepoListProps) {
  const minHeight = compact ? 'min-h-[78px]' : 'min-h-[120px]';
  if (repos === null) {
    return (
      <div className={cn(minHeight, 'space-y-1.5')} aria-busy="true" aria-label={label}>
        {(compact ? ['w-[60%]', 'w-[48%]'] : ['w-[60%]', 'w-[48%]', 'w-[55%]']).map(width => (
          <div key={width} className="flex h-9 items-center rounded-lg border border-border-secondary bg-surface-secondary px-3">
            <span className={cn('h-2.5 animate-pulse rounded bg-surface-tertiary', width)} />
          </div>
        ))}
      </div>
    );
  }

  if (repos.length === 0) {
    return <p className={cn(minHeight, 'py-2 text-sm text-text-tertiary')}>{emptyText}</p>;
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn(minHeight, 'space-y-1.5')}>
      {repos.map((repo, index) => {
        const selected = repo.path === selectedPath;
        // One Tab stop per list (the selected row, else the first); arrows move the selection.
        const tabStop = selected || (index === 0 && !repos.some(other => other.path === selectedPath));
        const lastCommit = repo.lastCommitAt === null ? '' : formatTimeAgo(new Date(repo.lastCommitAt).toISOString());
        return (
          <button
            key={repo.path}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            tabIndex={tabStop ? 0 : -1}
            onClick={() => onSelect(repo)}
            onDoubleClick={() => onOpen(repo)}
            onKeyDown={(event) => {
              const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
              if (!step) return;
              event.preventDefault();
              const next = (index + step + repos.length) % repos.length;
              onSelect(repos[next]);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}
            className={cn(
              'flex h-9 w-full items-center gap-2.5 rounded-lg border bg-surface-secondary px-3 text-left text-sm transition-colors disabled:cursor-default',
              selected ? 'border-interactive ring-1 ring-interactive' : 'border-border-secondary hover:bg-surface-hover',
            )}
          >
            <Folder className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
            <span className="min-w-0 max-w-[50%] truncate font-medium text-text-primary">{repo.name}</span>
            {!compact && <span className="min-w-0 truncate text-text-tertiary">{repo.displayPath}</span>}
            <span className="ml-auto min-w-0 max-w-[45%] truncate pl-2 text-xs text-text-tertiary">
              {compact ? parentFolder(repo.displayPath) : [repo.branch, lastCommit].filter(Boolean).join(' · ')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RepoColumn({ title, footnote, ...list }: RepoListProps & { title: string; footnote: string | null }) {
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{title}</h3>
      <RepoList {...list} compact />
      {footnote && <p className="text-xs text-text-tertiary">{footnote}</p>}
    </div>
  );
}

/**
 * First-run "Open your project": lists the user's repos (with a WSL column on
 * Windows when a default distro exists) and lands them in the one they pick.
 */
export default function OnboardingDialog({ isOpen, onClose }: OnboardingDialogProps) {
  const paneLogo = usePaneLogo();
  const navigateToProject = useNavigationStore(s => s.navigateToProject);
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [host, setHost] = useState<HostRepos | null>(null);
  const [wsl, setWsl] = useState<WslState | null>(null);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [isCloning, setIsCloning] = useState(false);
  const [sample, setSample] = useState<SampleState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  // Set once the dialog is done, so a sample setup that outlives a Skip doesn't navigate.
  const closedRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    closedRef.current = false;
    let cancelled = false;
    void setPreference(ONBOARDING_OPEN_PROJECT_SCREEN_PREFERENCE, OPEN_PROJECT_SCREEN_SEEN);

    void detectEnvironmentInfo().then((nextEnv) => {
      if (cancelled) return;
      setEnv(nextEnv);
      const status = getEnvironmentStatus(nextEnv);
      capture('onboarding_started', { gh_status_at_first_launch: status });
      void recordFirstLaunchEnvironmentStatus(status);
    });

    const findRepos = async () => {
      let found = NO_HOST_REPOS;
      try {
        const result = await window.electronAPI.onboarding.findRepos();
        if (result.success && result.data) found = result.data;
      } catch {
        // Nothing found: the dialog offers a folder, GitHub and the sample.
      }
      if (cancelled) return;
      setHost(found);
      if (!found.wslDistro) return;

      setWsl({ status: 'loading' });
      let next: WslState = { status: 'unavailable' };
      try {
        const result = await window.electronAPI.onboarding.findWslRepos(found.wslDistro);
        if (result.success && result.data) next = { status: 'ready', result: result.data };
      } catch {
        // Shown as the column's unavailable state.
      }
      if (!cancelled) setWsl(next);
    };
    void findRepos();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const wslDistro = host?.wslDistro ?? null;
  const wslRepos = wsl?.status === 'ready' ? wsl.result.repos : [];
  const allRepos = [...(host?.repos ?? []), ...wslRepos];
  // Until the WSL column answers, nothing is preselected, so the pick can't jump under the cursor.
  const awaitingWsl = wsl?.status === 'loading';
  const selected = allRepos.find(repo => repo.path === pickedPath) ?? (awaitingWsl ? undefined : newestRepo(allRepos));
  const isLoading = host === null || awaitingWsl;
  const nothingFound = !isLoading && allRepos.length === 0;
  const gitMissing = env !== null && !env.gitInstalled;
  const isBusy = isOpening || sample.status === 'running';

  const complete = async (properties: AnalyticsProperties & { entry: OnboardingEntry; wsl: boolean }) => {
    closedRef.current = true;
    await markOnboardingComplete();
    capture('onboarding_completed', properties);
    onClose();
  };

  const openProject = async (projectId: number, properties: AnalyticsProperties & { entry: OnboardingEntry; wsl: boolean }) => {
    window.dispatchEvent(new Event('project-changed'));
    navigateToProject(projectId);
    await complete(properties);
  };

  const addProject = async (name: string, path: string, properties: AnalyticsProperties & { entry: OnboardingEntry; wsl: boolean }) => {
    setIsOpening(true);
    setError(null);
    try {
      const response = await API.projects.create({ name, path, active: false });
      if (response.success && response.data) {
        await openProject(response.data.id, properties);
        return;
      }
      setError(`Couldn't open ${name}: ${reasonText(response.error, 'Pane could not add the project')}.`);
    } catch (cause) {
      setError(`Couldn't open ${name}: ${reasonText(cause instanceof Error ? cause.message : undefined, 'Pane could not add the project')}.`);
    } finally {
      setIsOpening(false);
    }
  };

  const openRepo = (repo: FoundRepo) => {
    if (isBusy) return;
    void addProject(repo.name, repo.path, { entry: 'found_repo', repo_source: repo.source, wsl: isWslPath(repo.path) });
  };

  const chooseFolder = async () => {
    setError(null);
    let folder: { name: string; path: string };
    try {
      const picked = await window.electronAPI.dialog.openDirectory();
      if (!picked.success || !picked.data) return;
      setIsOpening(true);
      const checked = await window.electronAPI.onboarding.checkFolder(picked.data);
      if (!checked.success || !checked.data) {
        setError(checked.error ?? NOT_A_REPO);
        return;
      }
      folder = checked.data;
    } catch (cause) {
      setError(`Couldn't open that folder: ${reasonText(cause instanceof Error ? cause.message : undefined, 'Pane could not read it')}.`);
      return;
    } finally {
      setIsOpening(false);
    }
    await addProject(folder.name, folder.path, { entry: 'chosen_folder', wsl: isWslPath(folder.path) });
  };

  const setUpSample = async () => {
    setError(null);
    setSample({ status: 'running' });
    let failure = '';
    try {
      const result = await window.electronAPI.onboarding.setupDefaultRepo();
      if (closedRef.current) {
        // Skipped during setup: the project still appears, nothing navigates.
        if (result.success) window.dispatchEvent(new Event('project-changed'));
        return;
      }
      if (result.success && result.data) {
        await openProject(result.data.projectId, { entry: 'sample_repo', wsl: false, was_already_cloned: result.data.wasAlreadyCloned });
        return;
      }
      failure = reasonText(result.error, 'setup failed');
    } catch (cause) {
      failure = reasonText(cause instanceof Error ? cause.message : undefined, 'setup failed');
    }
    if (!closedRef.current) setSample({ status: 'failed', reason: failure });
  };

  const handleSkip = async () => {
    capture('onboarding_skipped', { step: env ? getEnvironmentStatus(env) : 'detecting' });
    closedRef.current = true;
    await markOnboardingComplete();
    onClose();
  };

  if (!isOpen) return null;

  if (isCloning) {
    return (
      <CloneFromGitHubDialog
        isOpen
        // After a clone the onboarding dialog closes itself, so the picker never shows again.
        onClose={() => { if (!closedRef.current) setIsCloning(false); }}
        onCloned={(_projectId, clonedPath) => void complete({ entry: 'github_clone', wsl: isWslPath(clonedPath) })}
      />
    );
  }

  const listProps = {
    selectedPath: selected?.path,
    disabled: isBusy,
    onSelect: (repo: FoundRepo) => setPickedPath(repo.path),
    onOpen: openRepo,
  };
  const wslFootnote = wsl?.status === 'ready' && wsl.result.agents.length > 0
    ? `Agents run inside WSL. ${joinNames(wsl.result.agents)} found.`
    : 'Agents run inside WSL.';

  return (
    <Modal
      ariaLabel="Open your project"
      isOpen={isOpen}
      onClose={() => {}}
      size={wslDistro ? 'lg' : 'md'}
      initialFocusRef={titleRef}
      closeOnOverlayClick={false}
      closeOnEscape={false}
      showCloseButton={false}
    >
      <div className="p-6 border-b border-border-primary">
        <div className="flex items-center">
          <img src={paneLogo} alt="Pane" className="h-10 w-10 mr-3" />
          <h1 ref={titleRef} tabIndex={-1} className="text-lg font-semibold text-text-primary outline-none">Open your project</h1>
        </div>
      </div>

      <ModalBody>
        {gitMissing ? (
          <div className="flex items-start gap-3">
            <AlertCircle className="h-6 w-6 text-status-warning flex-shrink-0 mt-0.5" />
            <div className="space-y-2">
              <p className="text-text-primary font-medium">Git Required</p>
              <p className="text-text-secondary text-sm">
                Git is required to use Pane. Please install Git and restart the application.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {wslDistro
                ? 'Where does your code live? Pane runs agents in the same place.'
                : 'Pick the repo you want agents to work on. Each task gets its own copy (a worktree), so your branch stays untouched.'}
            </p>

            {wslDistro ? (
              <div className="grid grid-cols-2 gap-4">
                <RepoColumn
                  {...listProps}
                  title="Windows"
                  label="Windows repos"
                  repos={host?.repos ?? null}
                  emptyText="No Git repos found in your usual code folders."
                  footnote={host && host.shells.length > 0 ? `Shell: ${host.shells.join(' · ')}` : null}
                />
                <RepoColumn
                  {...listProps}
                  title={`WSL · ${wslDistro}`}
                  label={`WSL ${wslDistro} repos`}
                  repos={wsl?.status === 'ready' ? wsl.result.repos : wsl?.status === 'unavailable' ? [] : null}
                  emptyText={wsl?.status === 'unavailable' ? "Couldn't read WSL in time. Choose a folder instead." : 'No Git repos found in your usual code folders.'}
                  footnote={wsl?.status === 'unavailable' ? null : wslFootnote}
                />
              </div>
            ) : (
              <RepoList
                {...listProps}
                label="Your repos"
                repos={host?.repos ?? null}
                emptyText="No Git repos found in your usual code folders."
              />
            )}

            {error && <p role="alert" className="text-sm text-status-error">{error}</p>}

            <div className="flex flex-wrap gap-2">
              {!nothingFound && (
                <Button variant="secondary" size="sm" icon={<FolderOpen className="h-4 w-4" />} disabled={isBusy} onClick={() => void chooseFolder()}>
                  Choose another folder…
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => setIsCloning(true)}>
                Clone from GitHub
              </Button>
            </div>

            {sample.status === 'running' ? (
              <p className="flex items-center gap-2 text-xs text-text-tertiary" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Setting up the sample repo…
              </p>
            ) : sample.status === 'failed' ? (
              <div className="flex items-center gap-3 text-xs text-status-error" role="alert">
                <span>Couldn&apos;t set up the sample repo: {sample.reason}. Check your connection and try again.</span>
                <Button variant="secondary" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => void setUpSample()}>Try again</Button>
              </div>
            ) : (
              <p className="text-xs text-text-tertiary">
                No project handy?{' '}
                <button type="button" className="text-interactive hover:underline disabled:opacity-50" disabled={isBusy} onClick={() => void setUpSample()}>
                  Try Pane on a sample repo
                </button>
              </p>
            )}
          </div>
        )}
      </ModalBody>

      <ModalFooter className="flex justify-between items-center">
        <Button onClick={() => void handleSkip()} variant="ghost" disabled={isOpening}>Skip</Button>
        {gitMissing ? (
          <Button onClick={() => window.electronAPI.openExternal('https://git-scm.com/downloads')} variant="primary" icon={<ExternalLink className="h-4 w-4" />}>
            Install Git
          </Button>
        ) : nothingFound ? (
          <Button variant="primary" icon={<FolderOpen className="h-4 w-4" />} disabled={isBusy} onClick={() => void chooseFolder()}>
            Choose a folder…
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!selected || isBusy}
            loading={isOpening}
            loadingText={selected ? `Open ${selected.name}` : 'Open'}
            onClick={() => selected && openRepo(selected)}
          >
            <span className="block max-w-[16rem] truncate">{selected ? `Open ${selected.name}` : 'Open'}</span>
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
