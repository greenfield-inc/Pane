import { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronUp, Terminal, X } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { API } from '../utils/api';
import { Dropdown } from './ui/Dropdown';
import { Badge } from './ui/Badge';
import { Toggle } from './ui/Toggle';
import { AddProjectDialog } from './AddProjectDialog';
import { CloneFromGitHubDialog } from './CloneFromGitHubDialog';
import { formatDistanceToNow, isValidTimestamp } from '../utils/timestampUtils';
import { getThemeLabel, themeOptionsForSlot } from '../utils/themeOptions';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import { capture } from '../services/posthog';
import { DISCORD_INVITE_URL, DiscordIcon } from './DiscordIcon';

const HIDE_DISCORD_PREFERENCE = 'hide_discord';

const actionCardClassName =
  'flex min-h-[9.2rem] min-w-0 w-full flex-col items-center justify-center gap-3 rounded-xl bg-surface-secondary p-6 text-center transition-colors hover:bg-surface-hover cursor-pointer';

const paneAscii = String.raw`
░█████████                                    
░██     ░██                                   
░██     ░██  ░██████   ░████████   ░███████   
░█████████        ░██  ░██    ░██ ░██    ░██  
░██          ░███████  ░██    ░██ ░█████████  
░██         ░██   ░██  ░██    ░██ ░██         
░██          ░█████░██ ░██    ░██  ░███████   
`;

function FolderOpenIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1" />
      <path d="M20.5 16.5L21 12h-6l-.5 4.5" />
      <path d="M3 12h18l-1.5 7H4.5L3 12z" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function getStatusVariant(
  status: Session['status'],
): 'success' | 'warning' | 'error' | 'info' | 'default' {
  switch (status) {
    case 'running':
      return 'success';
    case 'error':
      return 'error';
    case 'initializing':
      return 'info';
    case 'stopped':
    case 'ready':
    default:
      return 'default';
  }
}

function getStatusLabel(status: Session['status']): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'error':
      return 'Error';
    case 'initializing':
      return 'Initializing';
    case 'stopped':
      return 'Stopped';
    case 'ready':
      return 'Ready';
    default:
      return status;
  }
}

function getRepositoryName(project: Project): string {
  const normalizedPath = project.path.replace(/[\\/]+$/, '');
  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || project.name;
}

function getProjectSecondaryLabel(project: Project): string {
  const repoName = getRepositoryName(project);
  return project.name !== repoName ? `${project.name} · ${project.path}` : project.path;
}

function OpenProjectCard({
  projects,
  onAddProject,
}: {
  projects: Project[];
  onAddProject: () => void;
}) {
  const navigateToProject = useNavigationStore(s => s.navigateToProject);

  return (
    <Dropdown
      trigger={
        <button type="button" className={actionCardClassName}>
          <FolderOpenIcon className="w-8 h-8 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">Open Project</span>
        </button>
      }
      items={projects.map(project => ({
        id: String(project.id),
        label: (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{getRepositoryName(project)}</div>
            <div className="truncate text-xs text-text-tertiary">
              {getProjectSecondaryLabel(project)}
            </div>
          </div>
        ),
        onClick: () => {
          API.projects.activate(String(project.id)).catch(() => {});
          navigateToProject(project.id);
        },
      }))}
      footer={({ close }) => (
        <button
          type="button"
          onClick={() => {
            close();
            onAddProject();
          }}
          className="w-full rounded-sm px-3 py-2.5 text-left text-sm text-interactive transition-colors hover:bg-surface-hover"
        >
          + Add Repository
        </button>
      )}
      position="bottom-left"
      width="lg"
    />
  );
}

