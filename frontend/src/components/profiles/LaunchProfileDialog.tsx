import { useEffect, useMemo, useState } from 'react';
import { CONFIGURED_AGENT_IDS, agentLabel, isConfiguredAgent } from '../../../../shared/agents';
import type { LibraryProfile, ProfileLaunchInput, ProfileRun } from '../../../../shared/types/profiles';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { API } from '../../utils/api';
import { Button } from '../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { useProjectList } from '../loops/useProjectList';

const PROFILE_CHOICE = '';
const OTHER_CHOICE = '__other__';
const NEW_SESSION = '';

const FIELD = 'w-full rounded-md border border-border-primary bg-surface-primary px-2 py-1.5 text-[13px] text-text-primary focus:border-border-focus focus:outline-none';

export interface LaunchProfileDefaults {
  repoId?: number;
  sessionId?: string;
}

/** The CLI the file asks for, as the dialog says it. */
function fileRuns(runs: string): string {
  const [cli, model] = runs.split('/', 2);
  return `${agentLabel(cli)}${model ? ` · ${model}` : ''}`;
}

/**
 * Launches a profile: which repository and Session it runs in, the task, and the CLI each agent
 * runs on (the profile's choice, another configured CLI, or any command: the terminal baseline).
 */
export function LaunchProfileDialog({ profile, defaults, onClose, onLaunched }: { profile: LibraryProfile; defaults?: LaunchProfileDefaults; onClose: () => void; onLaunched: (run: ProfileRun) => void }) {
  const projects = useProjectList();
  const sessions = useOrchestrationSessionStore((state) => state.sessions);
  const loadSessions = useOrchestrationSessionStore((state) => state.load);
  useEffect(() => { void loadSessions().catch(() => undefined); }, [loadSessions]);
  const agents = profile.profile?.agents ?? [];
  const [repoId, setRepoId] = useState<number | undefined>(defaults?.repoId);
  const [sessionId, setSessionId] = useState(defaults?.sessionId ?? NEW_SESSION);
  const [prompt, setPrompt] = useState('');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const repo = repoId ?? projects[0]?.id;
  const openSessions = useMemo(() => sessions.filter((session) => !session.archived), [sessions]);

  /** An agent whose CLI Pane has no config for: it runs on the terminal baseline. */
  const baseline = agents.filter((agent) => {
    const choice = choices[agent.id] ?? PROFILE_CHOICE;
    return choice === OTHER_CHOICE || (choice === PROFILE_CHOICE && !isConfiguredAgent(agent.cli));
  });
  const missingCommand = agents.some((agent) => choices[agent.id] === OTHER_CHOICE && !others[agent.id]?.trim());

  const launch = async () => {
    if (repo === undefined) return;
    setBusy(true);
    setError(null);
    const harness: Record<string, string> = {};
    const commands: Record<string, string> = {};
    for (const agent of agents) {
      const choice = choices[agent.id] ?? PROFILE_CHOICE;
      if (choice === OTHER_CHOICE) {
        const cli = `other-${agent.id}`;
        harness[agent.id] = cli;
        commands[cli] = others[agent.id].trim();
      } else if (choice !== PROFILE_CHOICE) {
        harness[agent.id] = choice;
      }
    }
    const input: ProfileLaunchInput = { profile: profile.name, repoId: repo, prompt: prompt.trim(), harness, commands };
    if (sessionId) input.sessionId = sessionId;
    try {
      const response = await API.profiles.launch(input);
      if (!response.success || !response.data) setError(response.error ?? 'The profile did not start.');
      else onLaunched(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="lg" ariaLabel={`Launch ${profile.name}`}>
      <ModalHeader title={`Launch ${profile.name}`} description="The first step opens in a new Pane; every later step opens as a tab in it." onClose={onClose} />
      <ModalBody>
        <div className="flex flex-col gap-3" data-testid="launch-profile-dialog">
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            Repository
            <select className={FIELD} value={repo ?? ''} onChange={(event) => setRepoId(Number(event.target.value))} aria-label="Repository">
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            Session
            <select className={FIELD} value={sessionId} onChange={(event) => setSessionId(event.target.value)} aria-label="Session">
              <option value={NEW_SESSION}>A new Session</option>
              {openSessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            Task
            <textarea className={`${FIELD} min-h-[72px]`} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the team do?" aria-label="Task" />
          </label>
          <fieldset className="flex flex-col gap-2 rounded-md border border-border-primary p-3">
            <legend className="px-1 text-xs text-text-secondary">Who runs each agent</legend>
            {agents.map((agent) => {
              const choice = choices[agent.id] ?? PROFILE_CHOICE;
              return (
                <div key={agent.id} className="flex flex-wrap items-center gap-2" data-testid="launch-agent-row">
                  <span className="w-28 truncate text-[13px] font-medium text-text-primary">{agent.id}</span>
                  <select
                    className={`${FIELD} w-56 flex-none`}
                    aria-label={`CLI for ${agent.id}`}
                    value={choice}
                    onChange={(event) => setChoices({ ...choices, [agent.id]: event.target.value })}
                  >
                    <option value={PROFILE_CHOICE}>Profile: {fileRuns(agent.runs)}</option>
                    {CONFIGURED_AGENT_IDS.filter((id) => id !== agent.cli).map((id) => <option key={id} value={id}>{agentLabel(id)}</option>)}
                    <option value={OTHER_CHOICE}>Other…</option>
                  </select>
                  {choice === OTHER_CHOICE && (
                    <input className={`${FIELD} min-w-[180px] flex-1 font-mono`} placeholder="the command that starts it" aria-label={`Command for ${agent.id}`} value={others[agent.id] ?? ''} onChange={(event) => setOthers({ ...others, [agent.id]: event.target.value })} />
                  )}
                </div>
              );
            })}
          </fieldset>
          {baseline.length > 0 && (
            <p className="rounded-md border border-status-warning px-3 py-2 text-xs text-text-secondary" data-testid="launch-baseline-note">
              <span className="font-medium text-status-warning">Baseline only:</span> {baseline.map((agent) => agent.id).join(', ')} {baseline.length === 1 ? 'runs' : 'run'} on a CLI Pane doesn't know, in a plain terminal tab. Pane types the first message when the tab is quiet; the agent ends its step with runpane report --outcome.
            </p>
          )}
          {agents.some((agent) => agent.effort) && <p className="text-[11px] text-text-tertiary">Effort is passed only to CLIs that take one.</p>}
          {error && <p className="text-xs text-status-error" role="alert">{error}</p>}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" disabled={busy || !prompt.trim() || repo === undefined || missingCommand} onClick={() => void launch()} data-testid="launch-profile-submit">{busy ? 'Launching…' : 'Launch'}</Button>
      </ModalFooter>
    </Modal>
  );
}
