import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { CornerDownLeft, Plus } from 'lucide-react';
import { CONFIGURED_AGENT_IDS } from '../../../shared/agents';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import { nextOrchestrationSessionName, type OrchestrationSessionCreateInput } from '../../../shared/types/orchestrationSession';
import type { AgentFarmProfileList } from '../../../shared/types/agentFarmProfiles';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import type { MachineSelectOutcome } from '../hooks/useMachines';
import { useMachineStates } from '../hooks/useMachineStates';
import { useConfigStore } from '../stores/configStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useSessionStore } from '../stores/sessionStore';
import { visibleAgentPresets } from '../utils/agentPresets';
import { cn } from '../utils/cn';
import type { MachineEntry, MachineOs } from '../utils/machineList';
import { rememberOnMachine } from '../utils/machineRowActions';
import { createSessionOn, newMachines, readProfiles, readSessionNames, rememberNewMachine, type NewMachine } from '../utils/newOnMachine';
import { openAfterSwitch, openCreatedSession } from '../utils/openAfterSwitch';
import { onOpenNewSessionPaletteRequest } from '../utils/openNewSessionPalette';
import { filterSessionChoices, sessionChoiceInput, sessionChoices, type SessionChoice } from '../utils/sessionPaletteChoices';
import { ProfileAvatar } from './profiles/ProfileAvatar';
import { Kbd } from './ui/Kbd';
import { Modal } from './ui/Modal';

const ENVIRONMENT_BY_OS = { macOS: 'macos', Windows: 'windows', Linux: 'linux' } satisfies Record<MachineOs, ProjectEnvironment>;

const GROUP_LABELS = { agents: 'Agents', profiles: 'Profiles', other: 'Other agents' } satisfies Record<SessionChoice['group'], string>;

/** One entry of the Run on popup: a machine, or this computer's WSL distribution. */
interface RunOnOption {
  value: string;
  machine: NewMachine;
  wslDistribution?: string;
  label: string;
  disabled: boolean;
}

function runOnOptions(machines: readonly NewMachine[], distributions: readonly string[]): RunOnOption[] {
  const ordered = [...machines.filter(machine => machine.current), ...machines.filter(machine => !machine.current)];
  return ordered.flatMap(machine => {
    if (machine.current) {
      return [
        { value: machine.id, machine, label: `${machine.name} (this computer)`, disabled: false },
        ...distributions.map(distribution => ({ value: `${machine.id}\u0000wsl\u0000${distribution}`, machine, wslDistribution: distribution, label: `${machine.name} · WSL ${distribution}`, disabled: false })),
      ];
    }
    const note = machine.status === 'offline' ? ' (offline)' : machine.status === 'connecting' ? ' (connecting)' : '';
    return [{ value: machine.id, machine, label: `${machine.name}${note}`, disabled: machine.status !== 'online' }];
  });
}

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

