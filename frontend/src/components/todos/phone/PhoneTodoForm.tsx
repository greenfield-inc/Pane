import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TodoCreateInput, TodoRecord } from '../../../../../shared/types/todos';
import { todosApi, useTodoDetail, useTodosStore } from '../../../stores/todosStore';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { cn } from '../../../utils/cn';
import { PHONE_SCROLL, PHONE_SIDES, PhoneHeader, PhoneScreen } from './phoneParts';

/** A repository the new to-do can start its Session in. */
interface PhoneTodoRepo {
  id: number;
  name: string;
}

/** An agent the new to-do's orchestrator can be. */
interface PhoneTodoAgent {
  id: string;
  label: string;
}

/** What the host offers a new to-do: its repos, its agents, and its own name. */
export interface PhoneTodoChoices {
  repos: readonly PhoneTodoRepo[];
  /** The repo the form starts on; the first when unset. */
  defaultRepoId?: number;
  agents: readonly PhoneTodoAgent[];
  defaultAgent?: string;
  /** The host, as the Machine chip names it. */
  machine: string;
}

export interface PhoneTodoFormProps {
  /** New sub-to-do of this to-do; unset for a new to-do. */
  parentNumber?: number;
  choices: PhoneTodoChoices;
  onCancel: () => void;
  onCreated: (todo: TodoRecord) => void;
}

const LABEL = 'mb-1 mt-5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary';
/** 16 px text, so Safari doesn't zoom into a field when it takes focus. */
const FIELD = 'w-full border-0 border-b border-border-secondary bg-transparent py-3 text-[16px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-interactive';
const CHIP = 'relative inline-flex h-8 max-w-full items-center gap-1 rounded-[7px] border border-border-primary bg-surface-primary px-2.5 text-[13px] text-text-secondary focus-within:ring-2 focus-within:ring-interactive';

/**
 * New to-do and New sub-to-do on a phone (D-422): full screen, Cancel and Create in the header, then
 * the title, description, done-when and (top-level only) sub-to-do lines, the repo, machine and agent,
 * and Start now. A new to-do starts in its own Session; a sub-to-do in its parent's.
 */
