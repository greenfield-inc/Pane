import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { API } from '../utils/api';
import { cn } from '../utils/cn';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { Button } from './ui/Button';
import { CreateSessionDialog } from './CreateSessionDialog';
import { ONBOARDING_OPEN_PROJECT_SCREEN_PREFERENCE, OPEN_PROJECT_SCREEN_SEEN } from './OnboardingDialog';
import type { Project } from '../types/project';
import type { Session } from '../types/session';

/** 'done' once every step ticked, 'hidden' after Hide; the card never returns after either. */
const FIRST_STEPS_PREFERENCE = 'onboarding_first_steps';
/** App.tsx opens the first-run "Open your project" screen on this window event. */
export const OPEN_FIRST_SCREEN_EVENT = 'open-first-screen';

type StepId = 'open-project' | 'start-pane' | 'start-second-pane' | 'archive-pane';

interface FirstStep {
  id: StepId;
  label: string;
  /** The next step's button label. */
  action: string;
  done: boolean;
}

export interface FirstSteps {
  steps: FirstStep[];
  /** The user's most recently added project, other than the sample repo. */
  newestProject: Project | undefined;
  /** The newest active worktree Pane in such a project. */
  newestPane: Session | undefined;
  hide: () => void;
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

/**
 * Home's "Your first steps" for installs that saw the "Open your project"
 * screen. Ticks come from the projects and Panes Pane already has, ignoring
 * the sample repo. 'loading' until known, so Home never flashes another card;
 * null when the card doesn't apply.
 */
export function useFirstSteps(projects: Project[] | null): FirstSteps | 'loading' | null {
  const sessions = useSessionStore(state => state.sessions);
  const [gate, setGate] = useState<'loading' | 'active' | 'inactive'>('loading');
  const [samplePath, setSamplePath] = useState<string | null>(null);
  const [archived, setArchived] = useState<Array<Project & { sessions: Session[] }> | null>(null);

  // The first screen writes its "seen" preference after Home mounts, and its close fires project-changed.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const [seen, state] = await Promise.all([
          API.preferences.get(ONBOARDING_OPEN_PROJECT_SCREEN_PREFERENCE),
          API.preferences.get(FIRST_STEPS_PREFERENCE),
        ]);
        const active = seen === OPEN_PROJECT_SCREEN_SEEN && state !== 'done' && state !== 'hidden';
        if (active) {
          const sample = await window.electronAPI.onboarding.sampleRepoPath();
          if (!cancelled && sample.success && sample.data) setSamplePath(normalizePath(sample.data));
        }
        if (!cancelled) setGate(active ? 'active' : 'inactive');
      } catch {
        if (!cancelled) setGate('inactive');
      }
    };
    void check();
    const handler = () => void check();
    window.addEventListener('project-changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('project-changed', handler);
    };
  }, []);

  const ownProjects = useMemo(
    () => (projects ?? []).filter(project => normalizePath(project.path) !== samplePath),
    [projects, samplePath],
  );
  const activePanes = useMemo(() => {
    const ownIds = new Set(ownProjects.map(project => project.id));
    return sessions.filter(session => !session.archived && !session.isMainRepo && session.projectId !== undefined && ownIds.has(session.projectId));
  }, [sessions, ownProjects]);

  // Archiving a Pane removes it from the session store, so a change in the active set reloads the archived ones.
  const activePaneKey = activePanes.map(session => session.id).join('\n');
  useEffect(() => {
    if (gate !== 'active') return;
    let cancelled = false;
    void API.sessions.getArchivedWithProjects()
      .then(response => {
        if (cancelled || !response.success || !response.data) return;
        // SAFETY: sessions:get-archived-with-projects answers projects that each carry their archived Panes.
        setArchived(response.data as Array<Project & { sessions: Session[] }>);
      })
      .catch(() => {
        if (!cancelled) setArchived(current => current ?? []);
      });
    return () => { cancelled = true; };
  }, [gate, activePaneKey]);

  const archivedCount = useMemo(() => {
    const ownIds = new Set(ownProjects.map(project => project.id));
    return (archived ?? []).filter(project => ownIds.has(project.id)).reduce((sum, project) => sum + project.sessions.length, 0);
  }, [archived, ownProjects]);

  const paneCount = activePanes.length + archivedCount;
  const steps: FirstStep[] = [
    { id: 'open-project', label: 'Open your project', action: 'Open', done: ownProjects.length > 0 },
    { id: 'start-pane', label: 'Start an agent in a new Pane', action: 'Start', done: paneCount >= 1 },
    { id: 'start-second-pane', label: 'Start a second agent in parallel', action: 'Start', done: paneCount >= 2 },
    { id: 'archive-pane', label: 'Review the diff, then archive the Pane', action: 'Review', done: archivedCount >= 1 },
  ];
  const isReady = gate === 'active' && projects !== null && archived !== null;
  const allDone = isReady && steps.every(step => step.done);

  const finish = useCallback((state: 'done' | 'hidden') => {
    setGate('inactive');
    void API.preferences.set(FIRST_STEPS_PREFERENCE, state).catch(() => setGate('active'));
  }, []);

  useEffect(() => {
    if (allDone) finish('done');
  }, [allDone, finish]);

  if (gate === 'inactive' || allDone) return null;
  if (!isReady) return 'loading';
  return {
    steps,
    // Project ids grow with each project added.
    newestProject: ownProjects.reduce<Project | undefined>((newest, project) => (!newest || project.id > newest.id ? project : newest), undefined),
    newestPane: activePanes.reduce<Session | undefined>(
      (newest, session) => (!newest || new Date(session.createdAt).getTime() > new Date(newest.createdAt).getTime() ? session : newest),
      undefined,
    ),
    hide: () => finish('hidden'),
  };
}

