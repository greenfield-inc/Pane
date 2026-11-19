import { useMemo, type ReactNode } from 'react';
import { ListTodo, Menu } from 'lucide-react';
import { PANE_CHAT_AGENT_LABELS } from '../../../../shared/types/paneChat';
import type { RemotePaneConnectionStatus, RemotePwaSessionAgents } from '../../../../shared/types/remoteDaemon';
import { DEFAULT_APPEARANCE } from '../../../../shared/types/appearance';
import { ErrorDialog } from '../../components/ErrorDialog';
import { PhoneTodos } from '../../components/todos/phone/PhoneTodos';
import type { PhoneTodoChoices } from '../../components/todos/phone/PhoneTodoForm';
import type { PhoneTodosRoute } from '../../components/todos/phone/phoneRoute';
import type { PhoneTodosSession } from '../../components/todos/phone/PhoneSessionTodos';
import { TodoStatusIcon } from '../../components/todos/TodoStatusIcon';
import { navSummary } from '../../components/todos/todoList';
import { useTodoEntries } from '../../components/todos/useTodoEntries';
import { ThemeContext, type ThemeContextType } from '../../contexts/themeContextValue';
import { useErrorStore } from '../../stores/errorStore';
import { cn } from '../../utils/cn';
import { useRemoteSessionStore } from '../stores/remoteSessionStore';

/**
 * The web app's one theme (bootstrap.tsx fixes it to light-rounded), for the pieces of the desktop's
 * to-do and approval screens that ask which theme is on (the approval's Summary).
 */
const REMOTE_THEME: ThemeContextType = {
  theme: 'light-rounded',
  themeChoice: 'light-rounded',
  themeRevision: 'light-rounded',
  customTheme: { theme: null, base: null, error: null },
  appearance: { ...DEFAULT_APPEARANCE, appearanceMode: 'fixed', theme: 'light-rounded' },
  prefersDark: false,
  activeSystemSlot: undefined,
  setTheme: async () => undefined,
  setAppearance: async () => undefined,
  highContrast: false,
};

export interface RemoteTodosProps {
  route: PhoneTodosRoute;
  onNavigate: (route: PhoneTodosRoute) => void;
  onReplace: (route: PhoneTodosRoute) => void;
  onBack: () => void;
  onOpenSidebar: () => void;
  onOpenSession: (sessionId: string) => void;
  /** The host, as New to-do's Machine chip names it. */
  hostLabel: string;
  sessionAgents?: RemotePwaSessionAgents;
  status: RemotePaneConnectionStatus;
  /** Opened from a Session's header (T-23): that Session's to-dos. */
  session?: PhoneTodosSession;
}

/**
 * To-dos in the web app (P7): the one-column phone screens over the connected host, with the
 * drawer's menu on the list, a line while the host can't be reached, and the errors their actions
 * report. Wider screens (a tablet, landscape) use the same one column (D-423: no split there yet).
 */
export function RemoteTodos({ route, onNavigate, onReplace, onBack, onOpenSidebar, onOpenSession, hostLabel, sessionAgents, status, session }: RemoteTodosProps) {
  const projects = useRemoteSessionStore((state) => state.projects);
  const { currentError, clearError } = useErrorStore();
  const choices = useMemo<PhoneTodoChoices>(() => ({
    repos: projects.map((project) => ({ id: project.id, name: project.name })),
    defaultRepoId: (projects.find((project) => project.active) ?? projects[0])?.id,
    agents: (sessionAgents?.agents ?? []).map((id) => ({ id, label: PANE_CHAT_AGENT_LABELS[id] })),
    defaultAgent: sessionAgents?.defaultAgent,
    machine: hostLabel,
  }), [projects, sessionAgents, hostLabel]);
  const lead = (
    <button type="button" onClick={onOpenSidebar} aria-label="Open remote panes" className="inline-flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary md:hidden">
      <Menu className="h-5 w-5" aria-hidden="true" />
    </button>
  );
  return (
    <ThemeContext.Provider value={REMOTE_THEME}>
      {/* 16 px in every text box, so Safari never zooms into one as it takes focus. */}
      <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col md:border-x md:border-border-primary [&_textarea]:!text-[16px]" data-testid="remote-todos">
        {status !== 'connected' && <ConnectionLine status={status} hostLabel={hostLabel} />}
        <PhoneTodos route={route} onNavigate={onNavigate} onReplace={onReplace} onBack={onBack} choices={choices} listLead={lead} onOpenSession={onOpenSession} session={session} />
      </div>
      <ErrorDialog isOpen={currentError !== null} onClose={clearError} title={currentError?.title} error={currentError?.error ?? ''} details={currentError?.details} />
    </ThemeContext.Provider>
  );
}

const STATUS_WORDS = {
  connected: 'Connected to',
  connecting: 'Connecting to',
  restoring: 'Restoring workspace on',
  reconnecting: 'Reconnecting to',
  error: 'Can’t reach',
  local: 'Disconnected from',
} as const satisfies Record<RemotePaneConnectionStatus, string>;

/** While the host can't be reached the to-dos shown are its last ones: one line says so. */
function ConnectionLine({ status, hostLabel }: { status: RemotePaneConnectionStatus; hostLabel: string }) {
  return (
    <p role="status" className="shrink-0 border-b border-border-primary bg-surface-secondary px-4 pt-[env(safe-area-inset-top)] text-center text-[13px] leading-8 text-text-secondary">
      {STATUS_WORDS[status]} {hostLabel}… To-dos shown are the last ones read.
    </p>
  );
}

/** The drawer's To-dos entry: the Working spinner while one is worked on, and the amber count waiting on you. */
export function RemoteTodosEntry({ open, onOpen }: { open: boolean; onOpen: () => void }): ReactNode {
  const entries = useTodoEntries();
  const summary = useMemo(() => navSummary(entries), [entries]);
  const label = summary.waiting > 0 ? `To-dos, ${summary.waiting} waiting on you` : 'To-dos';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={open}
      aria-label={label}
      className={cn('flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-surface-hover hover:text-text-primary md:min-h-8', open ? 'bg-surface-hover text-text-primary' : 'text-text-secondary')}
      data-testid="remote-todos-entry"
    >
      <ListTodo className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>To-dos</span>
      <span className="ml-auto flex items-center gap-1.5" aria-hidden="true">
        {summary.working ? <TodoStatusIcon status="working" /> : <span className="h-3.5 w-3.5" />}
        {summary.waiting > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-status-warning px-1.5 text-[11.5px] font-semibold tabular-nums text-text-on-status-warning" data-testid="remote-todos-count">{summary.waiting}</span>
        )}
      </span>
    </button>
  );
}
