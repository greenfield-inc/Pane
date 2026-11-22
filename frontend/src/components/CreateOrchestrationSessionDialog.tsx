import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Pin } from 'lucide-react';
import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { nextOrchestrationSessionName, type OrchestrationSessionCreateInput } from '../../../shared/types/orchestrationSession';
import { PANE_CLOUD_UNREACHABLE, type PaneCloudCreateStep, type PaneCloudSession, type PaneCloudSnapshot } from '../../../shared/types/paneCloud';
import { LOCAL_MACHINE_ID, type MachineState } from '../../../shared/types/machineConnections';
import { DEFAULT_PANE_CHAT_AGENT, PANE_CHAT_AGENT_LABELS, type PaneChatAgent } from '../../../shared/types/paneChat';
import { DEFAULT_SESSION_PROFILE } from '../../../shared/types/sessionProfile';
import { CONFIGURED_AGENT_IDS } from '../../../shared/agents';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import type { AppConfig } from '../types/config';
import { useConfigStore } from '../stores/configStore';
import { useAllMachinesStore } from '../stores/allMachinesStore';
import { PaneCloudCallError, usePaneCloudStore } from '../stores/paneCloudStore';
import { openOnMachine, type MachineTarget } from '../utils/machineRowActions';
import type { MachineOs } from '../utils/machineList';
import { createSessionOn, readSessionNames } from '../utils/newOnMachine';
import { visibleAgentPresets } from '../utils/agentPresets';
import { cn } from '../utils/cn';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { Input, Textarea } from './ui/Input';
import { Toggle } from './ui/Toggle';
import { SessionLaunchFields } from './SessionLaunchFields';
import { WhereItRuns, type PaneCloudGate, type Place, type PlaceMachine } from './WhereItRuns';
import { MAC_WORK_DOCS_URL, placesForMacWork } from '../utils/macWork';
import { phoneAccessIsOff } from './addDevice/addDeviceStore';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { PaneCloudSecretsDialog } from './PaneCloudSecretsDialog';
import { CloudSignInTokens } from './CloudSignInTokens';

/** How long a newly paired cloud machine may take to reach the machine menu. */
const LISTED_DEADLINE_MS = 15_000;

/**
 * Opens the new cloud Session. The machine menu lists the VM only after main's config push, and the
 * switch restores the VM's own last-shown Session, so once the window is on the VM it opens the new
 * one again, in place.
 */
async function openNewCloudSession(machineId: string, target: MachineTarget): Promise<void> {
  await until(() => useAllMachinesStore.getState().entries.some((entry) => entry.id === machineId));
  await openOnMachine(machineId, target);
  await until(() => useAllMachinesStore.getState().entries.some((entry) => entry.id === machineId && entry.active));
  await openOnMachine(machineId, target);
}

