import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { ChatTabContextUsage, ChatTabTask } from '../../../../shared/types/chatTab';
import {
  contextLeft, DEFAULT_STATUS_ITEMS, prStateName, readStatusItems, STATUS_ITEM_NAMES, STATUS_ITEMS, taskAge, writeStatusItems, type StatusItem,
} from '../../../../shared/chatStatusBar';
import { Dropdown } from '../ui/Dropdown';

/** The pull request of the chat's Pane, when it has one. */
export interface ChatStatusPullRequest { number: number; url?: string; state?: string; draft?: boolean }

/** One store per window, so every chat's bar follows a change made in any of them. */
const listeners = new Set<() => void>();
function browserStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
let current: readonly StatusItem[] = readStatusItems(browserStorage());
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function setStatusItems(items: readonly StatusItem[]) {
  writeStatusItems(browserStorage(), items);
  current = readStatusItems(browserStorage());
  listeners.forEach(listener => listener());
}
/** The status items this device shows. */
function useStatusItems(): readonly StatusItem[] {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Re-renders every 15s while tasks run, so their ages move. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export interface ChatStatusBarProps {
  context?: ChatTabContextUsage;
  tasks?: readonly ChatTabTask[];
  queued: number;
  pr?: ChatStatusPullRequest;
  working: boolean;
  phone: boolean;
  /** Offered beside the context left, when the tab can /clear. */
  onClear?: () => void;
  onStopTask: (taskId: string) => void;
  onShowQueue: () => void;
}

/**
 * The line above the composer (D-222, D-253, D-267): context left, the Pane's pull request,
 * background tasks and queued messages, each opening what it names. Model and mode stay on the
 * composer row.
 * "…" picks which items show, remembered on this device. Items with nothing to say stay out.
 */
export function ChatStatusBar({ context, tasks = [], queued, pr, working, phone, onClear, onStopTask, onShowQueue }: ChatStatusBarProps) {
  const shown = useStatusItems();
  const now = useNow(tasks.length > 0);
  const left = contextLeft(context);
  const items: Array<{ id: StatusItem; node: ReactNode }> = [];
  for (const id of shown) {
    const node = statusItem(id);
    if (node) items.push({ id, node });
  }

  function statusItem(id: StatusItem): ReactNode {
    switch (id) {
      case 'context':
        if (!left) return null;
        return <Dropdown className="chat-status-anchor" position="top-left" width="lg" items={[]} formLabel="Context left"
          trigger={<button type="button" className="chat-status-item" data-tone={left.low ? 'warning' : undefined} title={`${left.percent}% of context left · ${left.detail}`}>
            {phone && <span className="sr-only">Context </span>}
            <span className="chat-chip-label">{phone ? `${left.percent}%` : `Ctx ${left.percent}%`}</span><span className="sr-only"> left</span>
          </button>}
          footer={({ close }) => <div className="chat-status-panel">
            <p className="chat-status-panel-title">{left.percent}% of context left</p>
            <div className="chat-status-meter" aria-hidden><span style={{ width: `${left.percent}%` }} data-tone={left.low ? 'warning' : undefined} /></div>
            <p className="chat-status-panel-muted">{left.detail}.{left.low ? ' The agent will compact or stop soon.' : ''}</p>
            {onClear && <button type="button" className="chat-status-button self-start" onClick={() => { close(); onClear(); }}>Clear conversation</button>}
          </div>} />;
      case 'pr': {
        if (!pr) return null;
        const state = prStateName(pr.state, pr.draft);
        const label = <>#{pr.number}{state && !phone && <> · {state}</>}</>;
        return pr.url
          ? <a className="chat-status-item" href={pr.url} target="_blank" rel="noreferrer" title={`Open pull request #${pr.number}${state ? ` (${state})` : ''}`}>{label}</a>
          : <span className="chat-status-item">{label}</span>;
      }
      case 'tasks':
        if (!tasks.length) return null;
        return <Dropdown className="chat-status-anchor" position="top-left" width="lg" items={[]} formLabel="Background tasks"
          trigger={<button type="button" className="chat-status-item" title="Background tasks">{tasks.length} task{tasks.length === 1 ? '' : 's'}</button>}
          footer={<div className="chat-status-panel">
            <p className="chat-status-panel-title">Running in the background</p>
            <ul className="chat-status-tasks">
              {tasks.map(task => <li key={task.id}>
                <span className="chat-status-task-name" title={task.title ?? task.kind}>{task.title ?? task.kind}</span>
                <span className="chat-status-panel-muted">{taskAge(task.startedAt, now)}</span>
                {task.canStop !== false && <button type="button" className="chat-status-button" onClick={() => onStopTask(task.id)}>Stop</button>}
              </li>)}
            </ul>
          </div>} />;
      case 'queue':
        if (!queued) return null;
        return <button type="button" className="chat-status-item" title="Show queued messages" onClick={onShowQueue}>{queued} queued</button>;
    }
  }

  const customize = <Dropdown className="chat-status-anchor chat-status-more" position="top-left" width="lg" items={[]} formLabel="Status bar items"
    trigger={<button type="button" className="chat-status-item" aria-label="Choose what the status bar shows" title="Customize"><MoreHorizontal className="h-4 w-4" aria-hidden /></button>}
    footer={<div className="chat-status-panel">
      <p className="chat-status-panel-heading">Show above the chat box</p>
      {STATUS_ITEMS.map(id => <label key={id} className="chat-status-check">
        <input type="checkbox" checked={shown.includes(id)} data-autofocus={id === STATUS_ITEMS[0] ? '' : undefined}
          onChange={event => setStatusItems(event.target.checked ? [...shown, id] : shown.filter(item => item !== id))} />
        <span>{STATUS_ITEM_NAMES[id]}</span>
      </label>)}
      <div className="chat-status-panel-foot">
        <span className="chat-status-panel-muted">Remembered on this device</span>
        <button type="button" className="chat-status-link" onClick={() => setStatusItems(DEFAULT_STATUS_ITEMS)}>Reset to default</button>
      </div>
    </div>} />;

  return <div className="chat-statusline" role="toolbar" aria-label="Chat status" data-layout={phone ? 'phone' : 'desktop'}>
    <div className="chat-status-items">
      {items.map(item => <div key={item.id} className="chat-status-cell" data-item={item.id}>{item.node}</div>)}
    </div>
    {customize}
    {working && !phone && <span className="chat-status-hint" title="Send now: stops this turn and sends your message"><kbd>{sendNowKeys()}</kbd><span className="chat-status-hint-text"> send now</span></span>}
  </div>;
}

/** The keys that send now on this computer. */
export function sendNowKeys(): string {
  return /mac|iphone|ipad/i.test(navigator.platform) ? '⌘↵' : 'Ctrl+↵';
}
