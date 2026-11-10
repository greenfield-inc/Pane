import { useState, useEffect, useRef, useMemo, useId, type ReactNode } from 'react';
import { matchSorter } from 'match-sorter';
import {
  Archive, Code, Command, Copy, CornerDownLeft, ExternalLink, FolderGit2, GitBranch, GitPullRequest, MessageSquare, MoreHorizontal,
  Pin, PinOff, Play, Plus, SquareArrowOutUpRight, X, type LucideIcon,
  Keyboard, RotateCcw, ListTree,
} from 'lucide-react';
import { Modal } from './ui/Modal';
import { Kbd } from './ui/Kbd';
import { Tooltip } from './ui/Tooltip';
import { AgentStatusDot } from './ui/AgentStatusDot';
import { archiveOrchestrationSession, setOrchestrationSessionPinned } from './orchestrationSessionActions';
import { rendererKeyPlatform, useHotkeyStore } from '../stores/hotkeyStore';
import { getCatalogEntry } from '../../../shared/constants/keyboardShortcuts';
import { normalizeKeyboardShortcutOverrides, resolveDefaultChord } from '../../../shared/utils/keyboardBindings';
import { buildShortcutMap, labelForId } from '../utils/shortcutMap';
import { rendererPlatform } from '../utils/platformUtils';
import { useKeyRecording } from '../hooks/useKeyRecording';
import { useShortcutMapQueryStore } from './settings/KeyboardShortcutMap';
import { useSessionStore } from '../stores/sessionStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useConfigStore } from '../stores/configStore';
import { showActionError } from '../stores/errorStore';
import { usePanelStore } from '../stores/panelStore';
import type { PanelStore } from '../types/panelStore';
import { rollupAgentState, toAgentDisplayStatus } from '../utils/agentStatus';
import { afterLeavingSettings } from '../utils/settingsExit';
import type { AgentDisplayStatus, AgentState } from '../../../shared/types/agentStatus';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { formatTimeAgo } from '../utils/timestampUtils';
import { API } from '../utils/api';
import { cn } from '../utils/cn';
import { MachineRowMark, machineMarkTitle } from './machines/MachineMark';
import { useAllMachinesTree } from '../hooks/useAllMachinesTree';
import { isAllMachinesOn, useAllMachinesStore } from '../stores/allMachinesStore';
import { openOnMachine, runOnMachine } from '../utils/machineRowActions';
import type { MachineRef } from '../utils/allMachinesTree';
import {
  buildMachineSearchItems, buildSearchItems, matchedRanges, searchItems, SEARCH_FILTERS,
  type SearchFilter, type SearchItem, type SearchSection,
} from '../utils/spotlightSearch';
import type { Project } from '../types/project';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Project[];
  /** Opens the New Pane dialog for a project. */
  onNewPane: (projectId: number) => void;
}

interface LauncherAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  /** Keep the launcher open (Change key… records in place). */
  stay?: boolean;
}

/** What a command's Actions can do with its key (P7). */
interface KeyActionContext {
  onChangeKey: (id: string, label: string) => void;
  onResetKey: (id: string) => void;
  onShowInShortcuts: (label: string) => void;
}

interface ActionContext extends KeyActionContext {
  onNewPane: (projectId: number) => void;
  isRemote: boolean;
}

/** Change key…, Reset to default and Show in Keyboard Shortcuts, for a command in the catalog. */
function keyActionsFor(id: string, label: string, context: KeyActionContext): LauncherAction[] {
  if (!getCatalogEntry(id)) return [];
  const { overrides } = normalizeKeyboardShortcutOverrides(useConfigStore.getState().config?.keyboardShortcutOverrides);
  const customized = Object.prototype.hasOwnProperty.call(overrides, id);
  return [
    { id: 'change-key', label: 'Change key…', icon: Keyboard, stay: true, run: () => context.onChangeKey(id, label) },
    ...(customized ? [{ id: 'reset-key', label: 'Reset to default', icon: RotateCcw, stay: true, run: () => context.onResetKey(id) }] : []),
    { id: 'show-in-shortcuts', label: 'Show in Keyboard Shortcuts', icon: ListTree, run: () => context.onShowInShortcuts(label) },
  ];
}

type Row =
  | { type: 'header'; key: string; label: string }
  | { type: 'item'; key: string; item: SearchItem; index: number }
  | { type: 'more'; key: string; section: SearchSection; filter: SearchFilter; index: number }
  | { type: 'action'; key: string; action: LauncherAction; index: number };

