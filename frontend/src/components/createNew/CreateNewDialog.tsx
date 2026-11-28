import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, ChevronLeft, FileImage, Paperclip, X } from 'lucide-react';
import { CONFIGURED_AGENT_IDS, isConfiguredAgent } from '../../../../shared/agents';
import type { AgentFarmProfileList } from '../../../../shared/types/agentFarmProfiles';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { nextOrchestrationSessionName, type OrchestrationSessionCreateInput, type SessionRuntimes } from '../../../../shared/types/orchestrationSession';
import type { ProjectEnvironment } from '../../../../shared/types/panels';
import { DEFAULT_SESSION_PROFILE } from '../../../../shared/types/sessionProfile';
import { DEFAULT_PANE_CHAT_AGENT, newSessionFirstMessagePrompt } from '../../../../shared/types/paneChat';
import { useMachineStates } from '../../hooks/useMachineStates';
import { useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useErrorStore } from '../../stores/errorStore';
import type { AppConfig } from '../../types/config';
import type { CreateSessionRequest } from '../../types/session';
import { visibleAgentPresets } from '../../utils/agentPresets';
import { cn } from '../../utils/cn';
import type { MachineOs } from '../../utils/machineList';
import { rememberOnMachine } from '../../utils/machineRowActions';
import {
  createPaneOn,
  createSessionOn,
  newMachines,
  readBranches,
  readProfiles,
  readRepositories,
  readRuntimes,
  readSessionNames,
  rememberNewMachine,
  startingNewMachineId,
  type NewMachine,
  type RepositoryOption,
} from '../../utils/newOnMachine';
import { openAfterSwitch, openCreatedSession } from '../../utils/openAfterSwitch';
import { sessionChoiceInput, sessionChoices, type SessionChoice } from '../../utils/sessionChoices';
import { profileDisplayName } from '../../utils/profileAvatar';
import { defaultLaunch } from '../CreateOrchestrationSessionDialog';
import { rememberedLaunchDefaults, settingsResume } from './sessionResume';
import { CreatePaneForm, type CreatePaneFooterState } from '../CreateSessionDialog';
import type { NewDialogProps } from '../NewDialog';
import { SessionLaunchFields } from '../SessionLaunchFields';
import { openPaneTarget } from '../terminal/openPaneLink';
import { Button } from '../ui/Button';
import { Dropdown } from '../ui/Dropdown';
import { Textarea } from '../ui/Input';
import { Modal, ModalBody, ModalFooter } from '../ui/Modal';
import { Toggle } from '../ui/Toggle';
import {
  ATTACHABLE_IMAGE_TYPES,
  formatSize,
  isAttachableImage,
  readImageAttachment,
  rememberMode,
  rememberTo,
  rememberedMode,
  rememberedTo,
  type CreateNewMode,
  type ImageAttachment,
} from './createNewMemory';
import { ToField } from './ToField';
import { imagesBlocked, textBlocked, type FirstMessageTarget } from './firstMessageDelivery';
import { MAX_IMAGE_BYTES } from '../chatTab/chatAttachments';
import { addDraftAttachment } from '../chatTab/chatDrafts';
import { chatTabViewer } from '../../../../shared/chatTabViewer';
import { usePinnedProfiles } from '../profiles/profilePins';

const ENVIRONMENT_BY_OS = { macOS: 'macos', Windows: 'windows', Linux: 'linux' } satisfies Record<MachineOs, ProjectEnvironment>;

/** The agents a Session can run on that machine: every one in WSL, else those its OS offers. */
function availableAgents(environment: ProjectEnvironment | undefined, wsl: boolean): string[] {
  if (wsl) return [...CONFIGURED_AGENT_IDS];
  const visible = new Set(visibleAgentPresets(environment).map(preset => preset.id));
  return CONFIGURED_AGENT_IDS.filter(id => visible.has(id));
}

type ProfilesRead = { machineId: string; list?: AgentFarmProfileList; error?: string };

