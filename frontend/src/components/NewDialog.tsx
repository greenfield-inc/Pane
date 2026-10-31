import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, MessageSquare } from 'lucide-react';
import type { Project } from '../types/project';
import type { CreateSessionRequest } from '../types/session';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useErrorStore } from '../stores/errorStore';
import { nextHostRestored } from '../hooks/useIPCEvents';
import type { MachineSelectOutcome } from '../hooks/useMachines';
import { nextOrchestrationSessionName } from '../../../shared/types/orchestrationSession';
import { LOCAL_MACHINE_ID, type MachineState } from '../../../shared/types/machineConnections';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import type { MachineEntry, MachineOs } from '../utils/machineList';
import {
  createPaneOn,
  createSessionOn,
  lastNewMachineId,
  newMachines,
  readBranches,
  readRepositories,
  readRuntimes,
  readSessionNames,
  rememberNewMachine,
  startingNewMachineId,
  type NewMachine,
  type RepositoryOption,
} from '../utils/newOnMachine';
import { cn } from '../utils/cn';
import { openPaneTarget } from './terminal/openPaneLink';
import { OrchestrationSessionForm } from './CreateOrchestrationSessionDialog';
import { CreatePaneForm } from './CreateSessionDialog';
import { MachineMark } from './machines/MachineMark';
import { SegmentedControl } from './settings/SettingsControls';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';

interface NewDialogProps {
  /** The repositories of the machine the app is on. */
  projects: Project[];
  defaultProjectId?: number;
  /** The machine menu's list, for names, OS logos and colours, and to switch machines after a create. */
  machines: MachineEntry[];
  onSwitchMachine: (machine: MachineEntry) => Promise<MachineSelectOutcome>;
  onClose: () => void;
}

/** A machine switch reloads every list first; give a slow machine this long before opening anyway. */
const SWITCH_RESTORE_TIMEOUT_MS = 60_000;

const KIND_OPTIONS = [
  { id: 'session', label: <span className="inline-flex items-center gap-1.5"><MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />Session</span> },
  { id: 'pane', label: <span className="inline-flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" aria-hidden="true" />Pane</span> },
] as const;

const ENVIRONMENT_BY_OS = { macOS: 'macos', Windows: 'windows', Linux: 'linux' } satisfies Record<MachineOs, ProjectEnvironment>;

/** Every machine the desktop keeps a connection to, live; null until first listed. */
function useMachineStates(): MachineState[] | null {
  const [states, setStates] = useState<MachineState[] | null>(() => window.electronAPI?.machines ? null : []);
  useEffect(() => {
    const api = window.electronAPI?.machines;
    if (!api) return;
    let live = true;
    void api.list().then(list => { if (live) setStates(list); }).catch(() => { if (live) setStates([]); });
    const unsubscribe = api.onEvent(event => { if (event.type === 'machines') setStates(event.machines); });
    return () => { live = false; unsubscribe(); };
  }, []);
  return states;
}

/** Switches the app to the machine something was just created on, then opens it there. */
async function openAfterSwitch(machineName: string, select: (() => Promise<MachineSelectOutcome>) | null, open: () => Promise<void>): Promise<void> {
  const failed = (why: string) => useErrorStore.getState().showError({
    title: `Created on ${machineName}`,
    error: `It was created on ${machineName}, but Pane could not switch there: ${why} Pick ${machineName} in the machine menu to open it.`,
  });
  if (!select) return failed('the machine menu does not list it yet.');
  try {
    const restored = nextHostRestored(SWITCH_RESTORE_TIMEOUT_MS);
    const outcome = await select();
    if (!outcome.ok) return failed(outcome.needsPassword ? 'it needs its password.' : outcome.error);
    await restored;
    await open();
  } catch (cause) {
    failed(cause instanceof Error ? cause.message : 'Pane did not say why.');
  }
}

async function openSession(sessionId: string): Promise<void> {
  await useOrchestrationSessionStore.getState().select({ sessionId });
  await useSessionStore.getState().setActiveSession(null);
  useNavigationStore.getState().navigateToPaneChat();
}

/** Opens the first new Pane once it is listed; one still being set up opens itself when it arrives. */
async function openCreatedPane(createdIds: readonly string[]): Promise<void> {
  const { sessions } = useSessionStore.getState();
  const paneId = createdIds.find(id => sessions.some(session => session.id === id && !session.archived));
  if (paneId) await openPaneTarget({ paneId });
  else useNavigationStore.getState().navigateToSessions();
}