function DiscordBanner() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void API.preferences.get(HIDE_DISCORD_PREFERENCE)
      .then((value) => {
        if (!cancelled) setIsVisible(value !== 'true');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => {
    setIsVisible(false);
    void API.preferences.set(HIDE_DISCORD_PREFERENCE, 'true').catch(() => setIsVisible(true));
  }, []);

  const handleJoin = useCallback(async () => {
    capture('discord_clicked', { source: 'home_banner' });
    try {
      const result = await window.electronAPI.openExternal(DISCORD_INVITE_URL);
      if (result.success) dismiss();
    } catch {
      // Keep the invitation available so the user can retry.
    }
  }, [dismiss]);

  if (!isVisible) return null;

  return (
    <div
      role="region"
      aria-label="Pane Discord community"
      className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-lg border border-border-secondary bg-surface-primary px-3 py-2 text-sm shadow-sm"
    >
      <DiscordIcon className="h-4 w-4 flex-shrink-0 text-discord" />
      <span className="min-w-0 flex-1 truncate text-text-secondary">Join the Pane community on Discord.</span>
      <button
        type="button"
        onClick={() => void handleJoin()}
        className="flex-shrink-0 rounded-md bg-discord px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-discord-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
      >
        Join
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss Discord invitation"
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function HomePage() {
  const { theme, appearance, activeSystemSlot, setTheme } = useTheme();
  const homeThemeOptions = themeOptionsForSlot(appearance.appearanceMode === 'fixed' ? 'any' : activeSystemSlot ?? 'light');
  const { config, updateConfig } = useConfigStore();
  const sessions = useSessionStore(state => state.sessions);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const navigateToSessions = useNavigationStore(s => s.navigateToSessions);

  const [projects, setProjects] = useState<Project[]>([]);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [platform, setPlatform] = useState<string>('');
  const [availableShells, setAvailableShells] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [preferredShell, setPreferredShell] = useState<string>('auto');

  const uiScale = config?.uiScale ?? 1.0;

  const loadProjects = useCallback(async () => {
    try {
      const result = await API.projects.getAll();
      if (result.success && result.data) {
        // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
        setProjects(result.data as Project[]);
      }
    } catch {
      // Ignore transient IPC failures on home page
    }
  }, []);

  useEffect(() => {
    void window.electronAPI
      .getPlatform()
      .then(async currentPlatform => {
        setPlatform(currentPlatform);
        if (currentPlatform === 'win32') {
          const shellsResponse = await API.config.getAvailableShells();
          if (shellsResponse.success) {
            setAvailableShells(shellsResponse.data);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (config?.preferredShell) {
      setPreferredShell(config.preferredShell);
    }
  }, [config?.preferredShell]);

  useEffect(() => {
    void loadProjects();
    const handler = () => void loadProjects();
    window.addEventListener('project-changed', handler);
    window.addEventListener('project-sessions-refresh', handler);
    return () => {
      window.removeEventListener('project-changed', handler);
      window.removeEventListener('project-sessions-refresh', handler);
    };
  }, [loadProjects]);

  const recentSessions = useMemo(() => {
    return sessions
      .filter((s): s is Session & { lastActivity: string } => !s.archived && isValidTimestamp(s.lastActivity))
      .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime())
      .slice(0, 8);
  }, [sessions]);

  const projectNameMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const project of projects) {
      map.set(project.id, getRepositoryName(project));
    }
    return map;
  }, [projects]);

  const handleOpenSession = (session: Session) => {
    navigateToSessions();
    setActiveSession(session.id).catch(() => {});
  };

  const handleScaleChange = async (delta: number) => {
    const newScale = Math.round((uiScale + delta) * 10) / 10;
    if (newScale >= 0.8 && newScale <= 1.5) {
      await updateConfig({ uiScale: newScale }).catch(() => {});
    }
  };

  const handleShellChange = async (shell: string) => {
    setPreferredShell(shell);
    await updateConfig({
      // SAFETY: The value comes from the adjacent finite domain definition.
      preferredShell: shell as 'auto' | 'gitbash' | 'powershell' | 'pwsh' | 'cmd',
    }).catch(() => {});
  };

  return (
    <div className="flex-1 overflow-y-auto bg-bg-primary px-8 py-10">
      <div className="flex min-h-full items-center">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
          <DiscordBanner />
          <div className="flex justify-start pl-6">
            <pre className="max-w-full overflow-hidden whitespace-pre text-left font-mono text-[10px] leading-[0.95] tracking-tight text-text-tertiary sm:text-[11px]">
              {paneAscii}
            </pre>
          </div>
          <section className="grid gap-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)] lg:items-stretch">
            <div className="space-y-5 rounded-2xl border border-border-secondary bg-surface-primary/70 p-6 shadow-sm">
            <div>
              <h2 className="mb-2 text-lg font-semibold text-text-primary">Get Started</h2>
              <p className="text-sm text-text-tertiary">
                Open a project, create a new one, or clone from GitHub.
              </p>
            </div>
            <div className="grid justify-center gap-4 sm:grid-cols-3">
              <OpenProjectCard
                projects={projects}
                onAddProject={() => setShowAddProject(true)}
              />
              <button
                type="button"
                onClick={() => setShowAddProject(true)}
                className={actionCardClassName}
              >
                <PlusIcon className="w-8 h-8 text-text-secondary" />
                <span className="text-sm font-medium text-text-primary">New Project</span>
              </button>
              <button
                type="button"
                onClick={() => setShowCloneDialog(true)}
                className={actionCardClassName}
              >
                <GitHubIcon className="w-8 h-8 text-text-secondary" />
                <span className="text-sm font-medium text-text-primary">GitHub</span>
              </button>
            </div>
            </div>

            <section className="space-y-4 rounded-2xl border border-border-secondary bg-surface-primary/70 p-6 shadow-sm">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Preferences</h2>
                <p className="mt-2 text-sm text-text-tertiary">Make Pane your own</p>
              </div>

            <div className="flex items-center justify-between rounded-lg bg-surface-secondary p-4">
              <span className="text-text-primary">Theme</span>
              <Dropdown
                trigger={
                  <button
                    type="button"
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border-secondary bg-surface-tertiary px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive"
                  >
                    <span>{getThemeLabel(theme)}</span>
                    <ChevronDown className="w-3 h-3 text-text-tertiary" />
                  </button>
                }
                items={homeThemeOptions.map((option) => ({
                  id: option.id,
                  label: option.label,
                  description: option.description,
                  onClick: () => { void setTheme(option.id).catch((error) => console.error('[HomePage] theme change failed', error)); },
                }))}
                selectedId={theme}
                position="bottom-right"
                width="lg"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg bg-surface-secondary p-4">
              <span className="text-text-primary">UI Scale</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Decrease UI scale"
                  onClick={() => void handleScaleChange(-0.1)}
                  disabled={uiScale <= 0.8}
                  className="rounded-md bg-surface-tertiary p-1 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
                <span className="w-10 text-center text-sm text-text-secondary">{uiScale.toFixed(1)}x</span>
                <button
                  type="button"
                  aria-label="Increase UI scale"
                  onClick={() => void handleScaleChange(0.1)}
                  disabled={uiScale >= 1.5}
                  className="rounded-md bg-surface-tertiary p-1 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronUp className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div
              className="flex items-center justify-between rounded-lg bg-surface-secondary p-4"
              title="Prevents the system from idle-sleeping while any session is active. The display can still turn off; closing the lid or choosing Sleep still sleeps the machine."
            >
              <span className="text-text-primary">Keep Awake</span>
              <Toggle
                checked={config?.keepAwakeWhileSessionsActive !== false}
                aria-label="Keep computer awake while sessions are active"
                onChange={(value) => void updateConfig({ keepAwakeWhileSessionsActive: value }).catch(() => {})}
              />
            </div>

            {platform === 'win32' && (
              <div className="flex items-center justify-between rounded-lg bg-surface-secondary p-4">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-text-secondary" />
                  <span className="text-text-primary">Terminal Shell</span>
                </div>
                <Dropdown
                  trigger={
                    <button
                      type="button"
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-border-secondary bg-surface-tertiary px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive"
                    >
                      <span>
                        {preferredShell === 'auto'
                          ? 'Auto (Git Bash)'
                          : availableShells.find(shell => shell.id === preferredShell)?.name ?? preferredShell}
                      </span>
                      <ChevronDown className="w-3 h-3 text-text-tertiary" />
                    </button>
                  }
                  items={[
                    { id: 'auto', label: 'Auto (Git Bash)', onClick: () => void handleShellChange('auto') },
                    ...availableShells.map(shell => ({
                      id: shell.id,
                      label: shell.name,
                      onClick: () => void handleShellChange(shell.id),
                    })),
                  ]}
                  selectedId={preferredShell}
                  position="bottom-right"
                  width="sm"
                />
              </div>
            )}
            </section>
          </section>

          {recentSessions.length > 0 && (
            <section className="rounded-2xl border border-border-secondary bg-surface-primary/70 p-6 shadow-sm">
              <h2 className="mb-4 text-lg font-semibold text-text-primary">Recent Panes</h2>
              <div className="space-y-1">
                {recentSessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleOpenSession(session)}
                    className="flex w-full items-center justify-between gap-4 rounded-lg bg-surface-secondary px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-text-primary">
                        {session.name}
                      </span>
                      {session.projectId != null && projectNameMap.has(session.projectId) && (
                        <span className="block truncate text-xs text-text-tertiary">
                          {projectNameMap.get(session.projectId)}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {session.status !== 'stopped' && session.status !== 'ready' && (
                        <Badge variant={getStatusVariant(session.status)} size="sm">
                          {getStatusLabel(session.status)}
                        </Badge>
                      )}
                      <span className="whitespace-nowrap text-xs text-text-tertiary">
                        {formatDistanceToNow(session.lastActivity)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {recentSessions.length === 0 && projects.length === 0 && (
            <p className="text-center text-sm text-text-tertiary">
              Select a project from the sidebar or create a new one to get started.
            </p>
          )}
        </div>
      </div>

      <AddProjectDialog
        isOpen={showAddProject}
        onClose={() => setShowAddProject(false)}
      />
      <CloneFromGitHubDialog
        isOpen={showCloneDialog}
        onClose={() => setShowCloneDialog(false)}
      />
    </div>
  );
}
