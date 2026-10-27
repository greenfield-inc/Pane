import { useEffect, useId, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import type { AgentLaunchPresetId } from '../../../shared/constants/agentLaunchPresets';
import type { RunpanePaneCreateRequest } from '../../../shared/types/runpaneOrchestration';
import type { PanelCreateOptions } from '../types/panelComponents';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { API } from '../utils/api';
import { cn } from '../utils/cn';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { defaultBaseBranch, generatePaneName, taskPaneName, type PaneNameBranchInfo } from '../utils/paneName';
import { rollupSessionAgentState } from '../utils/agentStatus';
import { visibleAgentPresets } from '../utils/agentPresets';
import { useAgentReadiness, type AgentReadiness } from '../hooks/useAgentReadiness';
import { useSessionStore } from '../stores/sessionStore';
import { usePanelStore } from '../stores/panelStore';
import { useNavigationStore } from '../stores/navigationStore';
import { agentSetupTerminal } from './panels/newTab/agentSetup';
import { getCliBrandIcon } from './ui/brandIconRegistry';
import { AgentStatusDot } from './ui/AgentStatusDot';
import { Button } from './ui/Button';

const paneCreateResultSchema = boundary.object({
  items: boundary.array(boundary.object({
    sessionId: boundary.optional(boundary.string),
    error: boundary.optional(boundary.object({ message: boundary.string })),
  })),
});

const isSelectable = (readiness: AgentReadiness) => readiness === 'ready' || readiness === 'unknown';

interface StartTaskCardProps {
  projectId: number;
  projectEnvironment: ProjectEnvironment | undefined;
  /** Open a tab in the project's own checkout: a plain terminal, or one with a setup command typed. */
  openTerminal: (options?: PanelCreateOptions) => void;
}

/**
 * The project view's "Start a task" card: pick an agent, describe the work,
 * and it starts in a new Pane and worktree. Once the project has a Pane, it
 * invites another in parallel.
 */
export function StartTaskCard({ projectId, projectEnvironment, openTerminal }: StartTaskCardProps) {
  const presets = useMemo(() => visibleAgentPresets(projectEnvironment), [projectEnvironment]);
  const readiness = useAgentReadiness(projectId, useMemo(() => presets.map(preset => preset.id), [presets]));
  const sessions = useSessionStore(state => state.sessions);
  const panes = useMemo(
    () => sessions.filter(session => session.projectId === projectId && !session.isMainRepo && !session.archived),
    [sessions, projectId],
  );
  const workingCount = usePanelStore(state => panes.filter(session => (
    rollupSessionAgentState(state.agentStatus, state.agentStatusSession, session.id) === 'working'
  )).length);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const titleId = useId();

  const [task, setTask] = useState('');
  const [picked, setPicked] = useState<AgentLaunchPresetId | null>(null);
  const [branches, setBranches] = useState<PaneNameBranchInfo[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    API.projects.listBranches(String(projectId))
      .then(response => { if (!cancelled && response.success && response.data) setBranches(response.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  // Until every first check answers, no agent is selected; then the first ready one, else the first unknown one.
  const checked = presets.every(preset => readiness[preset.id] !== 'checking');
  const selected = picked && isSelectable(readiness[picked])
    ? picked
    : checked
      ? (presets.find(preset => readiness[preset.id] === 'ready') ?? presets.find(preset => readiness[preset.id] === 'unknown'))?.id
      : undefined;

  const trimmedTask = task.trim();
  const baseBranch = defaultBaseBranch(branches);
  const paneName = trimmedTask
    ? generatePaneName(taskPaneName(trimmedTask) || 'new-task', new Set(panes.map(session => session.name)), branches)
    : '';

  const start = async () => {
    if (!selected || !trimmedTask || starting) return;
    setStarting(true);
    setError(null);
    try {
      const request: RunpanePaneCreateRequest = {
        repo: { id: projectId },
        focus: true,
        panes: [{ name: paneName, baseBranch, tool: { agent: selected, initialInput: trimmedTask } }],
      };
      const result = decodeOptionalBoundary(await window.electronAPI.invoke('runpane:panes:create', request), paneCreateResultSchema);
      const item = result?.items[0];
      if (!item?.sessionId) throw new Error(item?.error?.message ?? 'Pane creation returned no Pane.');
      setTask('');
      // A remote desktop gets no focus event from its host, so open the Pane here too.
      navigateToSessions();
      await useSessionStore.getState().setActiveSession(item.sessionId);
    } catch (cause) {
      setError(ipcErrorMessage(cause, 'Pane creation failed.').replace(/\.?$/, '.'));
    } finally {
      setStarting(false);
    }
  };

  const chooseAgent = (agent: AgentLaunchPresetId) => {
    const state = readiness[agent];
    if (isSelectable(state)) {
      setPicked(agent);
      return;
    }
    const setup = agentSetupTerminal(agent, state === 'signed-out' ? 'sign-in' : 'install', projectEnvironment);
    if (setup) openTerminal(setup);
  };

  const hasPane = panes.length > 0;
  return (
    <div className="h-full w-full overflow-y-auto">
      <section aria-labelledby={titleId} className="mx-auto mt-7 w-[calc(100%-2rem)] max-w-[440px] rounded-xl border border-border-primary bg-surface-primary p-4">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <h2 id={titleId} className="text-sm font-semibold text-text-primary">
            {hasPane ? 'Run another task in parallel' : 'Start a task'}
          </h2>
          {hasPane && workingCount > 0 && (
            <span className="flex flex-shrink-0 items-center gap-1.5 rounded-full border border-border-primary bg-surface-secondary px-2 py-0.5 text-[11px] text-text-secondary">
              <AgentStatusDot status="working" size="sm" />
              {workingCount === 1 ? '1 agent working' : `${workingCount} agents working`}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-text-tertiary">
          {hasPane
            ? 'Each task gets its own Pane and worktree, so agents never edit the same files.'
            : 'Pick an agent and describe the work. It runs in its own Pane and worktree, so your branch stays untouched.'}
        </p>

        <div role="radiogroup" aria-label="Agent" className="mt-3 flex flex-wrap gap-1.5">
          {presets.map(preset => {
            const state = readiness[preset.id];
            const needs = state === 'signed-out' ? 'Sign in' : state === 'not-installed' ? 'Install' : null;
            const isSelected = preset.id === selected;
            return (
              <button
                key={preset.id}
                type="button"
                role={needs ? undefined : 'radio'}
                aria-checked={needs ? undefined : isSelected}
                disabled={!checked || starting}
                onClick={() => chooseAgent(preset.id)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle disabled:cursor-default',
                  isSelected
                    ? 'border-interactive bg-interactive/10 font-medium text-text-primary'
                    : needs
                      ? 'border-border-primary text-text-tertiary enabled:hover:bg-surface-hover'
                      : 'border-border-primary text-text-secondary enabled:hover:bg-surface-hover',
                )}
              >
                {!needs && <span className="flex w-3.5 justify-center">{getCliBrandIcon(preset.iconKey, 'h-3 w-3')}</span>}
                <span>
                  {preset.title}
                  {needs && <>{' '}<span className="text-text-muted">·</span>{' '}<span className="text-interactive">{needs}</span></>}
                </span>
              </button>
            );
          })}
        </div>

        <textarea
          aria-label="Task"
          value={task}
          onChange={event => setTask(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void start();
            }
          }}
          placeholder="Describe the task for the agent"
          rows={3}
          disabled={starting}
          className="mt-3 block w-full resize-none rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-interactive focus:outline-none focus:ring-1 focus:ring-interactive"
        />

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="min-w-0 text-[11px] leading-4 text-text-tertiary">
            {baseBranch && `Branch from ${baseBranch}`}
            {baseBranch && paneName && ' · '}
            {paneName && <span className="whitespace-nowrap">new Pane &quot;{paneName}&quot;</span>}
          </span>
          <Button
            size="sm"
            onClick={() => void start()}
            disabled={!selected || !trimmedTask || starting}
            icon={<Plus className="h-3.5 w-3.5" />}
            className="flex-shrink-0"
          >
            {starting ? 'Starting…' : 'Start in a new Pane'}
          </Button>
        </div>

        {error && (
          <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary">
            <span className="min-w-0 break-words">Couldn&apos;t start the Pane: {error}</span>
            <Button size="sm" variant="secondary" className="flex-shrink-0" onClick={() => void start()}>Try again</Button>
          </div>
        )}
      </section>

      <p className="mt-3 text-center text-xs text-text-tertiary">
        or{' '}
        <button
          type="button"
          onClick={() => openTerminal()}
          className="rounded text-interactive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
        >
          Open a terminal
        </button>
      </p>
    </div>
  );
}