function MachinePicker({ machines, selectedId, lastUsedId, disabled, onPick }: {
  machines: NewMachine[];
  selectedId: string;
  lastUsedId: string | null;
  disabled: boolean;
  onPick: (machineId: string) => void;
}) {
  return <div>
    <div id="new-machine-label" className="mb-2 text-sm font-medium text-text-primary">Machine</div>
    <div role="radiogroup" aria-labelledby="new-machine-label" className="flex flex-wrap gap-2">
      {machines.map(machine => {
        const usable = machine.status === 'online';
        const selected = machine.id === selectedId;
        const note = machine.status === 'offline' ? 'offline'
          : machine.status === 'connecting' ? 'connecting'
            : machine.id === lastUsedId ? 'last used' : null;
        return <button
          key={machine.id}
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={disabled || !usable}
          title={usable ? undefined : `${machine.name} is ${machine.status === 'offline' ? 'offline' : 'still connecting'}. New can create there once it answers.`}
          onClick={() => onPick(machine.id)}
          className={cn(
            'inline-flex h-8 items-center gap-2 rounded border pl-1.5 pr-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-interactive',
            selected ? 'border-interactive bg-surface-selected text-text-primary' : 'border-border-primary text-text-secondary enabled:hover:bg-surface-hover enabled:hover:text-text-primary',
            !usable && 'opacity-40',
          )}
        >
          <MachineMark os={machine.os} slot={machine.slot} presence={usable ? 'solid' : 'dimmed'} size="sm" />
          <span>{machine.name}</span>
          {note && <span className="text-xs font-normal text-text-tertiary">{note}</span>}
        </button>;
      })}
    </div>
  </div>;
}

