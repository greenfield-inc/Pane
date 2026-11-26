import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, CircleDashed, ImageIcon, Moon, Plus, X } from 'lucide-react';
import type { TodoAttachmentKind, TodoCreateInput } from '../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { CONFIGURED_AGENT_IDS } from '../../../../shared/agents';
import { DEFAULT_PANE_CHAT_AGENT, PANE_CHAT_AGENT_LABELS, type PaneChatAgent } from '../../../../shared/types/paneChat';
import { PortalContainerProvider } from '../../contexts/PortalContainerContext';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { THIS_MACHINE_LABEL, useTodosStore, type CreatedTodo } from '../../stores/todosStore';
import { showActionError } from '../../stores/errorStore';
import { visibleAgentPresets } from '../../utils/agentPresets';
import { cn } from '../../utils/cn';
import { isMac } from '../../utils/platformUtils';
import type { Project } from '../../types/project';
import { Dropdown, type DropdownItem } from '../ui/Dropdown';
import { TodoStatusIcon } from './TodoStatusIcon';
import { SnoozeMenu, type SnoozeChoice } from './SnoozeMenu';
import { snoozeWhen, viewerZone } from './snoozeTime';
import { TODOS_BUTTON, TODOS_DIALOG_CHIP } from './todoStyles';

interface NewTodoDialogProps {
  onClose: () => void;
  /** The to-do was created; the list flashes its row. */
  onCreated: (todo: CreatedTodo) => void;
}

/** A "+ Done when" or "+ Sub-to-do" line, in the order they were added. */
interface DraftLine {
  id: number;
  kind: 'done' | 'sub';
  text: string;
}

/** A pasted image, saved to a file on this machine and attached to the new to-do. */
interface DraftImage {
  target: string;
  label: string;
}

const NO_REPO = 'none';

/** A repo as the dialog offers it, from this machine or the chosen one. */
interface RepoOption {
  id: number;
  name: string;
}

const repoListSchema = boundary.array(boundary.object({ id: boundary.number, name: boundary.string }));

/** The chosen machine's repos: this machine's from its own list, a saved machine's read from it. */
async function readRepos(machineId: string): Promise<RepoOption[]> {
  if (machineId === LOCAL_MACHINE_ID) {
    const response = await window.electronAPI?.projects?.getAll();
    const list: Project[] = response?.success && Array.isArray(response.data) ? response.data : [];
    return list.map(project => ({ id: project.id, name: project.name }));
  }
  const read = await window.electronAPI.machines.read(machineId, 'projects:get-all');
  const answer = decodeOptionalBoundary(read.data, boundary.object({ success: boundary.boolean, data: boundary.optional(repoListSchema) }));
  return answer?.data ?? [];
}

/** Agents this machine can run as an orchestrator, as the Create Session dialog offers them. */
function orchestratorAgents(): PaneChatAgent[] {
  const visible = new Set(visibleAgentPresets().map(preset => preset.id));
  const agents = CONFIGURED_AGENT_IDS.filter(id => visible.has(id));
  return agents.length ? agents : [DEFAULT_PANE_CHAT_AGENT];
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result === null || result instanceof ArrayBuffer) reject(new Error('The image could not be read.'));
      else resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'));
    reader.readAsDataURL(file);
  });
}

/**
 * New to-do (D-396, D-402, D-408): Linear's create dialog, always with a new Session. Title,
 * Markdown description with pasted images, done-when and sub-to-do lines, and chips for status, repo,
 * machine and agent. Create to-do (⌘↵) stays disabled until there is a title; Esc or a click outside
 * closes it and creates nothing.
 */
