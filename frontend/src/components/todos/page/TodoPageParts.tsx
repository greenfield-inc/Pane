import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TodoListRow } from '../../../../../shared/types/todos';
import { agentConfig } from '../../../../../shared/agents';
import { agentIdIcon } from '../../ui/brandIconRegistry';
import { relativeAge } from '../../notify/notifyFormat';
import { cn } from '../../../utils/cn';
import { TODO_STATUS_LABEL, TodoStatusIcon } from '../TodoStatusIcon';

/**
 * Markdown at the page's size (MarkdownPreview's own sheet is for a full document): no padding,
 * 13 px text, headings near body size and short gaps. `!` beats `.markdown-preview` rules.
 */
export const COMPACT_MARKDOWN = cn(
  '!overflow-visible !p-0 !text-[13px] !leading-[1.6] text-text-primary',
  '[&_p:last-child]:!mb-0 [&_p]:!mb-1.5 [&_li]:!mb-0.5 [&_ol]:!mb-1.5 [&_ul]:!mb-1.5',
  '[&_h1]:!mb-1 [&_h1]:!mt-3 [&_h1]:!text-[16px] [&_h2]:!mb-1 [&_h2]:!mt-3 [&_h2]:!text-[14.5px] [&_h3]:!mb-1 [&_h3]:!mt-2 [&_h3]:!text-[13.5px] [&_h4]:!text-[13px]',
);

/** "2h ago", or "now". */
export function agoText(since: number, now: number): string {
  const age = relativeAge(since, now);
  return age === 'now' ? 'now' : `${age} ago`;
}

/** An agent's mark in a fixed 20 px box: its brand icon, or its initial when Pane has no entry for it. */
export function AgentAvatar({ agentId, name, className }: { agentId?: string; name: string; className?: string }) {
  const known = agentId ? agentConfig(agentId) : undefined;
  return (
    <span className={cn('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface-tertiary text-[10.5px] font-bold text-text-primary', className)} aria-hidden="true" data-testid="todo-agent-avatar">
      {known ? agentIdIcon(agentId, 'h-3.5 w-3.5') : (name.trim()[0] ?? '·').toUpperCase()}
    </span>
  );
}

/** The words after a sub-to-do's title: "Working · implementer". */
function subTodoMeta(row: TodoListRow): string {
  const who = row.todo.assignee?.name;
  return who ? `${TODO_STATUS_LABEL[row.status.status]} · ${who}` : TODO_STATUS_LABEL[row.status.status];
}

/** Sub-to-do rows: status icon, T-n, title, and "Working · implementer ›"; each opens its page. */
export function SubTodoRows({ rows, onOpen, compact = false }: { rows: readonly TodoListRow[]; onOpen: (number: number) => void; compact?: boolean }) {
  return (
    <div className="flex flex-col" data-testid="todo-sub-rows">
      {rows.map((row) => (
        <button
          key={row.todo.number}
          type="button"
          onClick={() => onOpen(row.todo.number)}
          className={cn('flex w-full items-center gap-[9px] rounded-lg px-2 py-1.5 text-left text-[13px] text-text-primary hover:bg-surface-hover', compact && 'items-start')}
          data-testid="todo-sub-row"
          data-todo={row.todo.number}
        >
          <span className={cn('flex h-[18px] items-center', compact && 'pt-0.5')}><TodoStatusIcon status={row.status.status} /></span>
          <span className="w-10 shrink-0 text-[12.5px] tabular-nums text-text-tertiary">{row.todo.ref}</span>
          <span className="min-w-0 flex-1 truncate">{row.todo.title}</span>
          <span className={cn('ml-auto inline-flex shrink-0 items-center gap-0.5 text-[12px] text-text-tertiary', compact && 'max-w-[110px] text-right')}>
            <span className={cn(!compact && 'truncate')}>{subTodoMeta(row)}</span>
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          </span>
        </button>
      ))}
    </div>
  );
}

/** The small all-caps label over a card or rail section ("DONE WHEN", "ATTACHMENTS · 5"). */
export function SectionLabel({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-1.5 mt-3 flex items-center text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary', className)}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {action}
    </div>
  );
}

/** "+ Add", "+ Attach": a small link-like action at the right of a section label. */
export function SectionAction({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 text-[12px] font-medium normal-case tracking-normal text-interactive-text hover:underline" data-testid={testId}>
      + {label}
    </button>
  );
}