/** The machine's Agent Farm profiles, read when Run on picks it; another machine's over its connection. */
function useMachineProfiles(machine: NewMachine | undefined): ProfilesRead | null {
  const [read, setRead] = useState<ProfilesRead | null>(null);
  const machineId = machine?.id;
  const machineName = machine?.name;
  const current = machine?.current;
  useEffect(() => {
    if (!machineId || !machineName) return;
    let live = true;
    setRead({ machineId });
    const request = current
      ? window.electronAPI?.chatTab?.profiles?.() ?? Promise.resolve<AgentFarmProfileList>({ profiles: [] })
      : readProfiles({ id: machineId, name: machineName });
    request.then(
      list => { if (live) setRead({ machineId, list }); },
      (cause: unknown) => { if (live) setRead({ machineId, error: cause instanceof Error ? cause.message : `Pane could not read ${machineName}'s profiles.` }); },
    );
    return () => { live = false; };
  }, [machineId, machineName, current]);
  return read?.machineId === machineId ? read : null;
}

/**
 * The Run on machine's runtimes: its WSL distributions, which More options offers as Run agent in,
 * and how its Sessions take a first message. null while being read; `{ distributions: [] }` when
 * the machine couldn't say.
 */
function useMachineRuntimes(machine: NewMachine | undefined): SessionRuntimes | null {
  const [read, setRead] = useState<{ machineId: string; runtimes: SessionRuntimes } | null>(null);
  const machineId = machine?.id;
  const machineName = machine?.name;
  const current = machine?.current;
  useEffect(() => {
    if (!machineId || !machineName) return;
    let live = true;
    const request = current
      ? window.electronAPI?.orchestrationSessions?.runtimes?.() ?? Promise.resolve({ success: true, data: { distributions: [] } })
      : readRuntimes({ id: machineId, name: machineName });
    request.then(
      result => { if (live) setRead({ machineId, runtimes: result.success && result.data ? result.data : { distributions: [] } }); },
      () => { if (live) setRead({ machineId, runtimes: { distributions: [] } }); },
    );
    return () => { live = false; };
  }, [machineId, machineName, current]);
  return read && read.machineId === machineId ? read.runtimes : null;
}

/** Opens the first new Pane once it is listed; one still being set up opens itself when it arrives. */
async function openCreatedPane(createdIds: readonly string[]): Promise<void> {
  const { sessions } = useSessionStore.getState();
  const paneId = createdIds.find(id => sessions.some(session => session.id === id && !session.archived));
  if (paneId) await openPaneTarget({ paneId });
  else useNavigationStore.getState().navigateToSessions();
}

/** The old Create Session dialog's settings, now behind More options. */
interface SessionSettings {
  goal: string;
  startPinned: boolean;
  launchCommand: string;
  profile: string;
  /** Run agent in: a WSL distribution of the machine it was picked on; another machine runs natively. */
  wsl: { machineId: string; distribution: string } | null;
}

function initialSettings(config: AppConfig | null): SessionSettings {
  return {
    goal: '',
    startPinned: config?.defaultSessionPinned ?? false,
    launchCommand: defaultLaunch(config, config?.defaultOrchestratorAgent ?? DEFAULT_PANE_CHAT_AGENT).launchCommand,
    profile: config?.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE,
    wsl: null,
  };
}

const SCREEN_TITLES = { session: { main: 'New Session', options: 'Session options' }, pane: { main: 'New Pane', options: 'Pane options' } } as const;
const CREATE_LABELS = { session: 'Create session', pane: 'Create pane' } satisfies Record<CreateNewMode, string>;

/**
 * Create New (T-63, behind the Profiles switch): To → Session name → message → Run on, and Create.
 * Create's menu switches between a Session and a Pane and is remembered; More options holds every
 * setting the old dialogs had. No hotkey hints and no Session/Pane toggle on screen.
 */