/** Resolves once `ready` holds for the machine menu, or after a while regardless. */
function until(ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { stop(); resolve(); }, LISTED_DEADLINE_MS);
    const stop = useAllMachinesStore.subscribe(() => {
      if (!ready()) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

/** The Pane Cloud waitlist; `from` tells it the person came from the app (D-102). */
const PANE_CLOUD_WAITLIST_URL = 'https://runpane.com/cloud?from=pane-app';

const ENVIRONMENT_BY_OS = { macOS: 'macos', Windows: 'windows', Linux: 'linux' } satisfies Record<MachineOs, ProjectEnvironment>;

const CLOUD_STEP_TEXT = {
  creating: 'Starting the machine…',
  pairing: 'Connecting…',
  'starting-session': 'Starting the Session…',
} satisfies Record<PaneCloudCreateStep, string>;

/**
 * The machine the window is on, and every other saved machine online now that is not a cloud
 * Session's VM (those are reached through their Session, not offered as places).
 */
function usePlaceMachines(enabled: boolean, cloudSessions: readonly PaneCloudSession[]): { current: PlaceMachine; others: PlaceMachine[] } {
  const [states, setStates] = useState<MachineState[]>([]);
  const entries = useAllMachinesStore(state => state.entries);
  useEffect(() => {
    const api = window.electronAPI?.machines;
    if (!enabled || !api) return;
    let live = true;
    void api.list().then(list => { if (live) setStates(list); }).catch(() => undefined);
    const unsubscribe = api.onEvent(event => { if (event.type === 'machines') setStates(event.machines); });
    return () => { live = false; unsubscribe(); };
  }, [enabled]);
  return useMemo(() => {
    const currentId = entries.find(entry => entry.active)?.id ?? LOCAL_MACHINE_ID;
    const named = (id: string, label: string): PlaceMachine => {
      const entry = entries.find(candidate => candidate.id === id);
      return { id, name: entry?.name ?? label, os: entry?.os ?? null };
    };
    const cloud = new Set(cloudSessions.map(session => session.machineId));
    return {
      current: named(currentId, 'This computer'),
      others: states.filter(state => state.id !== currentId && state.status === 'online' && !cloud.has(state.id)).map(state => named(state.id, state.label)),
    };
  }, [states, entries, cloudSessions]);
}

const xcodeAnswerSchema = boundary.object({ files: boundary.optional(boundary.array(boundary.json)) });

/**
 * Whether the project the window has open (the open Pane's, else the project page's) has an Xcode
 * project, which iOS Simulator work needs and Pane Cloud's Linux machines can't run (D-85). Read on
 * the window's machine, where the repo is.
 */
function useXcodeProject(enabled: boolean): boolean {
  const paneProjectId = useSessionStore(state => state.sessions.find(session => session.id === state.activeSessionId)?.projectId);
  const pageProjectId = useNavigationStore(state => state.activeProjectId);
  const projectId = paneProjectId ?? pageProjectId;
  const [xcode, setXcode] = useState(false);
  useEffect(() => {
    setXcode(false);
    if (!enabled || projectId == null) return undefined;
    let live = true;
    const found = (pattern: string) => window.electronAPI.invoke('file:search', { projectId, pattern, limit: 1 })
      .then(answer => (decodeOptionalBoundary(answer, xcodeAnswerSchema)?.files?.length ?? 0) > 0)
      .catch(() => false);
    void Promise.all([found('.xcodeproj'), found('.xcworkspace')]).then(([project, workspace]) => { if (live) setXcode(project || workspace); });
    return () => { live = false; };
  }, [enabled, projectId]);
  return xcode;
}

function paneCloudGate({ signIn: account, usage, error }: PaneCloudSnapshot): PaneCloudGate | null {
  // Pane Cloud is invite-only (D-102): someone not signed in sees the waitlist, and Sign in for an invite.
  if (account.state === 'signed-out') {
    if (error?.code === PANE_CLOUD_UNREACHABLE) return { line: "Pane can't reach Pane Cloud right now, so you can't sign in. Pane Cloud is invite-only for now.", actions: ['waitlist', 'sign-in'] };
    return { line: error?.message ?? 'Pane Cloud is invite-only for now. Join the waitlist, or sign in if you have an invite.', actions: ['waitlist', 'sign-in'] };
  }
  if (account.state === 'unavailable') return { line: error ? [error.message, error.next].filter(Boolean).join(' ') : 'Pane cannot reach Pane Cloud right now.' };
  if (account.state === 'pending') return { line: 'Finish signing in in your browser.', code: account.userCode };
  if (account.access === 'waitlisted') return { line: "You're on the waitlist. Pane Cloud is invite-only for now; your invite arrives by email." };
  if (account.signupState !== 'ready') return { line: 'Finish signing up to create cloud Sessions.', actions: ['sign-up'] };
  if (usage && usage.awakeNow >= usage.awakeLimit) return { line: `You have ${usage.awakeNow} of ${usage.awakeLimit} Sessions awake. Stop one to create another.` };
  return null;
}

const SESSION_AGENT_OPTIONS: ReadonlyArray<{ id: PaneChatAgent; label: string }> = CONFIGURED_AGENT_IDS.map(id => ({ id, label: PANE_CHAT_AGENT_LABELS[id] }));

function availableSessionAgents(wsl = false, environment?: ProjectEnvironment): ReadonlyArray<{ id: PaneChatAgent; label: string }> {
  if (wsl) return SESSION_AGENT_OPTIONS;
  const visible = new Set(visibleAgentPresets(environment).map(preset => preset.id));
  return SESSION_AGENT_OPTIONS.filter(option => visible.has(option.id));
}

function supportedSessionAgent(preferred?: PaneChatAgent, environment?: ProjectEnvironment): PaneChatAgent {
  const options = availableSessionAgents(false, environment);
  if (preferred && options.some(option => option.id === preferred)) return preferred;
  return options[0]?.id ?? DEFAULT_PANE_CHAT_AGENT;
}

/** A command OpenCode Sessions accept: `opencode` itself, after optional `NAME=value` or `env` prefixes. */
const DIRECT_OPENCODE_COMMAND = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)?(?:\S*[\\/])?opencode(?:\.exe)?(?:\s|$)/i;

/**
 * The app's default launch settings as offered for `agent`. OpenCode Sessions refuse wrappers and
 * custom resume, so those defaults are left out for OpenCode rather than offered and then refused.
 */
function defaultLaunch(config: AppConfig | null, agent: PaneChatAgent): Pick<SessionCreationForm, 'launchCommand' | 'customResume'> {
  const launchCommand = config?.defaultSessionCommand ?? '';
  if (agent !== 'opencode') return { launchCommand, customResume: config?.defaultSessionResume ?? null };
  return { launchCommand: !launchCommand.trim() || DIRECT_OPENCODE_COMMAND.test(launchCommand.trim()) ? launchCommand : '', customResume: null };
}

/** The name is left out when the person did not type one. */
export type SessionCreateRequest = Omit<OrchestrationSessionCreateInput, 'name'> & { name?: string };

interface CreateOrchestrationSessionDialogProps {
  onSubmittingChange?: (submitting: boolean) => void;
  header?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  onCreate: (request: SessionCreateRequest) => Promise<void>;
  /** The machine the Session is created on, named on the Create button when New offers several. */
  machineName?: string;
  /** That machine's OS, which decides the agents offered; this computer's when left out. */
  environment?: ProjectEnvironment;
  /** Reads that machine's WSL distributions; the active host's when left out. */
  readRuntimes?: () => Promise<{ success: boolean; data?: { distributions: string[] } }>;
  /** Offers "Where it runs": this machine, Pane Cloud, or another saved machine online now. */
  offerPlaces?: boolean;
}

interface SessionCreationForm {
  agent: PaneChatAgent;
  name: string;
  goal: string;
  launchCommand: string;
  customResume: CustomCommandResume | null;
  profile: string;
  startPinned: boolean;
  error: string | null;
}

type SessionCreationAction =
  | { type: 'reset'; config: AppConfig | null; environment?: ProjectEnvironment }
  | { type: 'update'; values: Partial<SessionCreationForm> };

function initialSessionCreationForm(config: AppConfig | null, environment?: ProjectEnvironment): SessionCreationForm {
  const agent = supportedSessionAgent(config?.defaultOrchestratorAgent, environment);
  return {
    agent,
    name: '',
    goal: '',
    ...defaultLaunch(config, agent),
    profile: config?.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE,
    startPinned: config?.defaultSessionPinned ?? false,
    error: null,
  };
}

function sessionCreationReducer(state: SessionCreationForm, action: SessionCreationAction): SessionCreationForm {
  return action.type === 'reset' ? initialSessionCreationForm(action.config, action.environment) : { ...state, ...action.values };
}

export function CreateOrchestrationSessionDialog(props: CreateOrchestrationSessionDialogProps) {
  return <Modal isOpen={props.isOpen} onClose={props.onClose} size="md" ariaLabel="Create Session">
    <OrchestrationSessionForm offerPlaces {...props} />
  </Modal>;
}

export function OrchestrationSessionForm({ isOpen, onClose, onCreate, header, onSubmittingChange, machineName, environment, readRuntimes, offerPlaces = false }: CreateOrchestrationSessionDialogProps) {
  const [distributions, setDistributions] = useState<string[]>([]);
  const [wslDistribution, setWslDistribution] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setWslDistribution('');
    setDistributions([]);
    const runtimes = readRuntimes ?? window.electronAPI?.orchestrationSessions?.runtimes;
    void runtimes?.().then(result => {
      if (!cancelled && result.success) setDistributions(result.data?.distributions ?? []);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [isOpen, readRuntimes]);
  const [{ agent, name, goal, launchCommand, customResume, profile, startPinned, error }, dispatch] = useReducer(sessionCreationReducer, null, config => initialSessionCreationForm(config, environment));
  const userEditedLaunch = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const config = useConfigStore(state => state.config);
  const fetchConfig = useConfigStore(state => state.fetchConfig);
  const updateConfig = useConfigStore(state => state.updateConfig);
  const userSelectedAgent = useRef(false);
  const userToggledPinned = useRef(false);
  const [chosenPlace, setChosenPlace] = useState<Place>('here');
  const [choosingSecrets, setChoosingSecrets] = useState(false);
  const cloud = usePaneCloudStore(state => state.snapshot);
  const followCloud = usePaneCloudStore(state => state.follow);
  const signInToCloud = usePaneCloudStore(state => state.signIn);
  useEffect(() => (isOpen && offerPlaces ? followCloud() : undefined), [isOpen, offerPlaces, followCloud]);
  const userPickedPlace = useRef(false);
  useEffect(() => { if (isOpen) { setChosenPlace('here'); userPickedPlace.current = false; } }, [isOpen]);
  const listed = usePlaceMachines(isOpen && offerPlaces, cloud.sessions);
  const xcode = useXcodeProject(isOpen && offerPlaces);
  // Pairing the new machine turns phone access on in place, as linking any machine does (D-88); the card says so first.
  const [phoneAccessOff, setPhoneAccessOff] = useState(false);
  useEffect(() => {
    if (!isOpen || !offerPlaces) return undefined;
    let live = true;
    void phoneAccessIsOff().then(off => { if (live) setPhoneAccessOff(off); });
    return () => { live = false; };
  }, [isOpen, offerPlaces]);
  const macWork = placesForMacWork({ current: listed.current, others: listed.others, xcode });
  const places = { current: listed.current, others: macWork.others };
  // A repo with an Xcode project starts on one of the person's Macs, before they create the Session (D-85).
  useEffect(() => {
    if (macWork.preferred !== null && !userPickedPlace.current) setChosenPlace(macWork.preferred);
  }, [macWork.preferred]);
  const pickPlace = (next: Place) => { userPickedPlace.current = true; setChosenPlace(next); };
  // A machine that went offline after it was picked falls back to this one.
  const otherMachine = places.others.find(machine => machine.id === chosenPlace);
  const place: Place = chosenPlace === 'cloud' || otherMachine ? chosenPlace : 'here';
  const cloudGate = paneCloudGate(cloud);
  const signupUrl = cloud.signIn.state === 'signed-in' ? cloud.signIn.signupUrl : null;
  // Pane Cloud machines run Linux; another machine offers the agents its OS runs.
  const agentEnvironment: ProjectEnvironment | undefined = place === 'cloud' ? 'linux'
    : otherMachine?.os ? ENVIRONMENT_BY_OS[otherMachine.os] : environment;
  // WSL is this machine's runtime only.
  const wsl = place === 'here' ? wslDistribution : '';

  useEffect(() => {
    if (!isOpen || userSelectedAgent.current) return;
    dispatch({ type: 'update', values: { agent: wsl
      ? config?.defaultOrchestratorAgent ?? DEFAULT_PANE_CHAT_AGENT
      : supportedSessionAgent(config?.defaultOrchestratorAgent, agentEnvironment) } });
  }, [isOpen, wsl, config?.defaultOrchestratorAgent, agentEnvironment]);

  useEffect(() => {
    if (!isOpen) return;
    userSelectedAgent.current = false;
    userEditedLaunch.current = false;
    userToggledPinned.current = false;
    const savedConfig = useConfigStore.getState().config;
    dispatch({ type: 'reset', config: savedConfig, environment });
    if (!savedConfig) {
      void fetchConfig().then(nextConfig => {
        if (!userSelectedAgent.current) dispatch({ type: 'update', values: { agent: supportedSessionAgent(nextConfig.defaultOrchestratorAgent, environment) } });
        if (!userToggledPinned.current) dispatch({ type: 'update', values: { startPinned: nextConfig.defaultSessionPinned ?? false } });
        if (!userEditedLaunch.current) {
          dispatch({ type: 'update', values: {
            ...defaultLaunch(nextConfig, supportedSessionAgent(nextConfig.defaultOrchestratorAgent, environment)),
            profile: nextConfig.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE,
          } });
        }
      }).catch(() => undefined);
    }
  }, [fetchConfig, isOpen, environment]);

  // Until the person edits the launch fields, they show the app defaults that suit the chosen agent.
  useEffect(() => {
    if (!isOpen || userEditedLaunch.current) return;
    dispatch({ type: 'update', values: defaultLaunch(config, agent) });
  }, [isOpen, agent, config]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    onSubmittingChange?.(true);
    dispatch({ type: 'update', values: { error: null } });
    try {
      const defaults: Partial<AppConfig> = {};
      if (config?.defaultOrchestratorAgent !== agent) defaults.defaultOrchestratorAgent = agent;
      // Launch fields the person left alone are the defaults (filtered for OpenCode), not new ones.
      if (userEditedLaunch.current && (config?.defaultSessionCommand ?? '') !== launchCommand) defaults.defaultSessionCommand = launchCommand;
      if (userEditedLaunch.current && JSON.stringify(config?.defaultSessionResume ?? null) !== JSON.stringify(customResume)) defaults.defaultSessionResume = customResume;
      const request: SessionCreateRequest = {
        agent,
        name: name.trim() || undefined,
        goal: goal.trim() || undefined,
        launchCommand,
        profile,
        customResume,
        isPinned: startPinned,
      };
      if (place === 'cloud') {
        const sessionName = request.name || nextOrchestrationSessionName(cloud.sessions);
        const created = await usePaneCloudStore.getState().create({ ...request, name: sessionName, nameFromFirstMessage: !request.name });
        onClose();
        void openNewCloudSession(created.machineId, { kind: 'session', id: created.sessionId, name: sessionName });
      } else if (otherMachine) {
        const sessionName = request.name || nextOrchestrationSessionName(await readSessionNames(otherMachine));
        const sessionId = await createSessionOn(otherMachine, { ...request, name: sessionName, nameFromFirstMessage: !request.name });
        onClose();
        void openOnMachine(otherMachine.id, { kind: 'session', id: sessionId, name: sessionName });
      } else {
        await onCreate({ ...request, runtime: wsl ? 'wsl' : undefined, wslDistribution: wsl || undefined });
      }
      // Defaults change only once a Session was created, so a refused launch is not offered again.
      if (Object.keys(defaults).length > 0) await updateConfig(defaults);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Failed to create Session';
      dispatch({ type: 'update', values: { error: cause instanceof PaneCloudCallError && cause.next ? `${message} ${cause.next}` : message } });
    } finally {
      setIsSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  return (
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        {header ?? <ModalHeader title="Create Session" />}
        <ModalBody className="min-h-0 space-y-4">
          <Input label="Session name (optional)" value={name} onChange={event => dispatch({ type: 'update', values: { name: event.target.value } })} placeholder="Named from your first message" autoFocus fullWidth />
          <Textarea label="What is this Session for? (optional)" value={goal} onChange={event => dispatch({ type: 'update', values: { goal: event.target.value } })} rows={2} fullWidth />
          <fieldset className="space-y-2">
            <legend className="text-label font-medium text-text-primary">Choose an agent</legend>
            <div className="grid gap-2" role="radiogroup" aria-label="Session agent">
              {availableSessionAgents(Boolean(wsl), agentEnvironment).map(option => {
                const selected = agent === option.id;
                const isDefault = config?.defaultOrchestratorAgent === option.id;
                return (
                  <label
                    key={option.id}
                    data-testid={`create-session-agent-${option.id}`}
                    htmlFor={`create-session-agent-input-${option.id}`}
                    className={cn(
                      'flex cursor-default items-center justify-between rounded border px-3 py-2 text-left text-sm transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-interactive',
                      selected ? 'border-interactive bg-surface-selected text-text-primary' : 'border-border-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                    )}
                  >
                    <input
                      id={`create-session-agent-input-${option.id}`}
                      type="radio"
                      name="orchestration-session-agent"
                      value={option.id}
                      aria-label={option.label}
                      checked={selected}
                      onChange={() => {
                        userSelectedAgent.current = true;
                        dispatch({ type: 'update', values: { agent: option.id } });
                      }}
                      className="sr-only"
                    />
                    <span>{option.label}</span>
                    {isDefault && <span className="text-[11px] text-text-muted">Default</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
          {offerPlaces && (
            <WhereItRuns value={place} onChange={pickPlace} current={places.current} others={places.others} cloudGate={cloudGate} sendsSecrets={cloud.sendsSecrets} turnsOnPhoneAccess={phoneAccessOff} disabled={isSubmitting}
              onMacWorkDocs={xcode && !macWork.macAvailable ? () => void window.electronAPI.openExternal(MAC_WORK_DOCS_URL) : undefined}
              onCloudSignIn={() => void signInToCloud()} onCloudWaitlist={() => void window.electronAPI.openExternal(PANE_CLOUD_WAITLIST_URL)} onCloudSignUp={() => { if (signupUrl) void window.electronAPI.openExternal(signupUrl); }}
              onChooseSecrets={() => setChoosingSecrets(true)} signIns={cloudGate === null ? <CloudSignInTokens /> : undefined} />
          )}
          {distributions.length > 0 && place === 'here' && (
            <div className="space-y-2">
              <label htmlFor="session-runtime" className="text-label font-medium text-text-primary">Run agent in</label>
              <select id="session-runtime" value={wslDistribution} onChange={event => {
                setWslDistribution(event.target.value);
                if (!event.target.value) dispatch({ type: 'update', values: { agent: supportedSessionAgent(agent, environment) } });
              }} disabled={isSubmitting}
                className="w-full rounded border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary focus:ring-2 focus:ring-interactive">
                <option value="">Windows</option>
                {distributions.map(distribution => <option key={distribution} value={distribution}>WSL · {distribution}</option>)}
              </select>
              {wslDistribution && <p className="text-xs text-text-secondary">The agent must be installed in this distribution.</p>}
            </div>
          )}
          <div className="flex items-center gap-3">
            <Pin className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-primary">Start pinned</div>
              <div className="mt-0.5 text-xs text-text-secondary">Show this Session in the pinned section immediately.</div>
            </div>
            <Toggle
              checked={startPinned}
              aria-label="Start pinned"
              size="sm"
              onChange={checked => {
                userToggledPinned.current = true;
                dispatch({ type: 'update', values: { startPinned: checked } });
                void updateConfig({ defaultSessionPinned: checked }).catch(() => undefined);
              }}
            />
          </div>
          <details className="space-y-3">
            <summary className="cursor-default text-sm font-medium text-text-secondary transition-colors hover:text-text-primary">Launch command and behavior</summary>
            <SessionLaunchFields
              resume={customResume}
              onResumeChange={value => { userEditedLaunch.current = true; dispatch({ type: 'update', values: { customResume: value } }); }}
              command={launchCommand}
              profile={profile}
              customCommands={config?.customCommands}
              onCommandChange={value => { userEditedLaunch.current = true; dispatch({ type: 'update', values: { launchCommand: value } }); }}
              onProfileChange={value => { userEditedLaunch.current = true; dispatch({ type: 'update', values: { profile: value } }); }}
            />
          </details>
          {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
        </ModalBody>
        <ModalFooter className="shrink-0">
          <Button type="button" variant="secondary" disabled={isSubmitting} onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={isSubmitting} loadingText={place === 'cloud' && cloud.creating ? CLOUD_STEP_TEXT[cloud.creating.step] : 'Creating…'}
            disabled={place === 'cloud' && cloudGate !== null}>
            {place === 'cloud' ? 'Create Session on Pane Cloud'
              : otherMachine ? `Create Session on ${otherMachine.name}`
              : machineName ? `Create Session on ${machineName}` : 'Create Session'}
          </Button>
        </ModalFooter>
        <PaneCloudSecretsDialog isOpen={choosingSecrets} onClose={() => setChoosingSecrets(false)} />
      </form>
  );
}