/** This computer's WSL distributions, which Run on offers beside it. */
function useLocalDistributions(): string[] {
  const [distributions, setDistributions] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void window.electronAPI?.orchestrationSessions?.runtimes?.().then(result => {
      if (live && result.success) setDistributions(result.data?.distributions ?? []);
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return distributions;
}

interface SessionPickerProps {
  /** The machine menu's list: names and marks, and the switch after creating on another machine. */
  entries: readonly MachineEntry[];
  onSwitchMachine: (machine: MachineEntry) => Promise<MachineSelectOutcome>;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  /** The top of the picker: the palette's own search row, or the New dialog's header. */
  autoFocus?: boolean;
  /** Tab moves only between the filter and Run on: the palette alone. Inside the New dialog Tab moves through the dialog. */
  trapTab?: boolean;
  className?: string;
}

/**
 * The New Session picker (T-63): type to filter Claude, Codex, profiles and Other agents; ↑↓ choose;
 * Tab moves to the Run on popup and back; Return creates. The Session is named from its first message.
 */
export function SessionPicker({ entries, onSwitchMachine, onClose, onBusyChange, autoFocus = true, trapTab = false, className }: SessionPickerProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const runOnRef = useRef<HTMLSelectElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const config = useConfigStore(state => state.config);
  const updateConfig = useConfigStore(state => state.updateConfig);
  const states = useMachineStates();
  const currentId = entries.find(entry => entry.active)?.id ?? LOCAL_MACHINE_ID;
  const machines = useMemo(() => newMachines(states ?? [], entries, currentId), [states, entries, currentId]);
  const distributions = useLocalDistributions();
  const options = useMemo(() => runOnOptions(machines, distributions), [machines, distributions]);
  const [runOnValue, setRunOnValue] = useState<string | null>(null);
  const runOn = options.find(option => option.value === runOnValue && !option.disabled) ?? options.find(option => option.machine.current) ?? options[0];
  const machine = runOn?.machine;
  const wsl = !!runOn?.wslDistribution;
  const profilesRead = useMachineProfiles(machine);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This computer offers the agents its own platform runs; another machine, those its OS runs.
  const environment = machine && !machine.current && machine.os ? ENVIRONMENT_BY_OS[machine.os] : undefined;
  const profilesUnavailable = wsl ? 'Profiles run in chat tabs, which don\'t run in WSL. Pick this computer without WSL to start one.'
    : machine?.current && config && config.chatTabsEnabled !== true ? 'Profiles run in chat tabs, which are off. Turn on Chat tabs in Settings › AI & Agents to start one.'
      : undefined;
  const choices = useMemo(() => sessionChoices({
    agents: availableAgents(environment, wsl),
    profiles: profilesRead?.list?.profiles ?? [],
    profilesUnavailable,
  }), [environment, wsl, profilesRead, profilesUnavailable]);
  const shown = useMemo(() => filterSessionChoices(choices, query), [choices, query]);
  // Unfiltered, the palette starts on the default agent (the one last picked on its own).
  const startChoice = shown.find(choice => !choice.profileRef && choice.agent === config?.defaultOrchestratorAgent);
  const active = shown.find(choice => choice.key === activeKey) ?? (query ? shown[0] : startChoice ?? shown[0]);
  const optionId = (choice: SessionChoice) => `${listboxId}-${choice.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!active) return;
    listRef.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' });
  });

  const move = (step: number) => {
    if (shown.length === 0 || !active) return;
    const index = shown.indexOf(active);
    setActiveKey(shown[(index + step + shown.length) % shown.length].key);
  };

  const create = async (choice: SessionChoice | undefined) => {
    if (!choice || !machine || busy) return;
    if (choice.disabledReason) { setError(choice.disabledReason); return; }
    setBusy(true);
    setError(null);
    const input: Omit<OrchestrationSessionCreateInput, 'name'> = { ...sessionChoiceInput(choice), isPinned: config?.defaultSessionPinned ?? false };
    if (runOn?.wslDistribution) {
      input.runtime = 'wsl';
      input.wslDistribution = runOn.wslDistribution;
    }
    try {
      if (!machine.current) {
        const name = nextOrchestrationSessionName(await readSessionNames(machine));
        const sessionId = await createSessionOn(machine, { ...input, name, nameFromFirstMessage: true });
        rememberNewMachine(machine.id);
        // Without the memory the switch still works; openCreatedSession then selects it after the restore.
        await rememberOnMachine(machine.id, { kind: 'session', id: sessionId, name }).catch(() => undefined);
        const entry = entries.find(candidate => candidate.id === machine.id);
        onClose();
        void openAfterSwitch(machine.name, entry ? () => onSwitchMachine(entry) : null, () => openCreatedSession(sessionId));
        return;
      }
      if (!window.electronAPI?.orchestrationSessions) throw new Error('This host does not support Sessions.');
      const store = useOrchestrationSessionStore.getState();
      await store.load();
      const name = nextOrchestrationSessionName(useOrchestrationSessionStore.getState().sessions);
      await store.create({ ...input, name, nameFromFirstMessage: true });
      rememberNewMachine(machine.id);
      // An agent picked on its own becomes the default the palette starts on next time.
      if (!choice.profileRef && input.agent && config?.defaultOrchestratorAgent !== input.agent) void updateConfig({ defaultOrchestratorAgent: input.agent }).catch(() => undefined);
      void useSessionStore.getState().setActiveSession(null);
      useNavigationStore.getState().navigateToPaneChat();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pane could not create the Session and gave no reason. Try again.');
      setBusy(false);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const inInput = event.target === inputRef.current;
    const inRunOn = event.target === runOnRef.current;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && inInput) {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (trapTab && event.key === 'Tab' && !event.altKey && !event.metaKey && !event.ctrlKey && (inInput || inRunOn)) {
      // Tab and Shift+Tab move between the filter and Run on only, as the footer says. The modal's
      // focus trap would otherwise see Run on as its last stop and wrap focus back to the filter.
      event.preventDefault();
      event.stopPropagation();
      (inInput ? runOnRef.current : inputRef.current)?.focus();
    } else if (event.key === 'Enter' && (inInput || inRunOn)) {
      event.preventDefault();
      void create(active);
    }
  };

  const machineName = machine?.name ?? 'this computer';
  const note = error ?? (busy ? 'Creating the Session…'
    : active?.disabledReason ?? (machine && !machine.current
      ? active?.profileRef ? `Runs on ${machineName}, with ${machineName}'s own copy of ${active.label}.` : `Runs on ${machineName}.`
      : null));
  const profilesStatus = profilesRead === null || (!profilesRead.list && !profilesRead.error) ? `Reading ${machine?.current ? 'this computer' : machineName}'s profiles…`
    : profilesRead.error ? `Profiles unavailable: ${profilesRead.error}`
      : profilesRead.list?.error && !choices.some(choice => choice.group === 'profiles') ? profilesRead.list.error
        : null;

  const rows: ReactNode[] = [];
  let lastGroup: SessionChoice['group'] | null = null;
  const heading = (group: SessionChoice['group']) => (
    <div key={`h-${group}`} role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">{GROUP_LABELS[group]}</div>
  );
  for (const choice of shown) {
    if (!query && choice.group !== lastGroup) {
      // Profiles say they're loading, or why there are none, under their heading.
      if (lastGroup === 'agents' && choice.group !== 'profiles' && profilesStatus) {
        rows.push(heading('profiles'), <div key="profiles-status" role="presentation" className="px-2.5 py-1.5 text-[12px] text-text-tertiary">{profilesStatus}</div>);
      }
      rows.push(heading(choice.group));
      lastGroup = choice.group;
    }
    const selected = choice === active;
    rows.push(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- The combobox input owns the keys (↑↓, Return), as in Search.
      <div
        key={choice.key}
        id={optionId(choice)}
        role="option"
        aria-selected={selected}
        aria-disabled={choice.disabledReason ? true : undefined}
        data-testid={`session-choice-${choice.key}`}
        onMouseMove={() => { if (!selected) setActiveKey(choice.key); }}
        onClick={() => { setActiveKey(choice.key); void create(choice); }}
        className={cn(
          // No transition on the highlight: it moves with every arrow key.
          'flex cursor-default items-center gap-3 rounded-lg px-2.5 py-[7px]',
          selected && 'bg-[color-mix(in_srgb,var(--color-interactive-primary)_16%,transparent)]',
          choice.disabledReason && 'opacity-60',
        )}
      >
        <ProfileAvatar profileRef={choice.profileRef} agent={choice.agent} size={26} />
        <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
          <span className="truncate text-[13.5px] text-text-primary">{choice.label}</span>
          <span className="truncate text-[11.5px] text-text-tertiary">{choice.detail}</span>
        </span>
        {selected && <Kbd size="xs" variant="muted" className="flex-none"><CornerDownLeft className="h-3 w-3" aria-label="Return" /></Kbd>}
      </div>,
    );
  }
  if (!query && lastGroup === 'agents' && profilesStatus) {
    rows.push(heading('profiles'), <div key="profiles-status" role="presentation" className="px-2.5 py-1.5 text-[12px] text-text-tertiary">{profilesStatus}</div>);
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)} onKeyDown={handleKeyDown} data-testid="new-session-palette">
      <div className="flex flex-none items-center gap-2.5 border-b border-border-primary px-4 py-3.5 text-text-tertiary">
        <Plus className="h-4 w-4 flex-none" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          autoFocus={autoFocus}
          value={query}
          disabled={busy}
          onChange={event => { setQuery(event.target.value); setActiveKey(null); setError(null); }}
          placeholder="Start a Session with…"
          aria-label="Start a Session with"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={active ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 bg-transparent text-[19px] text-text-primary placeholder:text-text-muted focus:outline-none"
        />
      </div>
      <div ref={listRef} id={listboxId} role="listbox" aria-label="Agents and profiles" className="max-h-[330px] min-h-0 overflow-y-auto p-1.5">
        {rows}
        {shown.length === 0 && <div className="p-[18px] text-center text-[13px] text-text-tertiary">No agent or profile matches “{query}”</div>}
      </div>
      {note && (
        <div role={error ? 'alert' : 'status'} className={cn('flex-none px-4 py-1.5 text-[12px]', error ? 'text-status-error' : 'text-text-tertiary')}>{note}</div>
      )}
      <label className="flex flex-none items-center gap-2.5 border-t border-border-primary px-3.5 py-2.5 text-[12px]">
        <span className="text-text-tertiary">Run on</span>
        <select
          ref={runOnRef}
          aria-label="Run on"
          value={runOn?.value ?? ''}
          disabled={busy}
          onChange={event => { setRunOnValue(event.target.value); setError(null); }}
          className="h-7 min-w-[220px] rounded-md border border-border-primary bg-bg-primary px-2 text-[12.5px] text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive"
        >
          {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        </select>
      </label>
      <div className="flex flex-none flex-wrap gap-x-4 gap-y-1 border-t border-border-primary bg-surface-secondary px-3.5 py-2 text-[11.5px] text-text-tertiary">
        <span className="flex items-center gap-1.5"><Kbd size="xs">↑↓</Kbd> choose</span>
        <span className="flex items-center gap-1.5"><Kbd size="xs">tab</Kbd> run on</span>
        <span className="flex items-center gap-1.5"><Kbd size="xs">↵</Kbd> create</span>
        <span className="flex items-center gap-1.5"><Kbd size="xs">esc</Kbd> cancel</span>
      </div>
    </div>
  );
}