const TYPE_LABEL = {
  pane: 'Pane',
  session: 'Session',
  project: 'Project',
  command: 'Command',
} satisfies Record<SearchItem['kind'], string>;

// A list longer than this mounts only the rows in view (plus OVERSCAN either side) and the selected row.
const WINDOW_THRESHOLD = 100;
const OVERSCAN = 10;
// Matches rowClass's h-10: a windowed list places its rows by index.
const ROW_HEIGHT = 40;
const NO_STATUS: Record<string, AgentState> = {};
const NO_SESSIONS: Record<string, string> = {};
const NO_UNVIEWED: PanelStore['unviewedCompletedActivity'] = {};

// Commands that open a dialog wait for the launcher to finish closing, so focus lands in the dialog.
const AFTER_CLOSE_MS = 50;

function openPane(paneId: string) {
  useNavigationStore.getState().setSidebarNavigationScope('repositories');
  const selected = useSessionStore.getState().setActiveSession(paneId);
  useNavigationStore.getState().navigateToSessions();
  return selected;
}

function openSession(sessionId: string) {
  void useSessionStore.getState().setActiveSession(null);
  useNavigationStore.getState().navigateToPaneChat();
  // The store owns selection errors and surfaces them in the sidebar.
  useOrchestrationSessionStore.getState().select({ sessionId }).catch(() => {});
}

async function reportFailure(title: string, request: Promise<{ success: boolean; error?: string }>) {
  try {
    const response = await request;
    if (!response.success) showActionError(title, response.error);
  } catch (cause) {
    showActionError(title, cause);
  }
}

/** A row from All machines: it opens on its machine, and pin and archive run there in place. */
function machineActionsFor(item: SearchItem, machine: MachineRef): LauncherAction[] {
  const open = (target: Parameters<typeof openOnMachine>[1]) => () => afterLeavingSettings(() => void openOnMachine(machine.id, target));
  switch (item.kind) {
    case 'pane': {
      const target = { kind: 'pane' as const, id: item.pane.id };
      return [
        { id: 'open', label: 'Open Pane', icon: SquareArrowOutUpRight, run: open({ ...target, name: item.pane.name }) },
        {
          id: 'pin', label: item.pane.isFavorite ? 'Unpin' : 'Pin', icon: item.pane.isFavorite ? PinOff : Pin,
          run: () => void runOnMachine(machine.id, { type: 'pin', target, pinned: !item.pane.isFavorite }, 'Could not pin or unpin the Pane'),
        },
        { id: 'archive', label: 'Archive', icon: Archive, run: () => void runOnMachine(machine.id, { type: 'archive', target }, 'Could not archive the Pane') },
      ];
    }
    case 'session': {
      const target = { kind: 'session' as const, id: item.session.id };
      return [
        { id: 'open', label: 'Open Session', icon: SquareArrowOutUpRight, run: open({ ...target, name: item.session.name }) },
        {
          id: 'pin', label: item.session.isPinned ? 'Unpin' : 'Pin', icon: item.session.isPinned ? PinOff : Pin,
          run: () => void runOnMachine(machine.id, { type: 'pin', target, pinned: !item.session.isPinned }, 'Could not pin or unpin the Session'),
        },
        { id: 'archive', label: 'Archive', icon: Archive, run: () => void runOnMachine(machine.id, { type: 'archive', target }, 'Could not archive the Session') },
      ];
    }
    case 'project':
      return [{ id: 'open', label: 'Open Project', icon: SquareArrowOutUpRight, run: open({ kind: 'project', id: item.project.id, name: item.project.name }) }];
    case 'command':
      return [];
  }
}