// One modal owns focus for both forms. The section + controls continue to use
// the standalone dialogs around these same forms.
export function NewDialog({ projects, defaultProjectId, machines: entries, onSwitchMachine, onClose }: NewDialogProps) {
  const [kind, setKind] = useState<'session' | 'pane'>('session');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [chosenRepository, setChosenRepository] = useState<{ machineId: string; id: number; name: string } | null>(null);
  const [otherRepositories, setOtherRepositories] = useState<{ machineId: string; list?: RepositoryOption[]; error?: string } | null>(null);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastUsedId] = useState(lastNewMachineId);
  const states = useMachineStates();
  const currentId = entries.find(entry => entry.active)?.id ?? LOCAL_MACHINE_ID;
  const machines = useMemo(() => states ? newMachines(states, entries, currentId) : [], [states, entries, currentId]);
  const machine = machines.find(candidate => candidate.id === pickedId && candidate.status === 'online')
    ?? machines.find(candidate => candidate.id === startingNewMachineId(machines));
  const machineId = machine?.id;
  const machineName = machine?.name;
  const onOtherMachine = machine !== undefined && !machine.current;
  const showPicker = machines.length > 1;

  // The latest switch action, read when a create finishes rather than tracked by the forms.
  const switchTo = useRef<(() => Promise<MachineSelectOutcome>) | null>(null);
  const switchEntry = entries.find(entry => entry.id === machineId);
  useEffect(() => {
    switchTo.current = switchEntry ? () => onSwitchMachine(switchEntry) : null;
  }, [switchEntry, onSwitchMachine]);

  useEffect(() => {
    if (kind !== 'pane' || !onOtherMachine || !machineId || !machineName) return;
    let live = true;
    setOtherRepositories({ machineId });
    readRepositories({ id: machineId, name: machineName }).then(
      list => { if (live) setOtherRepositories({ machineId, list }); },
      (cause: unknown) => { if (live) setOtherRepositories({ machineId, error: cause instanceof Error ? cause.message : `Could not read ${machineName}'s repositories.` }); },
    );
    return () => { live = false; };
  }, [kind, onOtherMachine, machineId, machineName, readAttempt]);

  const otherMachine = useMemo(() => onOtherMachine && machineId && machineName ? {
    listBranches: (projectId: number) => readBranches({ id: machineId, name: machineName }, projectId),
    create: async (request: CreateSessionRequest) => {
      const { reply, createdIds, stop } = await createPaneOn({ id: machineId }, request);
      if (reply.success) void openAfterSwitch(machineName, switchTo.current, () => openCreatedPane(createdIds)).finally(stop);
      return reply;
    },
  } : undefined, [onOtherMachine, machineId, machineName]);
  const otherRuntimes = useMemo(() => onOtherMachine && machineId && machineName
    ? () => readRuntimes({ id: machineId, name: machineName })
    : undefined, [onOtherMachine, machineId, machineName]);

  const repositories: RepositoryOption[] | undefined = !onOtherMachine ? projects
    : otherRepositories?.machineId === machineId ? otherRepositories?.list : undefined;
  const repository = repositories && (
    (chosenRepository?.machineId === machineId ? repositories.find(item => item.id === chosenRepository?.id) : undefined)
    ?? (chosenRepository ? repositories.find(item => item.name === chosenRepository.name) : undefined)
    ?? (!onOtherMachine ? repositories.find(item => item.id === defaultProjectId) : undefined)
    ?? repositories[0]);
  const environment = machine?.os ? ENVIRONMENT_BY_OS[machine.os] : undefined;

  const pick = (id: string) => {
    setBranchDropdownOpen(false);
    setPickedId(id);
    setReadAttempt(attempt => attempt + 1);
  };

  const header = <>
    <ModalHeader title="New" />
    <div className="space-y-4 px-6 pt-4">
      <SegmentedControl label="Create" value={kind} options={KIND_OPTIONS} disabled={isSubmitting} onChange={next => { setBranchDropdownOpen(false); setKind(next); }} />
      {showPicker && machine && <MachinePicker machines={machines} selectedId={machine.id} lastUsedId={lastUsedId} disabled={isSubmitting} onPick={pick} />}
    </div>
  </>;
  const formMachineName = showPicker ? machineName : undefined;

  const notice = (text: string) => <>
    {header}
    <ModalBody><p className="text-sm text-text-secondary">{text}</p></ModalBody>
    <ModalFooter><Button variant="secondary" className="focus-visible:ring-interactive" onClick={onClose}>Close</Button></ModalFooter>
  </>;

  return <Modal isOpen onClose={() => { if (!isSubmitting) onClose(); }} size="md" closeOnOverlayClick={false} closeOnEscape={!branchDropdownOpen && !isSubmitting}>
    {!machine ? <>{header}<ModalBody>{null}</ModalBody></>
      : kind === 'session' ? <OrchestrationSessionForm key={machine.id} isOpen header={header} onClose={onClose} onSubmittingChange={setIsSubmitting}
        machineName={formMachineName} environment={environment} readRuntimes={otherRuntimes}
        onCreate={async ({ name: requestedName, ...input }) => {
          if (onOtherMachine) {
            const name = requestedName || nextOrchestrationSessionName(await readSessionNames(machine));
            const sessionId = await createSessionOn(machine, { ...input, name, nameFromFirstMessage: !requestedName });
            rememberNewMachine(machine.id);
            onClose();
            void openAfterSwitch(machine.name, switchTo.current, () => openSession(sessionId));
            return;
          }
          if (!window.electronAPI?.orchestrationSessions) throw new Error('This host does not support Sessions.');
          const store = useOrchestrationSessionStore.getState();
          await store.load();
          const name = requestedName || nextOrchestrationSessionName(useOrchestrationSessionStore.getState().sessions);
          await store.create({ ...input, name, nameFromFirstMessage: !requestedName });
          rememberNewMachine(machine.id);
          useSessionStore.getState().setActiveSession(null);
          useNavigationStore.getState().navigateToPaneChat();
          onClose();
        }} />
      : repository ? <CreatePaneForm key={machine.id} isOpen projectId={repository.id} projectName={repository.name} onClose={onClose} header={header}
        machineName={formMachineName} otherMachine={otherMachine} onSessionCreated={() => rememberNewMachine(machine.id)}
        onBranchDropdownOpenChange={setBranchDropdownOpen} onSubmittingChange={setIsSubmitting} repositoryPicker={
          <div className="px-6 pt-4">
            <label htmlFor="new-pane-repository" className="mb-2 block text-sm font-medium text-text-primary">Repository</label>
            <select id="new-pane-repository" value={repository.id} disabled={isSubmitting} onChange={event => {
              const next = repositories?.find(item => item.id === Number(event.target.value));
              setBranchDropdownOpen(false);
              if (next) setChosenRepository({ machineId: machine.id, id: next.id, name: next.name });
            }} className="w-full rounded border border-border-primary bg-bg-primary px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
              {repositories?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        } />
      : !onOtherMachine ? notice('A Pane needs a repository. Add one with the + beside Projects.')
      : otherRepositories?.machineId === machine.id && otherRepositories.error ? notice(otherRepositories.error)
      : repositories ? notice(`${machine.name} has no repositories yet. Switch to ${machine.name} and add one with the + beside Projects.`)
      : notice(`Reading ${machine.name}'s repositories…`)}
  </Modal>;
}