/** New Session as a Spotlight-style palette near the top of the window (T-63). */
function NewSessionPalette({ entries, onSwitchMachine, onClose }: Pick<SessionPickerProps, 'entries' | 'onSwitchMachine' | 'onClose'>) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      isOpen
      ariaLabel="New Session"
      onClose={() => { if (!busy) onClose(); }}
      closeOnEscape={!busy}
      // Opened by key many times a day, like Search: no entrance animation between the key and typing.
      instant
      showCloseButton={false}
      placement="top"
      // A light scrim, unblurred, like Spotlight: the window stays readable behind the palette.
      overlayClassName="!bg-black/10 !backdrop-blur-none"
      size="lg"
      className="!max-w-[600px] !rounded-[calc(var(--modal-radius)*2)]"
    >
      <SessionPicker entries={entries} onSwitchMachine={onSwitchMachine} onClose={onClose} onBusyChange={setBusy} trapTab />
    </Modal>
  );
}

/**
 * Opens the palette on a New Session request (the + beside Sessions, the shortcut, Search). The
 * Sidebar mounts one, so one palette opens whichever nav (rail or tree) asked.
 */
export function NewSessionPaletteHost({ entries, onSwitchMachine }: Pick<SessionPickerProps, 'entries' | 'onSwitchMachine'>) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenNewSessionPaletteRequest(() => setOpen(true)), []);
  return open ? <NewSessionPalette entries={entries} onSwitchMachine={onSwitchMachine} onClose={() => setOpen(false)} /> : null;
}
