import { useState, type ReactNode } from 'react';
import { Bell, Check } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { cn } from '../../utils/cn';
import { isMac } from '../../utils/platformUtils';
import { runNotify, useNotifyStore } from '../../stores/notifyStore';
import { NotifyCard } from './NotifyCard';
import { relativeAge, shortcutLabel } from './notifyFormat';
import { useNow } from './useNow';

type InboxTab = 'waiting' | 'earlier';

const newestFirst = (a: NotifyItem, b: NotifyItem) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt);

function GroupLabel({ children }: { children: ReactNode }) {
  return <div className="mx-0.5 mb-1.5 mt-3.5 text-[12px] font-medium text-text-tertiary first:mt-0">{children}</div>;
}

function RowList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border-secondary overflow-hidden rounded-[18px] bg-surface-primary shadow-card ring-1 ring-border-secondary">{children}</div>;
}

function UpdateRow({ item, now }: { item: NotifyItem; now: number }) {
  const action = item.action;
  const content = (
    <>
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-status-success text-text-on-status-success" aria-hidden="true">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      <span className="shrink-0 text-[12px] text-text-tertiary">{relativeAge(item.createdAt, now)}</span>
    </>
  );
  const className = 'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] text-text-primary';
  if (!action) return <div className={className}>{content}</div>;
  return (
    <button type="button" title={action.label} className={cn(className, 'hover:bg-surface-hover')} onClick={() => { void window.electronAPI.openExternal(action.url); }}>
      {content}
    </button>
  );
}

function HistoryRow({ item, now }: { item: NotifyItem; now: number }) {
  const expired = item.state === 'expired';
  return (
    <div className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px]" data-testid="notify-history-row">
      <span className={cn('flex min-w-0 flex-1 gap-1', expired ? 'text-text-tertiary' : 'text-text-primary')}>
        <span className="min-w-0 truncate">{item.title}</span>
        {/* The answer is what this row is for, so the title gives way first. */}
        {!expired && item.answerSummary && <span className="max-w-[55%] shrink-0 truncate">→ <b className="font-semibold">{item.answerSummary}</b></span>}
      </span>
      <span className="shrink-0 text-[12px] text-text-tertiary">{expired ? 'Expired' : relativeAge(item.resolvedAt ?? item.createdAt, now)}</span>
    </div>
  );
}

function EmptyState({ enabled }: { enabled: boolean }) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center" data-testid="notify-empty">
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-tertiary text-text-secondary">
        <Bell className="h-5 w-5" />
      </span>
      <h2 className="text-[15px] font-semibold text-text-primary">Nothing is waiting for you</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-text-tertiary">
        When an agent needs a decision, an approval or an answer, it calls the <code className="font-mono text-text-secondary">notify</code> tool.
        The question shows up here and as a card over any app, and your answer goes straight back to the agent.
        Updates that need no answer collect under For your information.
      </p>
      {!enabled && <p className="mt-3 text-[13px] text-text-secondary">Notify is off. Turn it on in Settings, under Notify.</p>}
    </div>
  );
}

/** The Notify page: every waiting question with one-click answers, plus today's updates and answers. */
export function NotifyInbox() {
  const snapshot = useNotifyStore((state) => state.snapshot);
  const [tab, setTab] = useState<InboxTab>('waiting');
  const now = useNow();
  const items = snapshot?.items ?? [];
  const waiting = items.filter((item) => item.state === 'waiting' || item.state === 'sent').sort(newestFirst);
  const waitingCount = waiting.filter((item) => item.state === 'waiting').length;
  const updates = items.filter((item) => item.state === 'info').sort(newestFirst);
  const earlier = items.filter((item) => item.state === 'answered' || item.state === 'expired').sort(newestFirst);
  const shortcut = shortcutLabel(snapshot?.settings.shortcut ?? 'Control+Shift+Space', isMac());

  const tabButton = (id: InboxTab, label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={cn(
        'rounded-md px-2.5 py-[3px]',
        tab === id ? 'bg-surface-primary font-medium text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-primary',
      )}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-primary" data-testid="notify-inbox">
      <header className="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-border-primary px-5">
        <h1 className="text-[15px] font-semibold text-text-primary">Notify</h1>
        <div role="tablist" aria-label="Notify" className="inline-flex gap-0.5 rounded-[9px] bg-surface-tertiary p-[3px] text-[12.5px]">
          {tabButton('waiting', 'Waiting', waitingCount)}
          {tabButton('earlier', 'Earlier today', earlier.length)}
        </div>
        <button
          type="button"
          disabled={waitingCount === 0}
          onClick={() => runNotify({ type: 'open-round' })}
          className="ml-auto inline-flex h-[30px] items-center gap-2 rounded-[10px] bg-interactive px-3 text-[12.5px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50"
        >
          Answer all
          <span className="font-mono text-[11px] opacity-70">{shortcut}</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-bg-secondary px-5 py-4">
        {tab === 'waiting' ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
            <div className="flex min-w-0 flex-col gap-2.5">
              {waiting.length === 0 && <EmptyState enabled={snapshot?.settings.enabled ?? true} />}
              {waiting.map((item) => (
                <NotifyCard
                  key={item.id}
                  item={item}
                  view={item.state === 'sent' ? 'sent' : 'question'}
                  form="inbox"
                  menuPlacement="below"
                  onCommand={runNotify}
                />
              ))}
            </div>
            {(updates.length > 0 || earlier.length > 0) && (
              <aside className="min-w-0">
                {updates.length > 0 && (
                  <>
                    <GroupLabel>For your information</GroupLabel>
                    <RowList>{updates.map((item) => <UpdateRow key={item.id} item={item} now={now} />)}</RowList>
                  </>
                )}
                {earlier.length > 0 && (
                  <>
                    <GroupLabel>Earlier today</GroupLabel>
                    <RowList>{earlier.map((item) => <HistoryRow key={item.id} item={item} now={now} />)}</RowList>
                  </>
                )}
              </aside>
            )}
          </div>
        ) : (
          <div className="max-w-2xl">
            {earlier.length === 0
              ? <p className="mt-10 text-center text-[13px] text-text-tertiary">Nothing answered yet today. Earlier today clears at midnight.</p>
              : <RowList>{earlier.map((item) => <HistoryRow key={item.id} item={item} now={now} />)}</RowList>}
          </div>
        )}
      </div>
    </div>
  );
}
