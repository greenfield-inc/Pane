import { Archive, Ghost, HardDrive, MemoryStick, Moon, Sparkles, TrendingUp } from 'lucide-react';
import type { MachineHealthCard } from '../../../../shared/types/machineHealth';
import type { NotifyItem } from '../../../../shared/types/notify';
import { cn } from '../../utils/cn';
import { formatBytes, formatMB } from '../../../../shared/utils/formatBytes';
import { cardTitle } from './healthCardActions';

const NOT_NOW = 'Not now';
const PAUSE_IDLE = 'Pause idle Panes';

export interface HealthCardBodyProps {
  item: NotifyItem & { machineHealth: MachineHealthCard };
  /** Answers the card with one of its choices; it runs on the machine that raised it. */
  onAnswer: (choice: string) => void;
  /** Hands the card's list to an agent in a Clean up Session and shows it. */
  onAskAgent: () => void;
  /** Opens Resources with the card's machine selected; absent until the page exists here. */
  onReview?: () => void;
  /** The raising machine's name when it is not this one. */
  machineName?: string;
  compact?: boolean;
}

const KIND_ICON = { disk: HardDrive, memory: MemoryStick, leak: TrendingUp, finished: Archive, leftovers: Ghost } as const;

/** A small rising line of the process's memory across the window. */
function Sparkline({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const points = series.map((value, index) => `${(index / (series.length - 1)) * 120},${28 - ((value - min) / span) * 26}`).join(' ');
  return (
    <svg viewBox="0 0 120 30" className="h-7 w-28 text-status-warning" aria-hidden="true">
      <polyline points={`0,30 ${points} 120,30`} className="fill-status-warning/15" stroke="none" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** The machine health dialog's content: the rows, the pause offer, and the actions. */
export function HealthCardBody({ item, onAnswer, onAskAgent, onReview, machineName, compact = false }: HealthCardBodyProps) {
  const card = item.machineHealth;
  const choices = (item.choices ?? []).map(choice => choice.label);
  const primary = choices.find(label => label !== NOT_NOW && label !== PAUSE_IDLE);
  const Icon = KIND_ICON[card.kind];
  const largest = Math.max(1, ...card.rows.map(row => row.bytes));
  const rowsTitle = card.kind === 'memory' ? `Using the most memory${machineName ? ` on ${machineName}` : ''}`
    : card.kind === 'disk' ? 'Pane can free' : card.kind === 'finished' ? 'Finished Panes' : card.kind === 'leftovers' ? 'Still running' : null;

  return (
    <div className="flex flex-col gap-4" data-testid={`health-card-${card.kind}`}>
      <div className="flex items-center gap-3">
        <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
          card.level === 'critical' ? 'bg-status-error/15 text-status-error' : 'bg-status-warning/15 text-status-warning')}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        {machineName && (
          <span className="rounded-full border border-border-primary px-2.5 py-0.5 text-xs text-text-secondary">{machineName}</span>
        )}
      </div>
      <div>
        <h2 className="text-lg font-semibold text-text-primary">{cardTitle(item)}</h2>
        {item.context && <p className="mt-1 text-sm text-text-secondary">{item.context}</p>}
      </div>

      {card.kind === 'leak' && card.leak && (
        <div className="flex items-center gap-3 rounded-lg border border-border-primary px-3 py-2">
          <Sparkline series={card.leak.series} />
          <span className="text-sm text-text-secondary">{formatMB(card.leak.series[card.leak.series.length - 1] ?? 0)} now</span>
        </div>
      )}

      {rowsTitle && card.rows.length > 0 && (
        <div>
          <div className="mb-1.5 text-sm text-text-primary">{rowsTitle}</div>
          {/* Every row the card's action covers is listed; the list scrolls instead of hiding rows. */}
          <ul className={cn('divide-y divide-border-primary overflow-y-auto rounded-lg border border-border-primary', compact ? 'max-h-40' : 'max-h-72')}>
            {card.rows.map(row => (
              <li key={`${row.label}-${row.detail}-${row.note ?? ''}`} className={cn('flex items-center gap-3 px-3 py-2 text-sm', row.skipped && 'text-text-tertiary')}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <span className={row.skipped ? 'text-text-tertiary' : 'text-text-primary'}>{row.label}</span>
                    <span className="ml-1.5 text-text-tertiary">{row.detail}</span>
                  </span>
                  {row.command && <span className="line-clamp-2 break-all font-mono text-xs text-text-tertiary" title={row.command}>{row.command}</span>}
                </span>
                {row.note && <span className="shrink-0 rounded px-1.5 py-0.5 text-xs text-text-secondary bg-surface-secondary">{row.note}</span>}
                {card.kind === 'memory' && (
                  <span className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-surface-tertiary" aria-hidden="true">
                    <span className="block h-full rounded-full bg-status-warning" style={{ width: `${Math.max(3, (row.bytes / largest) * 100)}%` }} />
                  </span>
                )}
                <span className="w-16 shrink-0 text-right tabular-nums text-text-primary">{row.bytes > 0 ? formatBytes(row.bytes) : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={cn('grid gap-3', onReview ? 'grid-cols-2' : 'grid-cols-1')}>
        {onReview && (
          <button type="button" onClick={onReview}
            className="flex flex-col items-start gap-1 rounded-lg bg-interactive px-4 py-3 text-left text-text-on-interactive hover:bg-interactive-hover">
            <span className="flex items-center gap-2 font-medium"><HardDrive className="h-4 w-4" aria-hidden="true" />{machineName ? `Review on ${machineName}` : 'Review in Resources'}</span>
            <span className="text-sm opacity-90">{machineName ? `Opens Resources with ${machineName} selected.` : 'Opens Resources so you pick what to clean.'}</span>
          </button>
        )}
        <button type="button" onClick={onAskAgent}
          className="flex flex-col items-start gap-1 rounded-lg border border-border-primary px-4 py-3 text-left hover:bg-surface-hover">
          <span className="flex items-center gap-2 font-medium text-text-primary"><Sparkles className="h-4 w-4" aria-hidden="true" />Ask an agent</span>
          <span className="text-sm text-text-secondary">{machineName ? `Opens a Session with this list; the agent works on ${machineName}.` : 'Opens a Session with this list; the agent asks you before it changes anything.'}</span>
        </button>
      </div>

      {card.pauseOffer && card.pauseOffer.paneCount > 0 && choices.includes(PAUSE_IDLE) && (
        <div className="flex items-center gap-3 rounded-lg bg-surface-secondary px-4 py-3">
          <Moon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-primary">{`Pause ${machineName ? `${machineName} ` : ''}Panes idle ${card.pauseOffer.hours}+ hours`}</div>
            <div className="text-sm text-text-secondary">
              {`Stops agents and terminals in ${card.pauseOffer.paneCount} Pane${card.pauseOffer.paneCount === 1 ? '' : 's'}. Opening a Pane resumes it. Frees about ${formatMB(card.pauseOffer.memoryMB)}.`}
            </div>
          </div>
          <button type="button" onClick={() => onAnswer(PAUSE_IDLE)} className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover">Pause</button>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {choices.filter(label => label !== NOT_NOW && label !== PAUSE_IDLE && label !== primary).map(label => (
          <button key={label} type="button" onClick={() => onAnswer(label)} className="rounded-md px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover">{label}</button>
        ))}
        {choices.includes(NOT_NOW) && (
          <button type="button" onClick={() => onAnswer(NOT_NOW)} className="rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-hover">{NOT_NOW}</button>
        )}
        {primary && (
          <button type="button" onClick={() => onAnswer(primary)} className="rounded-md bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover">
            {card.freesBytes ? `${primary} · ${formatBytes(card.freesBytes)}` : primary}
          </button>
        )}
      </div>
    </div>
  );
}