export function FirstStepsCard({ firstSteps }: { firstSteps: FirstSteps }) {
  const { steps, newestProject, newestPane, hide } = firstSteps;
  const navigateToSessions = useNavigationStore(s => s.navigateToSessions);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const [createFor, setCreateFor] = useState<Project | null>(null);
  const next = steps.find(step => !step.done);

  const run = (id: StepId) => {
    if (id === 'open-project') {
      window.dispatchEvent(new Event(OPEN_FIRST_SCREEN_EVENT));
    } else if (id === 'archive-pane') {
      if (!newestPane) return;
      navigateToSessions();
      setActiveSession(newestPane.id).catch(() => {});
    } else if (newestProject) {
      setCreateFor(newestProject);
    }
  };

  return (
    <section aria-label="Your first steps" className="space-y-4 rounded-2xl border border-border-secondary bg-surface-primary/70 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Your first steps</h2>
          <p className="mt-2 text-sm text-text-tertiary">About five minutes. Each step opens the action.</p>
        </div>
        <button
          type="button"
          onClick={hide}
          className="rounded-md px-2 py-1 text-xs text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
        >
          Hide
        </button>
      </div>

      <ol className="space-y-2">
        {steps.map(step => {
          const isNext = step === next;
          return (
            <li
              key={step.id}
              aria-current={isNext ? 'step' : undefined}
              className={cn(
                'flex h-12 items-center gap-3 rounded-lg border bg-surface-secondary px-4 text-sm',
                isNext ? 'border-interactive ring-1 ring-interactive' : 'border-border-secondary',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                  step.done ? 'border-status-success bg-status-success text-text-on-status-success' : 'border-border-primary',
                )}
              >
                {step.done && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  step.done ? 'text-text-tertiary line-through' : isNext ? 'font-medium text-text-primary' : 'text-text-secondary',
                )}
              >
                {step.label}
                {step.done && <span className="sr-only"> (done)</span>}
              </span>
              {isNext && (
                <Button size="sm" variant="primary" onClick={() => run(step.id)}>
                  {step.action}
                </Button>
              )}
            </li>
          );
        })}
      </ol>

      {createFor && (
        <CreateSessionDialog
          isOpen
          onClose={() => setCreateFor(null)}
          projectName={createFor.name}
          projectId={createFor.id}
        />
      )}
    </section>
  );
}