function actionsFor(item: SearchItem, context: ActionContext): LauncherAction[] {
  if (item.machine) return machineActionsFor(item, item.machine);
  switch (item.kind) {
    case 'pane': {
      const { pane, prUrl } = item;
      return [
        { id: 'open', label: 'Open Pane', icon: SquareArrowOutUpRight, run: () => afterLeavingSettings(() => void openPane(pane.id)) },
        ...(context.isRemote ? [] : [{
          id: 'ide', label: 'Open in IDE', icon: Code,
          run: () => void reportFailure('Could not open the IDE', API.sessions.openIDE(pane.id)),
        }]),
        {
          id: 'copy-path', label: 'Copy worktree path', icon: Copy,
          run: () => navigator.clipboard.writeText(pane.worktreePath).catch(cause => showActionError('Could not copy the worktree path', cause)),
        },
        ...(prUrl ? [{
          id: 'pr', label: 'Open pull request', icon: ExternalLink,
          run: () => void reportFailure('Could not open the pull request', window.electronAPI.openExternal(prUrl)),
        }] : []),
        {
          id: 'pin', label: pane.isFavorite ? 'Unpin' : 'Pin', icon: pane.isFavorite ? PinOff : Pin,
          run: () => void reportFailure('Could not pin or unpin the Pane', API.sessions.toggleFavorite(pane.id)),
        },
        {
          id: 'archive', label: 'Archive', icon: Archive,
          // The Archive Pane command asks its usual confirmation for the open Pane.
          run: () => afterLeavingSettings(() => void openPane(pane.id).then(() => setTimeout(() => {
            const archive = useHotkeyStore.getState().hotkeys.get('archive-active-session');
            if (archive && (!archive.enabled || archive.enabled())) archive.action();
          }, AFTER_CLOSE_MS))),
        },
      ];
    }
    case 'session': {
      const { session } = item;
      const fail = (title: string) => (cause: unknown) => showActionError(title, cause);
      return [
        { id: 'open', label: 'Open Session', icon: SquareArrowOutUpRight, run: () => afterLeavingSettings(() => openSession(session.id)) },
        {
          id: 'pin', label: session.isPinned ? 'Unpin' : 'Pin', icon: session.isPinned ? PinOff : Pin,
          run: () => void setOrchestrationSessionPinned(session.id, !session.isPinned).catch(fail('Could not pin or unpin the Session')),
        },
        {
          id: 'archive', label: 'Archive', icon: Archive,
          run: () => void archiveOrchestrationSession(session.id, session.name).catch(fail('Could not archive the Session')),
        },
      ];
    }
    case 'project': {
      const { project } = item;
      return [
        { id: 'open', label: 'Open Project', icon: SquareArrowOutUpRight, run: () => afterLeavingSettings(() => useNavigationStore.getState().navigateToProject(project.id)) },
        { id: 'new-pane', label: 'New Pane here', icon: Plus, run: () => afterLeavingSettings(() => setTimeout(() => context.onNewPane(project.id), AFTER_CLOSE_MS)) },
      ];
    }
    case 'command':
      return [
        ...(item.disabledReason !== null ? [] : [
          { id: 'run', label: 'Run', icon: Play, run: () => setTimeout(() => item.command.action(), AFTER_CLOSE_MS) },
        ]),
        ...keyActionsFor(item.command.id, item.command.label, context),
      ];
  }
}

/** What saving a key came to: saved, refused because another command has it, or not written. */
type KeySaveResult = { kind: 'saved' } | { kind: 'conflict'; message: string } | { kind: 'failed' };

/**
 * Saves one command's key (undefined resets it to its default, null leaves it
 * without one). A conflict is refused before anything is written; a failed
 * write shows its error and is never reported as saved.
 */
async function saveKeyOverride(id: string, chord: string | null | undefined): Promise<KeySaveResult> {
  const config = useConfigStore.getState().config;
  const { overrides } = normalizeKeyboardShortcutOverrides(config?.keyboardShortcutOverrides);
  const next = { ...overrides };
  if (chord === undefined) delete next[id];
  else next[id] = chord;
  const sources = { terminalShortcuts: config?.terminalShortcuts, customCommands: config?.customCommands };
  const map = buildShortcutMap({ overridesRaw: next, ...sources, environment: rendererPlatform(), keyPlatform: rendererKeyPlatform() });
  const conflicts = map.rows.find(row => row.id === id)?.conflicts ?? [];
  if (chord && conflicts.length > 0) {
    return { kind: 'conflict', message: `${formatKeyDisplay(chord)} is already ${conflicts.map(other => labelForId(other, sources)).join(' and ')}` };
  }
  try {
    await useConfigStore.getState().updateConfig({ keyboardShortcutOverrides: next });
    return { kind: 'saved' };
  } catch (cause) {
    showActionError('Could not save the key', cause);
    return { kind: 'failed' };
  }
}