export function PhoneTodoForm({ parentNumber, choices, onCancel, onCreated }: PhoneTodoFormProps) {
  const sub = parentNumber !== undefined;
  const parent = useTodoDetail(parentNumber ?? null);
  const refresh = useTodosStore((state) => state.refresh);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [doneWhen, setDoneWhen] = useState<string[]>(['']);
  const [subTodos, setSubTodos] = useState<string[]>(['']);
  const [repoId, setRepoId] = useState<number | null>(choices.defaultRepoId ?? choices.repos[0]?.id ?? null);
  const [agent, setAgent] = useState<string | null>(choices.defaultAgent ?? choices.agents[0]?.id ?? null);
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, []);

  const canCreate = title.trim().length > 0 && !busy;
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canCreate) return;
    const api = todosApi();
    if (!api) return;
    const input: TodoCreateInput = {
      title: title.trim(),
      summary: summary.trim() || undefined,
      doneWhen: lines(doneWhen),
      subTodos: sub ? undefined : lines(subTodos),
      projectId: sub ? undefined : repoId,
      agent,
      startNow,
      parentNumber: parentNumber ?? null,
    };
    setBusy(true);
    setError(null);
    try {
      const response = await api.create(input);
      if (!response.success || !response.data) throw new Error(response.error ?? 'Pane did not say why.');
      await refresh();
      onCreated(response.data);
    } catch (cause) {
      setError(`Could not create the to-do. ${ipcErrorMessage(cause, 'Pane did not say why.')} Nothing was created.`);
      setBusy(false);
    }
  };

  const heading = sub ? 'New sub-to-do' : 'New to-do';
  return (
    <PhoneScreen className="fixed inset-0 z-50" testId="phone-todo-form">
      <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col" aria-label={heading}>
        <PhoneHeader
          title={heading}
          back={{ label: 'Cancel', onBack: onCancel }}
          right={(
            <button type="submit" disabled={!canCreate} aria-busy={busy} className="mr-1 h-8 rounded-[7px] bg-interactive px-3 text-[14px] font-semibold text-text-on-interactive outline-none focus-visible:ring-2 focus-visible:ring-interactive disabled:opacity-50" data-testid="phone-form-create">
              {busy ? 'Creating…' : 'Create'}
            </button>
          )}
        />
        <div className={PHONE_SCROLL}>
          <div className={cn(PHONE_SIDES, 'pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3.5')}>
            {sub && (
              <p className="mb-1 text-[12.5px] text-text-tertiary" data-testid="phone-form-parent">
                Sub-to-do of T-{parentNumber}{parent ? ` · ${parent.todo.title}` : ''} · same Session
              </p>
            )}
            <input ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" aria-label="Title" enterKeyHint="next" className={cn(FIELD, '!text-[20px] font-semibold')} data-testid="phone-form-title" />
            <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} placeholder="Description (Markdown)" aria-label="Description" className={cn(FIELD, 'resize-none')} data-testid="phone-form-summary" />
            <span className={LABEL}>Done when</span>
            <LineFields lines={doneWhen} onChange={setDoneWhen} placeholder="Add a check" label="Done when" />
            {!sub && (
              <>
                <span className={LABEL}>Sub-to-dos</span>
                <LineFields lines={subTodos} onChange={setSubTodos} placeholder="Add a sub-to-do" label="Sub-to-do" />
              </>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {!sub && (
                <ChipSelect label="Repo" value={repoId === null ? '' : String(repoId)} onChange={(value) => setRepoId(value ? Number(value) : null)}>
                  {choices.repos.length === 0 && <option value="">None</option>}
                  {choices.repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
                </ChipSelect>
              )}
              {!sub && <span className={CHIP} data-testid="phone-form-machine">Machine <b className="truncate font-semibold text-text-primary">{choices.machine}</b></span>}
              {choices.agents.length > 0 && (
                <ChipSelect label="Agent" value={agent ?? ''} onChange={setAgent}>
                  {choices.agents.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </ChipSelect>
              )}
            </div>
            <label className="mt-4 flex min-h-11 items-center gap-3 text-[15px] text-text-primary">
              <span className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors', startNow ? 'bg-interactive' : 'bg-surface-tertiary')}>
                <input type="checkbox" checked={startNow} onChange={(event) => setStartNow(event.target.checked)} className="peer sr-only" aria-label="Start now" data-testid="phone-form-start-now" />
                <span className={cn('absolute top-1 h-5 w-5 rounded-full bg-text-on-interactive shadow-sm ring-1 ring-border-primary transition-transform', startNow ? 'translate-x-6' : 'translate-x-1')} />
              </span>
              <span>Start now <span className="text-text-secondary">{sub ? `(the T-${parentNumber} orchestrator assigns it)` : '(its own Session)'}</span></span>
            </label>
            {error && <p role="alert" className="mt-4 rounded-md border border-status-error/40 bg-status-error/10 p-3 text-[14px] text-text-primary" data-testid="phone-form-error">{error}</p>}
          </div>
        </div>
      </form>
    </PhoneScreen>
  );
}

/** The non-empty lines, or none. */
function lines(values: readonly string[]): string[] | undefined {
  const kept = values.map((value) => value.trim()).filter(Boolean);
  return kept.length ? kept : undefined;
}

/** One field per line, and always an empty one at the end to add the next. */
function LineFields({ lines: values, onChange, placeholder, label }: { lines: string[]; onChange: (lines: string[]) => void; placeholder: string; label: string }) {
  const update = (index: number, value: string) => {
    const next = values.map((line, at) => (at === index ? value : line));
    // Typing in the last field adds an empty one under it; emptied fields above the last go.
    const trimmed = next.filter((line, at) => line !== '' || at === next.length - 1);
    if (trimmed[trimmed.length - 1] !== '') trimmed.push('');
    onChange(trimmed);
  };
  return (
    <>
      {values.map((line, index) => (
        <input
          key={index}
          value={line}
          onChange={(event) => update(index, event.target.value)}
          placeholder={placeholder}
          aria-label={`${label} ${index + 1}`}
          enterKeyHint="next"
          className={FIELD}
        />
      ))}
    </>
  );
}

/** A chip ("Repo billing ⌄") over the phone's own picker. */
function ChipSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <label className={CHIP}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} className="max-w-[10rem] appearance-none truncate bg-transparent text-[16px] font-semibold text-text-primary outline-none">
        {children}
      </select>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
    </label>
  );
}