export function CreateNewDialog({ projects, defaultProjectId, machines: entries, onSwitchMachine, onClose, initialMode, fromProject }: NewDialogProps) {
  const formId = useId();
  const nameId = useId();
  const messageId = useId();
  const toRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const config = useConfigStore(state => state.config);
  const updateConfig = useConfigStore(state => state.updateConfig);
  const [mode, setMode] = useState<CreateNewMode>(() => initialMode ?? rememberedMode());
  const [screen, setScreen] = useState<'main' | 'options'>('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [toListOpen, setToListOpen] = useState(false);

  // Run on: the machine you created on last, while it can take a create; else this computer.
  const states = useMachineStates();
  const currentId = entries.find(entry => entry.active)?.id ?? LOCAL_MACHINE_ID;
  const machines = useMemo(() => newMachines(states ?? [], entries, currentId), [states, entries, currentId]);
  // A project's + opens on this computer, where that project is.
  const [pickedId, setPickedId] = useState<string | null>(() => fromProject ? currentId : null);
  // The draft stays on the machine it was shown with: once the list is known, the default is fixed,
  // and a machine that drops offline holds Create until it is back or another is picked (F-1).
  const startingId = startingNewMachineId(machines);
  useEffect(() => {
    if (pickedId === null && states !== null && startingId) setPickedId(startingId);
  }, [pickedId, states, startingId]);
  const machine = machines.find(candidate => candidate.id === (pickedId ?? startingId));
  const machineUnavailable = machine && !machine.current && machine.status !== 'online'
    ? `${machine.name} is ${machine.status === 'connecting' ? 'reconnecting' : 'offline'}. Create waits for it, or pick another machine in Run on.`
    : undefined;
  const orderedMachines = [...machines.filter(candidate => candidate.current), ...machines.filter(candidate => !candidate.current)];
  const onOtherMachine = machine !== undefined && !machine.current;

  // Session: To, name, message and images; More options holds the old dialog's settings.
  const [settings, setSettings] = useState<SessionSettings>(() => initialSettings(config));
  const launchEdited = useRef(false);
  const runtimes = useMachineRuntimes(machine);
  const distributions = runtimes?.distributions ?? [];
  // A distribution picked on another machine, or one this machine no longer lists, runs natively.
  const wslDistribution = settings.wsl && settings.wsl.machineId === machine?.id && distributions.includes(settings.wsl.distribution) ? settings.wsl.distribution : '';
  const wsl = !!wslDistribution;
  const profilesRead = useMachineProfiles(machine);
  const environment = machine && !machine.current && machine.os ? ENVIRONMENT_BY_OS[machine.os] : undefined;
  const profilesUnavailable = wsl ? 'Profiles run in chat tabs, which don\'t run in WSL. Set Run in to Windows in More options to start one.'
    : !onOtherMachine && config && config.chatTabsEnabled !== true ? 'Profiles run in chat tabs, which are off. Turn on Chat tabs in Settings › AI & Agents to start one.'
      : undefined;
  // Profiles pinned in the Profiles tab lead To (T-63, build-6 feedback item 2).
  const pins = usePinnedProfiles();
  const choices = useMemo(() => sessionChoices({
    agents: availableAgents(environment, wsl),
    profiles: profilesRead?.list?.profiles ?? [],
    profilesUnavailable,
    pins,
  }), [environment, wsl, profilesRead, profilesUnavailable, pins]);
  const [toKey, setToKey] = useState<string | null>(() => rememberedTo());
  const startKey = `agent:${config?.defaultOrchestratorAgent ?? ''}`;
  const usable = (choice: SessionChoice | undefined) => choice && !choice.disabledReason ? choice : undefined;
  // While the profiles are still being read, a remembered profile shows as itself rather than
  // Claude; its agent comes from the profile when the Session is created.
  const profilesLoading = profilesRead === null || (!profilesRead.list && !profilesRead.error);
  const rememberedProfile = profilesLoading && toKey?.startsWith('profile:') && !profilesUnavailable
    ? { key: toKey, group: 'profiles' as const, label: profileDisplayName(toKey.slice('profile:'.length)), detail: toKey.slice('profile:'.length), agent: '', profileRef: toKey.slice('profile:'.length) }
    : undefined;
  const to = usable(choices.find(choice => choice.key === toKey))
    ?? rememberedProfile
    ?? usable(choices.find(choice => choice.key === startKey || (!choice.profileRef && choice.agent === config?.defaultOrchestratorAgent)))
    ?? choices.find(choice => !choice.disabledReason);
  const profilesStatus = profilesRead === null || (!profilesRead.list && !profilesRead.error) ? `Reading ${machine?.current ? 'this computer' : machine?.name ?? 'the machine'}'s profiles…`
    : profilesRead.error ? `Profiles unavailable: ${profilesRead.error}`
      : profilesRead.list?.error && !choices.some(choice => choice.group === 'profiles') ? profilesRead.list.error
        : null;
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [readingImages, setReadingImages] = useState(0);
  const [dragging, setDragging] = useState(false);

  // The launch the create sends (F-5). A profile brings its own. Settings left alone are the chosen
  // agent's defaults, which main fills in; with a first message, a default custom resume is left
  // out, since a resumed conversation can't take one. An edited launch command takes its resume
  // template from Settings, as Create New has no resume options (build 8).
  const agent = to?.agent || (config?.defaultOrchestratorAgent ?? DEFAULT_PANE_CHAT_AGENT);
  const shownLaunch = { launchCommand: launchEdited.current ? settings.launchCommand : defaultLaunch(config, isConfiguredAgent(agent) ? agent : DEFAULT_PANE_CHAT_AGENT).launchCommand };
  const text = message.trim();
  const launch: Pick<OrchestrationSessionCreateInput, 'launchCommand' | 'customResume'> = to?.profileRef ? { launchCommand: '', customResume: null }
    : launchEdited.current ? { launchCommand: settings.launchCommand, customResume: settingsResume(config, settings.launchCommand) }
      : text || images.length > 0 ? { customResume: null } : {};
  const deliveryTarget: FirstMessageTarget = {
    here: !onOtherMachine, machineName: machine?.name ?? 'the machine', runtimes, chatTabsHere: config?.chatTabsEnabled === true, wsl, agent,
    profile: !!to?.profileRef, launchCommand: launch.launchCommand ?? shownLaunch.launchCommand, customResume: launch.customResume ?? null,
  };
  // Images go with the first message through the new Session's chat; text rides on the create.
  const attachBlocked = imagesBlocked(deliveryTarget);
  const createBlocked = machineUnavailable
    ?? (readingImages > 0 ? 'Reading the attached images…' : undefined)
    ?? (images.length > 0 ? attachBlocked : undefined)
    ?? (text && launch.customResume && !to?.profileRef ? 'A Session that resumes with a custom command can\'t take a first message. Its resume template comes from Settings › AI Agents: change the launch command in More options, or remove the message.' : undefined)
    ?? (text && images.length === 0 ? textBlocked(deliveryTarget) : undefined);

  // Pane: a project on the Run on machine, then CreatePaneForm's own fields.
  const [chosenRepository, setChosenRepository] = useState<{ machineId: string; id: number; name: string } | null>(null);
  const [otherRepositories, setOtherRepositories] = useState<{ machineId: string; list?: RepositoryOption[]; error?: string } | null>(null);
  const machineId = machine?.id;
  const machineName = machine?.name;
  useEffect(() => {
    if (mode !== 'pane' || !onOtherMachine || !machineId || !machineName) return;
    let live = true;
    setOtherRepositories({ machineId });
    readRepositories({ id: machineId, name: machineName }).then(
      list => { if (live) setOtherRepositories({ machineId, list }); },
      (cause: unknown) => { if (live) setOtherRepositories({ machineId, error: cause instanceof Error ? cause.message : `Could not read ${machineName}'s repositories.` }); },
    );
    return () => { live = false; };
  }, [mode, onOtherMachine, machineId, machineName]);
  const switchEntry = entries.find(entry => entry.id === machineId);
  const switchTo = switchEntry ? () => onSwitchMachine(switchEntry) : null;
  const otherMachine = useMemo(() => onOtherMachine && machineId && machineName ? {
    listBranches: (projectId: number) => readBranches({ id: machineId, name: machineName }, projectId),
    create: async (request: CreateSessionRequest) => {
      const { reply, createdIds, stop } = await createPaneOn({ id: machineId }, request);
      if (reply.success) {
        rememberNewMachine(machineId);
        const entry = entries.find(candidate => candidate.id === machineId);
        void openAfterSwitch(machineName, entry ? () => onSwitchMachine(entry) : null, () => openCreatedPane(createdIds)).finally(stop);
      }
      return reply;
    },
  } : undefined, [onOtherMachine, machineId, machineName, entries, onSwitchMachine]);
  const repositories: RepositoryOption[] | undefined = !onOtherMachine ? projects
    : otherRepositories?.machineId === machineId ? otherRepositories?.list : undefined;
  const repository = repositories && (
    (chosenRepository?.machineId === machineId ? repositories.find(item => item.id === chosenRepository?.id) : undefined)
    ?? (chosenRepository ? repositories.find(item => item.name === chosenRepository.name) : undefined)
    ?? (!onOtherMachine ? repositories.find(item => item.id === defaultProjectId) : undefined)
    ?? repositories[0]);
  const repositoriesError = otherRepositories?.machineId === machineId ? otherRepositories?.error : undefined;

  const switchMode = (next: CreateNewMode) => {
    setMode(next);
    rememberMode(next);
    setScreen('main');
    setError(null);
  };

  const addImages = async (files: readonly File[]) => {
    if (attachBlocked) { setError(attachBlocked); return; }
    const refused = files.filter(file => !isAttachableImage(file));
    // The chat's own limit, checked before anything is read.
    const tooLarge = files.filter(file => isAttachableImage(file) && file.size > MAX_IMAGE_BYTES);
    const accepted = files.filter(file => isAttachableImage(file) && file.size <= MAX_IMAGE_BYTES);
    const reasons = [
      refused.length ? `${refused.map(file => file.name).join(', ')} ${refused.length === 1 ? 'isn\'t' : 'aren\'t'} attached: a Session's first message takes PNG, JPEG, WebP or GIF images.` : '',
      tooLarge.length ? `${tooLarge.map(file => file.name).join(', ')} ${tooLarge.length === 1 ? 'isn\'t' : 'aren\'t'} attached: larger than ${formatSize(MAX_IMAGE_BYTES)}, the most a chat sends as an image. Attach ${tooLarge.length === 1 ? 'it' : 'them'} in the Session's chat, which sends a larger file as a file.` : '',
    ].filter(Boolean);
    if (accepted.length === 0) { setError(reasons.length ? reasons.join(' ') : null); return; }
    // Create waits for these reads, so nothing is left out of the first message (F-2).
    setReadingImages(count => count + 1);
    try {
      const read = await Promise.all(accepted.map(readImageAttachment));
      setImages(current => [...current, ...read]);
      setError(reasons.length ? reasons.join(' ') : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'An image could not be read. Attach it again.');
    } finally {
      setReadingImages(count => count - 1);
    }
  };

  const createSession = async () => {
    if (busy || !machine) return;
    if (!to) { setError('Pick who the Session is to: an agent or a profile.'); toRef.current?.focus(); return; }
    // The draft stays as it is until it can all be delivered (F-1, F-2, F-4).
    if (createBlocked) { setError(createBlocked); return; }
    setBusy(true);
    setError(null);
    const typedName = name.trim();
    const sendImages = images.length > 0;
    const input: Omit<OrchestrationSessionCreateInput, 'name'> = {
      ...sessionChoiceInput(to),
      isPinned: settings.startPinned,
      goal: settings.goal.trim() || undefined,
      ...launch,
      profile: settings.profile,
    };
    if (wsl) {
      input.runtime = 'wsl';
      input.wslDistribution = wslDistribution;
    }
    // A message with images goes through the chat once it's open; text alone rides with the create.
    const opening = sendImages ? undefined : newSessionFirstMessagePrompt(text);
    if (opening) input.openingPrompt = opening;
    try {
      if (onOtherMachine) {
        const sessionName = typedName || nextOrchestrationSessionName(await readSessionNames(machine));
        const sessionId = await createSessionOn(machine, { ...input, name: sessionName, nameFromFirstMessage: !typedName });
        rememberNewMachine(machine.id);
        rememberTo(to.key);
        await rememberOnMachine(machine.id, { kind: 'session', id: sessionId, name: sessionName }).catch(() => undefined);
        onClose();
        void openAfterSwitch(machine.name, switchTo, () => openCreatedSession(sessionId));
        return;
      }
      if (!window.electronAPI?.orchestrationSessions) throw new Error('This host does not support Sessions.');
      const store = useOrchestrationSessionStore.getState();
      await store.load();
      const sessionName = typedName || nextOrchestrationSessionName(useOrchestrationSessionStore.getState().sessions);
      const view = await store.create({ ...input, name: sessionName, nameFromFirstMessage: !typedName });
      rememberNewMachine(machine.id);
      rememberTo(to.key);
      // As the old dialog did: an agent picked on its own, and launch settings you changed, become the defaults.
      const defaults: Partial<AppConfig> = {};
      if (!to.profileRef && input.agent && config?.defaultOrchestratorAgent !== input.agent) defaults.defaultOrchestratorAgent = input.agent;
      // The command and the template it started with are saved together (#1762 F-1).
      const launch = launchEdited.current ? rememberedLaunchDefaults(config, settings.launchCommand, input.customResume ?? null) : null;
      if (launch) Object.assign(defaults, launch);
      if (Object.keys(defaults).length > 0) void updateConfig(defaults).catch(() => undefined);
      if (sendImages) {
        const chat = window.electronAPI.chatTab;
        try {
          if (view.panel.type !== 'chat') throw new Error('the Session started in a terminal, which takes no images');
          await chat.send(view.panel.id, { operationId: crypto.randomUUID(), text, images: images.map(image => ({ mimeType: image.mimeType, data: image.data })) });
        } catch (cause) {
          // The draft isn't lost: in a chat it waits, unsent, in the Session's composer.
          const kept = view.panel.type === 'chat';
          if (kept) {
            chatTabViewer(chat, view.panel.id).setDraft(text);
            await Promise.all(images.map(image => addDraftAttachment(chat, view.panel.id, image.file))).catch(() => undefined);
          }
          useErrorStore.getState().showError({
            title: 'Session created; first message not sent',
            error: `The Session was created, but its first message wasn't sent: ${cause instanceof Error ? cause.message : 'Pane did not say why'}. ${kept ? 'It is waiting, unsent, in the Session\'s chat: send it from there.' : `Send it from the Session: ${text || 'your images'}`}`,
          });
        }
      }
      void useSessionStore.getState().setActiveSession(null);
      useNavigationStore.getState().navigateToPaneChat();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pane could not create the Session and gave no reason. Try again.');
      setBusy(false);
    }
  };

  const title = SCREEN_TITLES[mode][screen];
  // Back on the options screen, More options on the main one; no Session/Pane toggle up here.
  const header = (
    <div className="flex items-center gap-2 border-b border-border-primary px-6 py-4">
      {screen === 'options' && (
        <button type="button" onClick={() => setScreen('main')} aria-label="Back" disabled={busy}
          className="-ml-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      <h2 className="min-w-0 flex-1 truncate text-heading-2 text-text-primary">{title}</h2>
      {screen === 'main' && (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setScreen('options'); setError(null); }}>More options</Button>
      )}
      <button type="button" aria-label="Close" onClick={onClose} disabled={busy}
        className="rounded p-1 text-text-tertiary transition-colors hover:text-text-secondary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );

  const runOn = (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="flex-none whitespace-nowrap text-text-secondary">Run on</span>
      <select
        aria-label="Run on"
        value={machine?.id ?? ''}
        disabled={busy}
        onChange={event => { setPickedId(event.target.value); setError(null); }}
        onKeyDown={event => { if (event.key === 'Enter' && mode === 'session' && screen === 'main') { event.preventDefault(); void createSession(); } }}
        className="h-8 min-w-0 max-w-[16rem] rounded-md border border-border-primary bg-bg-primary pl-2 pr-7 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive"
      >
        {orderedMachines.map(candidate => {
          const note = candidate.current ? ' (this computer)' : candidate.status === 'offline' ? ' (offline)' : candidate.status === 'connecting' ? ' (connecting)' : '';
          return <option key={candidate.id} value={candidate.id} disabled={!candidate.current && candidate.status !== 'online'}>{candidate.name}{note}</option>;
        })}
      </select>
    </label>
  );

  // Create, and its menu that switches between a Session and a Pane.
  const createButton = (submit: { type: 'button'; onClick: () => void } | { type: 'submit'; form: string }, disabled: boolean, loading: boolean, blocked?: string) => (
    <div className="inline-flex">
      <Button {...submit} disabled={disabled} loading={loading} loadingText="Creating…" title={blocked} data-testid="create-new-submit" className="h-9 flex-none whitespace-nowrap rounded-r-none">
        {CREATE_LABELS[mode]}
      </Button>
      <Dropdown
        trigger={<Button type="button" disabled={busy} aria-label="Create a Session or a Pane" className="h-9 rounded-l-none border-l border-l-[color-mix(in_srgb,currentColor_25%,transparent)] px-2">
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </Button>}
        items={(['session', 'pane'] as const).map(id => ({ id, label: CREATE_LABELS[id], onClick: () => switchMode(id) }))}
        selectedId={mode}
        selectedMark="check"
        position="top-right"
        width="sm"
        menuLabel="Create"
      />
    </div>
  );

  const footer = (create: React.ReactNode) => (
    <ModalFooter className="justify-start">
      {runOn}
      <span className="flex-1" />
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      {create}
    </ModalFooter>
  );

  const handleMessageKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void createSession();
    }
  };
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };
  const dropProps = mode === 'session' && screen === 'main' ? {
    onDragOver: (event: ReactDragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } },
    onDragLeave: (event: ReactDragEvent) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false); },
    onDrop: (event: ReactDragEvent) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      setDragging(false);
      void addImages([...event.dataTransfer.files]);
      messageRef.current?.focus();
    },
  } : {};

  const sessionMain = (
    <ModalBody className="space-y-3">
      {/* To and Name are one header, a field-row gap apart (build 9 feedback 5); the message sits below them. */}
      <div className="space-y-2" data-testid="create-new-header-fields">
      <div className="flex items-center gap-3">
        <span className="w-14 flex-none text-sm text-text-secondary" aria-hidden="true">To</span>
        <ToField ref={toRef} choices={choices} value={to} disabled={busy} profilesStatus={profilesStatus} onOpenChange={setToListOpen}
          onPick={choice => { setToKey(choice.key); setError(null); }} onPicked={() => nameRef.current?.focus()} />
      </div>
      <div className="flex items-center gap-3">
        <label htmlFor={nameId} className="w-14 flex-none text-sm text-text-secondary">Name</label>
        <input id={nameId} ref={nameRef} type="text" value={name} disabled={busy} autoComplete="off"
          onChange={event => setName(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); messageRef.current?.focus(); } }}
          placeholder="Optional: named from your first message"
          className="h-9 min-w-0 flex-1 rounded-md border border-border-primary bg-bg-primary px-2.5 text-[13.5px] text-text-primary placeholder:text-text-muted focus:border-interactive focus:outline-none focus:ring-2 focus:ring-interactive" />
      </div>
      </div>
      <div className={cn('rounded-lg border border-border-primary bg-bg-primary transition-colors focus-within:border-interactive focus-within:ring-2 focus-within:ring-interactive', dragging && 'border-interactive')}>
        <label htmlFor={messageId} className="sr-only">Message</label>
        <textarea id={messageId} ref={messageRef} value={message} disabled={busy} rows={5}
          onChange={event => setMessage(event.target.value)} onKeyDown={handleMessageKeyDown} onPaste={onPaste}
          placeholder="What should this Session do?"
          className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13.5px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none" />
        {images.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 px-3 pt-1">
            {images.map(image => (
              <li key={image.id} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-surface-secondary py-1 pl-2 pr-1 text-xs text-text-secondary">
                <FileImage className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                <span className="truncate text-text-primary">{image.name}</span>
                <span>{formatSize(image.size)}</span>
                <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages(current => current.filter(item => item.id !== image.id))}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center px-1.5 pb-1.5 pt-1">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || !!attachBlocked} title={attachBlocked ?? 'Attach images'}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />Attach
          </button>
          <input ref={fileRef} type="file" multiple hidden accept={ATTACHABLE_IMAGE_TYPES.join(',')}
            onChange={event => { void addImages([...(event.target.files ?? [])]); event.target.value = ''; messageRef.current?.focus(); }} />
        </div>
      </div>
      {settings.startPinned && <p className="text-xs text-text-tertiary">Starts pinned. Change it in More options.</p>}
      {error ? <p role="alert" className="text-sm text-status-error">{error}</p>
        : createBlocked && <p role="status" data-testid="create-new-blocked" className="text-sm text-text-secondary">{createBlocked}</p>}
    </ModalBody>
  );

  // The first change to the launch starts from what the fields showed: the chosen agent's defaults.
  const editLaunch = (patch: Partial<Pick<SessionSettings, 'launchCommand'>>) => {
    const base = launchEdited.current ? {} : shownLaunch;
    launchEdited.current = true;
    setSettings(current => ({ ...current, ...base, ...patch }));
  };

  const sessionOptions = (
    <ModalBody className="space-y-5">
      <Textarea label="What is this Session for?" value={settings.goal} rows={2} fullWidth
        onChange={event => setSettings(current => ({ ...current, goal: event.target.value }))} />
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">Start pinned</div>
          <div className="mt-0.5 text-xs text-text-secondary">Show this Session in the pinned section immediately.</div>
        </div>
        <Toggle checked={settings.startPinned} aria-label="Start pinned" size="sm" onChange={checked => setSettings(current => ({ ...current, startPinned: checked }))} />
      </div>
      {distributions.length > 0 && machine && (
        <div className="space-y-2">
          <label htmlFor={`${formId}-runtime`} className="text-label font-medium text-text-primary">Run agent in</label>
          <select id={`${formId}-runtime`} value={wslDistribution} onChange={event => {
            const distribution = event.target.value;
            setSettings(current => ({ ...current, wsl: distribution ? { machineId: machine.id, distribution } : null }));
          }}
            className="w-full rounded border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary focus:ring-2 focus:ring-interactive">
            <option value="">Windows</option>
            {distributions.map(distribution => <option key={distribution} value={distribution}>WSL · {distribution}</option>)}
          </select>
          {wslDistribution && <p className="text-xs text-text-secondary">The agent must be installed in this distribution.</p>}
        </div>
      )}
      <div className="space-y-3">
        <div className="text-sm font-medium text-text-primary">Launch command and behavior</div>
        <p className="text-xs text-text-secondary">For a Session that starts an agent on its own; a profile brings its own launch.</p>
        <p className="text-xs text-text-secondary" data-testid="create-new-resume-note">Pane resumes chat Sessions by itself. A custom command that needs a resume template takes it from Settings › AI Agents › Session defaults.</p>
        <SessionLaunchFields
          command={shownLaunch.launchCommand}
          profile={settings.profile}
          customCommands={config?.customCommands}
          onCommandChange={value => editLaunch({ launchCommand: value })}
          onProfileChange={value => setSettings(current => ({ ...current, profile: value }))}
        />
      </div>
    </ModalBody>
  );

  const projectPicker = repositories && repository && (
    <div className="flex items-center gap-3 px-6 pt-5">
      <label htmlFor={`${formId}-project`} className="w-14 flex-none text-sm text-text-secondary">Project</label>
      <select id={`${formId}-project`} value={repository.id} disabled={busy} onChange={event => {
        const next = repositories.find(item => item.id === Number(event.target.value));
        setBranchDropdownOpen(false);
        if (next && machineId) setChosenRepository({ machineId, id: next.id, name: next.name });
      }} className="h-9 min-w-0 flex-1 rounded-md border border-border-primary bg-bg-primary px-2 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
        {repositories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </div>
  );
  const paneNotice = (notice: string) => <>
    {header}
    <ModalBody><p className="text-sm text-text-secondary">{notice}</p></ModalBody>
    {footer(screen === 'main' && createButton({ type: 'button', onClick: () => undefined }, true, false, notice))}
  </>;

  return (
    <Modal isOpen onClose={() => { if (!busy) onClose(); }} size="lg" ariaLabel={title} showCloseButton={false}
      closeOnOverlayClick={false} closeOnEscape={!busy && !branchDropdownOpen && !toListOpen}
      initialFocusRef={mode === 'session' ? toRef : undefined} className="!max-w-[620px]">
      {/* The whole dialog takes a dropped image for the first message. */}
      <div className="flex min-h-0 flex-col" data-testid="create-new-dialog" data-mode={mode} {...dropProps}>
        {mode === 'session' ? <>
          {header}
          {screen === 'main' ? sessionMain : sessionOptions}
          {footer(screen === 'main' && createButton({ type: 'button', onClick: () => void createSession() }, busy || !machine || !!createBlocked, busy, createBlocked))}
        </>
          : !machine ? <>{header}<ModalBody>{null}</ModalBody></>
            : repositoriesError ? paneNotice(repositoriesError)
              : !repositories ? paneNotice(`Reading ${machine.name}'s repositories…`)
                : !repository ? paneNotice(onOtherMachine ? `${machine.name} has no repositories yet. Switch to ${machine.name} and add one with the + beside Projects.` : 'A Pane needs a repository. Add one with the + beside Projects.')
                  : <CreatePaneForm key={machine.id} isOpen projectId={repository.id} projectName={repository.name} onClose={onClose}
                    header={header} repositoryPicker={projectPicker} optionsScreen={screen === 'options'}
                    otherMachine={otherMachine} onSessionCreated={() => rememberNewMachine(machine.id)}
                    onBranchDropdownOpenChange={setBranchDropdownOpen} onSubmittingChange={setBusy}
                    renderFooter={({ formId: paneFormId, submitting, blocked }: CreatePaneFooterState) => footer(screen === 'main' && createButton({ type: 'submit', form: paneFormId }, submitting || !!(machineUnavailable ?? blocked), submitting, machineUnavailable ?? blocked))} />}
      </div>
    </Modal>
  );
}