export function CommandPalette({ isOpen, onClose, projects, onNewPane }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [chosenFilter, setChosenFilter] = useState<SearchFilter>('all');
  const [selection, setSelection] = useState({ view: '', key: '', index: 0 });
  // Where the windowed rows are scrolled to, relative to their first row.
  const [scroll, setScroll] = useState({ top: 0, height: 520 });
  const itemsRef = useRef<HTMLDivElement>(null);
  // The row whose ⌘K Actions are showing, by key, and the text filtering them.
  const [actionsKey, setActionsKey] = useState<string | null>(null);
  const [actionQuery, setActionQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const panes = useSessionStore(s => s.sessions);
  const activePaneId = useSessionStore(s => s.activeSessionId);
  const sessions = useOrchestrationSessionStore(s => s.sessions);
  const selectedSessionId = useOrchestrationSessionStore(s => s.selectedSessionId);
  const hotkeys = useHotkeyStore(s => s.hotkeys);
  const isRemote = useConfigStore(s => s.config?.remoteDaemon?.client.mode === 'remote');

  // Change key… records in place (P7, D-240), with the same recorder and
  // conflict check as Settings › Keyboard Shortcuts.
  const [recordingKey, setRecordingKey] = useState<{ id: string; label: string } | null>(null);
  const recordingRef = useRef(recordingKey);
  useEffect(() => { recordingRef.current = recordingKey; }, [recordingKey]);
  const [keyStatus, setKeyStatus] = useState('');
  // Closing the launcher ends any recording and clears its status, adjusted
  // during render rather than in an effect, so a reopen never shows the old one.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (!isOpen) { setRecordingKey(null); setKeyStatus(''); }
  }
  const actionContext = useMemo<ActionContext>(() => ({
    onNewPane,
    isRemote,
    onChangeKey: (id, label) => { setKeyStatus(''); setRecordingKey({ id, label }); },
    onResetKey: (id) => {
      void saveKeyOverride(id, undefined).then(result => {
        if (result.kind !== 'saved') return;
        setKeyStatus(`Reset to ${formatKeyDisplay(resolveDefaultChord(id, rendererKeyPlatform()) ?? '') || 'no key'}`);
        setActionsKey(null);
      });
    },
    onShowInShortcuts: (label) => {
      useShortcutMapQueryStore.setState({ query: label });
      setTimeout(() => useHotkeyStore.getState().hotkeys.get('open-shortcut-settings')?.action(), AFTER_CLOSE_MS);
    },
  }), [onNewPane, isRemote]);
  const finishRecorded = (outcome: Promise<KeySaveResult>, done: string) => {
    const target = recordingRef.current;
    void outcome.then(result => {
      if (result.kind === 'conflict' && target) {
        setKeyStatus(`${result.message}. Press another key, or Esc.`);
        setRecordingKey(target);
        return;
      }
      // A failed write has shown its error; the key stays as it was.
      if (result.kind === 'failed') {
        setKeyStatus('The key was not saved.');
        return;
      }
      setKeyStatus(done);
      setActionsKey(null);
    });
  };
  useKeyRecording({
    recording: Boolean(recordingKey),
    defaultChord: recordingKey ? resolveDefaultChord(recordingKey.id, rendererKeyPlatform()) : null,
    finish: (message) => { setRecordingKey(null); if (message) setKeyStatus(message); },
    setStatus: setKeyStatus,
    onRecord: (chord) => {
      const target = recordingRef.current;
      if (target) finishRecorded(saveKeyOverride(target.id, chord), `${target.label}: ${formatKeyDisplay(chord)}`);
    },
    onUnassign: () => {
      const target = recordingRef.current;
      if (target) finishRecorded(saveKeyOverride(target.id, null), `${target.label}: no key`);
    },
    onReset: () => {
      const target = recordingRef.current;
      if (target) finishRecorded(saveKeyOverride(target.id, undefined), `${target.label}: back to its default`);
    },
  });
  // Read only while open, so status updates don't re-render a closed launcher.
  const agentStatus = usePanelStore(s => isOpen ? s.agentStatus : NO_STATUS);
  const agentStatusSession = usePanelStore(s => isOpen ? s.agentStatusSession : NO_SESSIONS);
  const unviewed = usePanelStore(s => isOpen ? s.unviewedCompletedActivity : NO_UNVIEWED);
  const needsAttention = useMemo(
    () => panesNeedingAttention(agentStatus, agentStatusSession, unviewed),
    [agentStatus, agentStatusSession, unviewed],
  );

  // In All machines the launcher searches every machine's rows, each labelled with its machine.
  const allMachines = useAllMachinesStore(isAllMachinesOn);
  const { views: machineViews } = useAllMachinesTree();

  // Rebuilt when the launcher opens or its sources change, never per keystroke.
  const localItems = useMemo(() => isOpen
    ? buildSearchItems({
      panes,
      sessions,
      projects,
      commands: useHotkeyStore.getState().getAll({ paletteOnly: true }),
      activePaneId,
      selectedSessionId,
    })
    : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps -- getAll reads the hotkeys registry
  [isOpen, panes, sessions, projects, hotkeys, activePaneId, selectedSessionId]);
  const items = useMemo(() => isOpen && allMachines
    ? [...buildMachineSearchItems(machineViews), ...localItems.filter(item => item.kind === 'command')]
    : localItems,
  [isOpen, allMachines, machineViews, localItems]);

  // Actions read their item from the current sources: a rename or pin shows at once, and a removed item leaves Actions.
  const itemByKey = useMemo(() => new Map(items.map(item => [item.key, item])), [items]);
  const actionsItem = actionsKey ? itemByKey.get(actionsKey) ?? null : null;

  const results = useMemo(() => {
    const start = performance.now();
    const ranked = searchItems(items, { query, filter: chosenFilter });
    performance.measure('pane:search', { start, end: performance.now() });
    return ranked;
  }, [items, query, chosenFilter]);

  const actions = useMemo(() => {
    if (!actionsItem) return [];
    const all = actionsFor(actionsItem, actionContext);
    return actionQuery.trim() ? matchSorter(all, actionQuery.trim(), { keys: ['label'] }) : all;
  }, [actionContext, actionQuery, actionsItem, isRemote, onNewPane]);

  const rows = useMemo(() => buildRows(results.sections, actionsItem ? actions : null), [actions, actionsItem, results.sections]);
  const selectable = useMemo(() => rows.filter((row): row is Exclude<Row, { type: 'header' }> => row.type !== 'header'), [rows]);
  // A selection belongs to the view it was made in, so a new query, type or Actions menu starts at the top.
  // Within a view it follows its row through live updates, and falls back to the nearest row if that row goes.
  const view = [query, chosenFilter, actionsItem?.key ?? '', actionQuery].join('\u0000');
  const keptIndex = selection.view === view ? selectable.findIndex(row => row.key === selection.key) : -1;
  const selectedIndex = keptIndex >= 0 ? keptIndex
    : selection.view === view ? Math.min(selection.index, Math.max(0, selectable.length - 1)) : 0;
  const setSelectedIndex = (index: number) => setSelection({ view, key: selectable[index]?.key ?? '', index });
  // A long list is one header over equal-height rows (a filtered view or Actions), so it can be windowed:
  // whatever the selection or scroll, only the rows in view and the selected row are mounted.
  const windowed = selectable.length > WINDOW_THRESHOLD
    && rows.length === selectable.length + 1 && rows[0]?.type === 'header'
    && selectable.every(row => row.type !== 'more');
  const windowStart = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN);
  const windowEnd = Math.min(selectable.length, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN);
  const mounted = windowed
    ? selectable.filter(row => (row.index >= windowStart && row.index < windowEnd) || row.index === selectedIndex)
    : selectable;
  const trackScroll = (list: HTMLDivElement) => {
    const itemsTop = itemsRef.current?.offsetTop ?? 0;
    setScroll({ top: list.scrollTop - itemsTop, height: list.clientHeight });
  };
  const selected = selectable[selectedIndex];
  const selectedItem = actionsItem ?? (selected?.type === 'item' ? selected.item : null);

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, rows]);

  const runAction = (action: LauncherAction) => {
    if (!action.stay) onClose();
    action.run();
  };

  const choose = (row: Exclude<Row, { type: 'header' }> | undefined) => {
    if (!row) return;
    if (row.type === 'more') {
      setChosenFilter(row.filter);
      if (query.trimStart().startsWith('>')) setQuery(query.trimStart().slice(1).trimStart());
      return;
    }
    if (row.type === 'action') {
      runAction(row.action);
      return;
    }
    // A disabled command offers its key actions, but Enter never runs them for it.
    if (row.item.kind === 'command' && row.item.disabledReason) return;
    const [main] = actionsFor(row.item, actionContext);
    if (main) runAction(main);
  };

  const openActions = () => {
    if (selected?.type !== 'item') return;
    setActionsKey(selected.item.key);
    setActionQuery('');
  };

  const cycleFilter = (step: 1 | -1) => {
    const ids = SEARCH_FILTERS.map(entry => entry.id);
    const next = ids[(ids.indexOf(results.filter) + step + ids.length) % ids.length];
    // A leading > forces Commands, so a chip choice replaces it.
    if (query.trimStart().startsWith('>')) setQuery(query.trimStart().slice(1).trimStart());
    setChosenFilter(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const count = selectable.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (count === 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelectedIndex((selectedIndex + step + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(selected);
    } else if (e.key === 'Tab' && !actionsItem) {
      e.preventDefault();
      e.stopPropagation();
      cycleFilter(e.shiftKey ? -1 : 1);
    } else if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (actionsItem) setActionsKey(null);
      else openActions();
    } else if (e.key === 'Escape' && actionsItem) {
      // The Modal keeps itself open while Actions show; this Esc goes back to the results.
      e.preventDefault();
      setActionsKey(null);
    }
  };

  const mainAction = selectedItem
    ? actionsFor(selectedItem, actionContext)[0]?.label ?? null
    : selected?.type === 'more' ? `Show all ${selected.section.label}` : null;
  const footerLabel = actionsItem ? (selected?.type === 'action' ? selected.action.label : null) : mainAction;
  const activeOption = selected ? `${listboxId}-option-${selectedIndex}` : undefined;

  const renderRow = (row: Row) => {
          if (row.type === 'header') {
            return (
              <div key={row.key} className="px-6 pb-1.5 pt-3 text-[13px] text-text-tertiary">
                {row.label}
              </div>
            );
          }
          const isSelected = row.index === selectedIndex;
          const optionProps = {
            id: `${listboxId}-option-${row.index}`,
            role: 'option' as const,
            'aria-selected': isSelected,
            // A windowed list mounts only some options, so each states its place in the whole list.
            'aria-posinset': windowed ? row.index + 1 : undefined,
            'aria-setsize': windowed ? selectable.length : undefined,
            'data-selected': isSelected,
            // Clicking a row keeps the cursor in the input, so typing and arrow keys carry on.
            onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
            onMouseMove: () => { if (!isSelected) setSelectedIndex(row.index); },
            onClick: () => choose(row),
          };
          if (row.type === 'more') {
            return (
              <div key={row.key} {...optionProps} className={cn(rowClass(isSelected, false), 'h-8 text-[13px] text-text-tertiary')}>
                <span className="w-4" aria-hidden="true" />
                <span className="flex-1">{row.section.more} more {row.section.more === 1 ? row.section.label.slice(0, -1) : row.section.label}</span>
                {isSelected && <CornerDownLeft className="h-4 w-4 text-text-tertiary" aria-hidden="true" />}
              </div>
            );
          }
          if (row.type === 'action') {
            const Icon = row.action.icon;
            return (
              <div key={row.key} {...optionProps} className={rowClass(isSelected, false)}>
                <Icon className="h-4 w-4 flex-shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="flex-1 truncate">{row.action.label}</span>
                {isSelected && <CornerDownLeft className="h-4 w-4 text-text-tertiary" aria-hidden="true" />}
              </div>
            );
          }
          const option = (
            <div
              key={row.key}
              {...optionProps}
              aria-label={[row.item.title, row.item.detail, row.item.machine && `on ${row.item.machine.name}`, TYPE_LABEL[row.item.kind]].filter(Boolean).join(', ')}
              aria-disabled={isDisabled(row.item)}
              className={rowClass(isSelected, isDisabled(row.item))}
            >
              <ResultRow
                item={row.item}
                query={results.filter === 'commands' ? query.trimStart().replace(/^>/, '') : query}
                selected={isSelected}
                attention={row.item.kind === 'pane' ? needsAttention.get(row.item.pane.id) : undefined}
              />
            </div>
          );
          return row.item.kind === 'command' && row.item.disabledReason
            ? <Tooltip key={row.key} content={row.item.disabledReason} side="right" className="block">{option}</Tooltip>
            : option;
  };

  return (
    <Modal
      ariaLabel="Search"
      isOpen={isOpen}
      onClose={onClose}
      initialFocusRef={inputRef}
      // Cmd+Shift+P is a hundred-times-a-day reflex. Anything between the
      // keystroke and a focused input reads as the app being slow, not as
      // polish, so the launcher does not animate in.
      instant
      closeOnEscape={!actionsItem}
      showCloseButton={false}
      size="xl"
      // Borderless, with twice the theme's modal radius: square themes stay square.
      className="!max-w-[720px] !border-transparent !rounded-[calc(var(--modal-radius)*2)]"
    >
      <div className="flex flex-shrink-0 items-center gap-3 pl-6 pr-4 pt-4">
        <input
          ref={inputRef}
          aria-label="Search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={selectable.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeOption}
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder={actionsItem ? 'Search actions' : 'Search'}
          value={actionsItem ? actionQuery : query}
          onChange={(e) => (actionsItem ? setActionQuery : setQuery)(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-9 min-w-0 flex-1 bg-transparent text-[17px] text-text-primary placeholder:text-text-muted focus:outline-none"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close"
          onClick={onClose}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
        >
          <X className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>

      {/* Actions keep the tab row's height, so the list never moves when ⌘K opens. */}
      <div className="flex h-11 flex-shrink-0 items-center gap-1 border-b border-border-primary px-5 pb-2 pt-1" role="group" aria-label="Filter">
        {actionsItem ? (
          <span className="px-1.5 text-[13px] text-text-tertiary">Actions for {actionsItem.title}</span>
        ) : keyStatus && !recordingKey ? (
          <span role="status" className="px-1.5 text-[13px] text-text-secondary" data-testid="palette-key-status">{keyStatus}</span>
        ) : SEARCH_FILTERS.map(entry => {
          const active = entry.id === results.filter;
          return (
            <button
              key={entry.id}
              type="button"
              tabIndex={-1}
              aria-pressed={active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (query.trimStart().startsWith('>')) setQuery(query.trimStart().slice(1).trimStart());
                setChosenFilter(entry.id);
              }}
              className={cn(
                'rounded-lg px-2.5 py-1 text-sm',
                active ? 'bg-surface-hover text-text-primary' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <div
        id={listboxId}
        ref={listRef}
        role="listbox"
        aria-label={actionsItem ? 'Actions' : 'Results'}
        // A fixed height keeps the input still while results change: the
        // launcher is centred, so a shrinking list would move it on every key.
        onScroll={(e) => trackScroll(e.currentTarget)}
        className="relative min-h-0 overflow-y-auto py-2"
        style={{ height: 'min(520px, calc(100vh - 220px))' }}
      >
        {recordingKey ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" data-testid="palette-key-recorder">
            <Keyboard className="h-6 w-6 text-text-tertiary" aria-hidden="true" />
            <p className="text-sm text-text-primary">Press the new key for <span className="font-medium">{recordingKey.label}</span></p>
            <p className="text-xs text-text-tertiary">A two-step key works too: press the second key right after. Esc cancels, Backspace clears.</p>
            <p role="status" aria-live="polite" className="min-h-4 text-xs text-text-secondary">{keyStatus}</p>
          </div>
        ) : selectable.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-text-tertiary">
            {actionsItem ? 'No matching actions' : 'No results'}
          </div>
        ) : windowed ? (
          <>
            {rows[0]?.type === 'header' && renderRow(rows[0])}
            <div ref={itemsRef} role="presentation" className="relative" style={{ height: selectable.length * ROW_HEIGHT }}>
              {mounted.map(row => (
                <div key={row.key} role="presentation" className="absolute inset-x-0" style={{ top: row.index * ROW_HEIGHT }}>
                  {renderRow(row)}
                </div>
              ))}
            </div>
          </>
        ) : rows.map(renderRow)}
      </div>

      <div className="flex h-11 flex-shrink-0 items-center gap-5 border-t border-border-primary px-6 text-[13px] text-text-tertiary">
        {actionsItem ? (
          <span className="flex items-center gap-1.5">Back <Kbd size="xs">esc</Kbd></span>
        ) : (
          <>
            <span className="flex items-center gap-1.5">Close <Kbd size="xs">esc</Kbd></span>
            <span className="flex items-center gap-1.5">Change type <Kbd size="xs">Tab</Kbd></span>
            <span className="flex items-center gap-1.5">Actions <Kbd size="xs">{formatKeyDisplay('mod+k')}</Kbd></span>
          </>
        )}
        {footerLabel && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-text-secondary">{footerLabel}</span>
            <Kbd size="xs">↵</Kbd>
          </span>
        )}
      </div>
    </Modal>
  );
}

const isDisabled = (item: SearchItem) => item.kind === 'command' && item.disabledReason !== null;

function rowClass(selected: boolean, disabled: boolean) {
  return cn(
    // No transition on the highlight: it moves on every arrow key, and a
    // cross-fade means the selection always trails the key you pressed.
    'mx-3 flex h-10 cursor-default items-center gap-3 rounded-lg px-3 text-sm',
    disabled ? 'cursor-not-allowed text-text-tertiary opacity-60' : 'text-text-primary',
    selected && 'bg-surface-hover',
  );
}

function buildRows(sections: SearchSection[], actions: LauncherAction[] | null): Row[] {
  const rows: Row[] = [];
  let index = 0;
  if (actions) {
    for (const action of actions) rows.push({ type: 'action', key: `action:${action.id}`, action, index: index++ });
    return rows;
  }
  for (const section of sections) {
    rows.push({ type: 'header', key: `header:${section.id}`, label: section.label });
    for (const item of section.items) rows.push({ type: 'item', key: `${section.id}:${item.key}`, item, index: index++ });
    if (section.more > 0 && section.filter) rows.push({ type: 'more', key: `more:${section.id}`, section, filter: section.filter, index: index++ });
  }
  return rows;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = matchedRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start} className="bg-transparent font-semibold text-text-primary">{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

type AttentionStatus = Extract<AgentDisplayStatus, 'blocked' | 'done'>;

/**
 * Panes that need you, in one pass over the tracked panels: a blocked agent,
 * or work finished while you were away. Rows look their Pane up instead of
 * each scanning every panel.
 */
function panesNeedingAttention(
  agentStatus: Record<string, AgentState>,
  agentStatusSession: Record<string, string>,
  unviewed: PanelStore['unviewedCompletedActivity'],
): Map<string, AttentionStatus> {
  const statesByPane = new Map<string, AgentState[]>();
  for (const [panelId, state] of Object.entries(agentStatus)) {
    const paneId = agentStatusSession[panelId];
    if (!paneId) continue;
    const states = statesByPane.get(paneId);
    if (states) states.push(state);
    else statesByPane.set(paneId, [state]);
  }
  const attention = new Map<string, AttentionStatus>();
  for (const [paneId, states] of statesByPane) {
    const status = toAgentDisplayStatus(rollupAgentState(states), Boolean(unviewed[paneId]));
    if (status === 'blocked' || status === 'done') attention.set(paneId, status);
  }
  return attention;
}

const shortTimeAgo = (iso: string | undefined) => formatTimeAgo(iso).replace(' ago', '').replace('just now', 'now');

function metadata(item: SearchItem): ReactNode {
  switch (item.kind) {
    case 'pane': {
      const prNumber = item.pane.gitStatus?.prNumber;
      return prNumber ? `PR #${prNumber}` : shortTimeAgo(item.pane.lastActivity ?? item.pane.lastViewedAt);
    }
    case 'session':
      return shortTimeAgo(item.session.updatedAt);
    case 'project':
      return item.detail;
    case 'command':
      return item.command.keys ? <Kbd size="xs" variant="muted">{formatKeyDisplay(item.command.keys)}</Kbd> : null;
  }
}

function ResultRow({ item, query, selected, attention }: { item: SearchItem; query: string; selected: boolean; attention?: AttentionStatus }) {
  const Icon = item.kind === 'pane'
    ? (item.pane.gitStatus?.prNumber ? GitPullRequest : GitBranch)
    : item.kind === 'session' ? MessageSquare : item.kind === 'project' ? FolderGit2 : Command;
  const pinned = item.kind === 'pane' ? item.pane.isFavorite : item.kind === 'session' ? item.session.isPinned : false;
  // A project's detail is its Pane count, shown on the right instead.
  const detail = item.kind === 'project' ? '' : item.detail;
  return (
    <>
      <span className="relative flex flex-shrink-0">
        <Icon className="h-4 w-4 text-text-secondary" aria-hidden="true" />
        {attention && <AgentStatusDot status={attention} size="sm" className="absolute -right-1.5 -top-1.5" />}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className="truncate"><Highlighted text={item.title} query={query} /></span>
        {pinned && <Pin className="h-3 w-3 flex-shrink-0 self-center rotate-45 text-text-tertiary" aria-label="Pinned" />}
        {detail && <span className="min-w-0 truncate text-[13px] text-text-tertiary">{detail}</span>}
      </span>
      {item.machine && (
        <Tooltip content={machineMarkTitle(item.machine)} side="left">
          <MachineRowMark machine={item.machine} />
        </Tooltip>
      )}
      {/* One fixed-height slot, so the hints and the metadata swap without moving the row. */}
      <span className="flex h-5 flex-shrink-0 items-center gap-3 text-[13px] text-text-tertiary">
        {selected ? (
          <>
            {/* A command keeps showing its key while selected (P7: find and change keys). */}
            {item.kind === 'command' ? metadata(item) : <MoreHorizontal className="h-4 w-4" aria-label="Actions" />}
            {!isDisabled(item) && <CornerDownLeft className="h-4 w-4" aria-hidden="true" />}
          </>
        ) : metadata(item)}
      </span>
    </>
  );
}