export function NewTodoDialog({ onClose, onCreated }: NewTodoDialogProps) {
  const create = useTodosStore(state => state.create);
  const createOn = useTodosStore(state => state.createOn);
  const machines = useTodosStore(state => state.machines);
  const [machineId, setMachineId] = useState(LOCAL_MACHINE_ID);
  const remote = machineId !== LOCAL_MACHINE_ID;
  const thisMachine = THIS_MACHINE_LABEL;
  const config = useConfigStore(state => state.config);
  const activePaneProjectId = useSessionStore(state => state.sessions.find(pane => pane.id === state.activeSessionId)?.projectId ?? null);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [images, setImages] = useState<DraftImage[]>([]);
  const [savingImages, setSavingImages] = useState(0);
  const [startNow, setStartNow] = useState(true);
  // Round 9: Remind me…, the status chip's third choice: created not started, snoozed until this time.
  const [reminder, setReminder] = useState<SnoozeChoice | null>(null);
  const [reminderAnchor, setReminderAnchor] = useState<DOMRect | null>(null);
  const statusRef = useRef<HTMLButtonElement>(null);
  const [projects, setProjects] = useState<RepoOption[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const agents = useMemo(orchestratorAgents, []);
  const [agent, setAgent] = useState<PaneChatAgent>(() => {
    const preferred = config?.defaultOrchestratorAgent;
    return preferred && agents.includes(preferred) ? preferred : agents[0];
  });
  const [submitting, setSubmitting] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const nextLineId = useRef(1);
  const focusLine = useRef<number | null>(null);
  const draftId = useRef(`pending_todo_${Date.now()}`);

  useEffect(() => {
    let live = true;
    readRepos(machineId).then(list => {
      if (!live) return;
      setProjects(list);
      // Repo ids belong to their machine: a new machine starts from its own list.
      const preferred = machineId === LOCAL_MACHINE_ID ? list.find(project => project.id === activePaneProjectId) : undefined;
      setProjectId((preferred ?? list[0])?.id ?? null);
    }).catch(() => { if (live) { setProjects([]); setProjectId(null); } });
    return () => { live = false; };
  }, [machineId, activePaneProjectId]);

  useEffect(() => {
    if (focusLine.current === null) return;
    document.querySelector<HTMLInputElement>(`[data-todo-line="${focusLine.current}"]`)?.focus();
    focusLine.current = null;
  }, [lines]);

  const canCreate = title.trim().length > 0 && !submitting && savingImages === 0;

  const addLine = (kind: DraftLine['kind'], after?: number) => {
    const id = nextLineId.current++;
    focusLine.current = id;
    setLines(current => {
      const next = [...current];
      const at = after === undefined ? next.length : next.findIndex(line => line.id === after) + 1;
      next.splice(at, 0, { id, kind, text: '' });
      return next;
    });
  };

  const onLineKey = (event: KeyboardEvent<HTMLInputElement>, line: DraftLine) => {
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (line.text.trim()) addLine(line.kind, line.id);
    } else if (event.key === 'Backspace' && !line.text) {
      event.preventDefault();
      const index = lines.findIndex(candidate => candidate.id === line.id);
      const previous = lines[index - 1];
      setLines(current => current.filter(candidate => candidate.id !== line.id));
      if (previous) focusLine.current = previous.id;
      else summaryRef.current?.focus();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    const textarea = event.currentTarget;
    const at = textarea.selectionStart;
    setSavingImages(count => count + files.length);
    void (async () => {
      try {
        const payload = await Promise.all(files.map(async (file, index) => ({
          name: file.name || `image-${images.length + index + 1}.png`,
          dataUrl: await readDataUrl(file),
          type: file.type,
        })));
        // Saved as files on this machine the way the composer saves pasted images, then attached by path.
        const paths = await window.electronAPI.sessions.saveImages(draftId.current, payload);
        const saved = paths.map((target, index) => ({ target, label: payload[index]?.name ?? `image-${index + 1}.png` }));
        setImages(current => [...current, ...saved]);
        const markdown = saved.map(image => `![${image.label}](${image.target})`).join('\n');
        setSummary(current => `${current.slice(0, at)}${at > 0 && !current.slice(0, at).endsWith('\n') ? '\n' : ''}${markdown}\n${current.slice(at)}`);
      } catch (error) {
        showActionError('Could not attach the pasted image', error);
      } finally {
        setSavingImages(count => count - files.length);
      }
    })();
  };

  const removeImage = (target: string) => {
    setImages(current => current.filter(image => image.target !== target));
    setSummary(current => current.split('\n').filter(line => !line.includes(`](${target})`)).join('\n'));
  };

  const submit = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    const doneWhen = lines.filter(line => line.kind === 'done').map(line => line.text.trim()).filter(Boolean);
    const subTodos = lines.filter(line => line.kind === 'sub').map(line => line.text.trim()).filter(Boolean);
    const imageKind: TodoAttachmentKind = 'image';
    const input: TodoCreateInput = {
      title: title.trim(),
      summary: summary.trim() || undefined,
      doneWhen,
      subTodos,
      projectId,
      agent,
      startNow: reminder ? false : startNow,
      // Pasted images are files on this machine, so only a to-do made here attaches them.
      attach: remote ? [] : images.map(image => ({ target: image.target, kind: imageKind, label: image.label })),
    };
    if (reminder) input.snooze = { until: reminder.until, zone: reminder.zone, note: reminder.note, action: reminder.action };
    if (remote) {
      const created = await createOn(machineId, input);
      setSubmitting(false);
      if (created) onCreated(created);
      return;
    }
    const todo = await create(input);
    setSubmitting(false);
    if (todo) onCreated({ machineId: LOCAL_MACHINE_ID, number: todo.number });
  };

  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const repoItems: DropdownItem[] = [
    ...projects.map(project => ({ id: String(project.id), label: project.name, onClick: () => setProjectId(project.id) })),
    { id: NO_REPO, label: 'No repo', separatorBefore: projects.length > 0, onClick: () => setProjectId(null) },
  ];
  const machineItems: DropdownItem[] = [
    { id: LOCAL_MACHINE_ID, label: thisMachine, onClick: () => setMachineId(LOCAL_MACHINE_ID) },
    ...machines.filter(machine => machine.access !== 'read').map(machine => ({
      id: machine.id,
      label: machine.label,
      disabled: machine.status !== 'online',
      description: machine.status === 'online' ? 'Its Session and orchestrator run there' : 'Can’t be reached right now',
      onClick: () => setMachineId(machine.id),
    })),
  ];
  const machineName = remote ? machines.find(machine => machine.id === machineId)?.label ?? machineId : thisMachine;
  const agentItems: DropdownItem[] = agents.map(id => ({
    id,
    label: PANE_CHAT_AGENT_LABELS[id],
    description: id === config?.defaultOrchestratorAgent ? 'Your default' : undefined,
    onClick: () => setAgent(id),
  }));
  const repoName = projects.find(project => project.id === projectId)?.name ?? 'None';

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-modal-backdrop bg-modal-overlay animate-modal-overlay-enter" />
        <Dialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          data-testid="new-todo-dialog"
          onKeyDown={onDialogKey}
          onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus(); }}
          // A menu open inside takes Esc first; the dialog stays.
          onEscapeKeyDown={event => { if (document.querySelector('[role="menu"], [data-testid="snooze-menu"]')) event.preventDefault(); }}
          className="fixed inset-x-0 top-[12vh] z-modal mx-auto w-[min(660px,calc(100vw-24px))] outline-none"
        >
          <Dialog.Title className="sr-only">New to-do</Dialog.Title>
          <PortalContainerProvider value={portalContainer}>
            <div className="flex flex-col rounded-[14px] border border-border-primary bg-surface-primary text-[13px] text-text-primary shadow-modal animate-modal-enter">
            <div className="flex items-center gap-2 px-3.5 pt-3 text-[12.5px] text-text-tertiary">
              <span className={cn(TODOS_DIALOG_CHIP, 'cursor-default hover:border-border-primary')}>
                <b className="font-medium text-text-primary">New Session for this to-do</b>
              </span>
              <span className="flex-1" />
              <span>Hidden from the sidebar · you are its requester</span>
              <Dialog.Close className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive" aria-label="Close">
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Dialog.Close>
            </div>
            <input
              ref={titleRef}
              value={title}
              onChange={event => setTitle(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); summaryRef.current?.focus(); } }}
              placeholder="To-do title"
              aria-label="Title"
              autoComplete="off"
              data-testid="new-todo-title"
              className="w-full border-0 bg-transparent px-4 pb-0.5 pt-2.5 text-[18px] font-semibold text-text-primary outline-none placeholder:text-text-tertiary"
            />
            <textarea
              ref={summaryRef}
              value={summary}
              onChange={event => setSummary(event.target.value)}
              onPaste={onPaste}
              placeholder="Add a description…"
              aria-label="Description (Markdown; paste images)"
              data-testid="new-todo-description"
              className="min-h-[60px] w-full resize-none border-0 bg-transparent px-4 py-1.5 text-[13.5px] leading-[1.55] text-text-primary outline-none placeholder:text-text-tertiary"
            />
            {(images.length > 0 || savingImages > 0) && (
              <div className="flex flex-wrap gap-1.5 px-4 pb-1.5">
                {images.map(image => (
                  <span key={image.target} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border-primary px-2 text-[12px] text-text-secondary" title={image.target}>
                    <ImageIcon className="h-3 w-3" aria-hidden="true" />
                    {image.label}
                    <button type="button" onClick={() => removeImage(image.target)} aria-label={`Remove ${image.label}`} className="text-text-tertiary hover:text-text-primary">
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {savingImages > 0 && <span className="inline-flex h-6 items-center text-[12px] text-text-tertiary" role="status">Attaching image…</span>}
                {remote && images.length > 0 && <span className="inline-flex h-6 items-center text-[12px] text-text-tertiary">Pasted images stay on {thisMachine}; they aren’t attached on {machineName}.</span>}
              </div>
            )}
            {lines.length > 0 && (
              <div className="px-4 pb-1">
                {lines.map(line => (
                  <div key={line.id} className="flex h-7 items-center gap-2 text-[12.5px]">
                    {line.kind === 'done'
                      ? <span className="h-[13px] w-[13px] shrink-0 rounded-[3px] border-[1.5px] border-border-hover" aria-hidden="true" />
                      : <CircleDashed className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />}
                    <input
                      value={line.text}
                      data-todo-line={line.id}
                      onChange={event => setLines(current => current.map(candidate => candidate.id === line.id ? { ...candidate, text: event.target.value } : candidate))}
                      onKeyDown={event => onLineKey(event, line)}
                      placeholder={line.kind === 'done' ? 'Done when…' : 'Sub-to-do title'}
                      aria-label={line.kind === 'done' ? 'Done when' : 'Sub-to-do'}
                      className="min-w-0 flex-1 border-0 bg-transparent text-text-primary outline-none placeholder:text-text-tertiary"
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 px-4 pb-3 pt-2">
              <Dropdown
                trigger={(
                  <button ref={statusRef} type="button" className={TODOS_DIALOG_CHIP} data-testid="new-todo-status" title="In progress starts it now; To do saves it without starting; Remind me… snoozes it until a time">
                    {reminder ? <Moon className="h-3.5 w-3.5 text-status-snoozed" aria-hidden="true" /> : startNow ? <TodoStatusIcon status="working" /> : <CircleDashed className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />}
                    <b className="font-medium text-text-primary">{reminder ? `Remind me · ${snoozeWhen(reminder.until, Date.now(), viewerZone())}` : startNow ? 'In progress' : 'To do'}</b>
                    <ChevronDown className="h-3 w-3 text-text-tertiary" aria-hidden="true" />
                  </button>
                )}
                items={[
                  { id: 'start', label: 'In progress', description: 'Starts it now', onClick: () => { setReminder(null); setStartNow(true); } },
                  { id: 'todo', label: 'To do', description: 'Saved, not started', onClick: () => { setReminder(null); setStartNow(false); } },
                  {
                    id: 'remind', label: 'Remind me…', description: 'Snoozed until a time, then a reminder card',
                    // After the menu closes and gives focus back, so the snooze menu keeps it.
                    onClick: () => window.setTimeout(() => setReminderAnchor(statusRef.current?.getBoundingClientRect() ?? null), 0),
                  },
                ]}
                selectedId={reminder ? 'remind' : startNow ? 'start' : 'todo'}
                selectedMark="check"
                header="Status"
                position="bottom-left"
                width="md"
              />
              <Dropdown
                trigger={<button type="button" className={TODOS_DIALOG_CHIP} data-testid="new-todo-repo">Repo <b className="font-medium text-text-primary">{repoName}</b></button>}
                items={repoItems}
                selectedId={projectId === null ? NO_REPO : String(projectId)}
                selectedMark="check"
                header="Repo"
                position="bottom-left"
                width="md"
              />
              <Dropdown
                trigger={<button type="button" className={TODOS_DIALOG_CHIP} data-testid="new-todo-machine">Machine <b className="font-medium text-text-primary">{machineName}</b></button>}
                items={machineItems}
                selectedId={machineId}
                selectedMark="check"
                header="Machine"
                position="bottom-left"
                width="lg"
              />
              <Dropdown
                trigger={<button type="button" className={TODOS_DIALOG_CHIP} data-testid="new-todo-agent">Agent <b className="font-medium text-text-primary">{PANE_CHAT_AGENT_LABELS[agent]}</b></button>}
                items={agentItems}
                selectedId={agent}
                selectedMark="check"
                header="Orchestrator agent"
                position="bottom-left"
                width="md"
              />
              <button type="button" className={TODOS_DIALOG_CHIP} onClick={() => addLine('done')} data-testid="new-todo-add-done">
                <Plus className="h-3 w-3" aria-hidden="true" />Done when
              </button>
              <button type="button" className={TODOS_DIALOG_CHIP} onClick={() => addLine('sub')} data-testid="new-todo-add-sub">
                <Plus className="h-3 w-3" aria-hidden="true" />Sub-to-do
              </button>
            </div>
            <div className="flex items-center gap-2.5 border-t border-border-primary px-3.5 py-2.5 text-[12.5px]">
              <button
                type="button"
                role="switch"
                aria-checked={startNow && !reminder}
                onClick={() => { setReminder(null); setStartNow(on => !on || reminder !== null); }}
                data-testid="new-todo-start-now"
                className="inline-flex select-none items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive"
              >
                <span className={cn('relative h-4 w-7 rounded-full transition-colors', startNow && !reminder ? 'bg-interactive' : 'bg-surface-tertiary')} aria-hidden="true">
                  <span className={cn('absolute top-0.5 h-3 w-3 rounded-full bg-surface-primary shadow-sm transition-[left]', startNow && !reminder ? 'left-3.5' : 'left-0.5')} />
                </span>
                Start now
              </button>
              <span className="text-text-tertiary" data-testid="new-todo-start-line">{reminder
                ? `Snoozed until ${snoozeWhen(reminder.until, Date.now(), viewerZone())}; ${reminder.action === 'remind' ? 'then a reminder card, no Session' : 'then Pane starts it'}`
                : startNow ? 'Creates its Session and starts an orchestrator' : 'Saved as not started; no Session until Start'}</span>
              <span className="flex-1" />
              <span className="inline-flex items-center gap-1" aria-hidden="true">
                <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 border-border-primary bg-surface-primary px-1 font-mono text-[10.5px] leading-none text-text-secondary">{isMac() ? '⌘' : 'Ctrl'}</kbd>
                <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 border-border-primary bg-surface-primary px-1 font-mono text-[10.5px] leading-none text-text-secondary">↵</kbd>
              </span>
              <button
                type="button"
                disabled={!canCreate}
                onClick={() => void submit()}
                data-testid="new-todo-create"
                className={cn(TODOS_BUTTON, 'border-transparent bg-interactive font-medium text-text-on-interactive hover:border-transparent hover:bg-interactive-hover')}
              >
                Create to-do
              </button>
            </div>
            </div>
            {reminderAnchor && (
              <SnoozeMenu
                target={{ title: title.trim() || 'New to-do', sessionId: null, snooze: reminder ? { ...reminder, by: 'you', from: 'todo', reminderCardId: null } : undefined }}
                anchor={reminderAnchor}
                verb="Remind me"
                onSubmit={choice => { setReminder(choice); setReminderAnchor(null); }}
                onClose={() => setReminderAnchor(null)}
              />
            )}
          </PortalContainerProvider>
          <div ref={setPortalContainer} className="pointer-events-none fixed inset-0" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
