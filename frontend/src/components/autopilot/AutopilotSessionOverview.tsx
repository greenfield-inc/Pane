import { useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import type { OrchestrationPaneOverview, OrchestrationSessionOverview } from '../../../../shared/types/orchestrationSession';
import { API } from '../../utils/api';
import { cn } from '../../utils/cn';
import { relativeAge } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import { onSessionOverviewChange } from '../../utils/sessionOverviewEvents';

/** One Pane's line: its state from its report or its tabs, with its PR. */
interface PaneLine { tone: 'done' | 'waiting' | 'running' | 'idle'; text: string }

function paneLine(pane: OrchestrationPaneOverview): PaneLine {
  const report = pane.report;
  if (report?.state === 'blocked') return { tone: 'waiting', text: report.question ? `waiting: ${report.question}` : 'waiting on you' };
  if (pane.panels.some(panel => panel.state === 'blocked')) return { tone: 'waiting', text: 'waiting on a prompt' };
  if (pane.panels.some(panel => panel.state === 'working')) return { tone: 'running', text: 'running' };
  if (report?.state === 'done') return { tone: 'done', text: report.pr ? `PR #${report.pr} · reported done` : 'reported done' };
  return { tone: 'idle', text: report?.pr ? `PR #${report.pr}` : 'idle' };
}

const DOT = { done: 'bg-status-success', waiting: 'bg-status-warning', running: 'bg-status-info', idle: 'bg-status-neutral' } as const;

/**
 * A Session's overview on the stack (close-out, d3): its Panes and their state, and the tabs that
 * reported done. Read live from Pane; Autopilot stores no copy (stack.json keeps the reference).
 */
export function AutopilotSessionOverview({ sessionId }: { sessionId: string }) {
  const [overview, setOverview] = useState<OrchestrationSessionOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  useEffect(() => {
    let live = true;
    const read = () => {
      void API.orchestrationSessions.overview({ sessionId }).then((response) => {
        if (!live) return;
        if (response.success && response.data) { setOverview(response.data); setError(null); }
        else setError(response.error ?? 'Pane could not read this Session.');
      }).catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    };
    read();
    // Detaching a Pane or recording a report changes the overview too (they emit sessions-changed).
    const stop = onSessionOverviewChange(read);
    return () => { live = false; stop(); };
  }, [sessionId]);

  if (error) return <p className="m-auto text-[13px] text-text-secondary" role="alert">{error}</p>;
  if (!overview) return <p className="m-auto text-[13px] text-text-tertiary" role="status">Reading the Session…</p>;
  const panes = overview.panes.filter(pane => !pane.archived && !pane.missing);
  const finished = panes.flatMap(pane => pane.panels.flatMap(panel => panel.report?.state === 'done' && panel.state !== 'working'
    ? [{ id: panel.panelId, label: `${panel.title} · ${pane.name}`, at: panel.report.reportedAt }]
    : []));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4" data-testid="autopilot-session-overview">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Panes</h3>
        {panes.length === 0 ? <p className="text-[13px] text-text-tertiary">No Panes in this Session.</p> : (
          <ul className="divide-y divide-border-primary rounded-xl ring-1 ring-border-secondary">
            {panes.map((pane) => {
              const line = paneLine(pane);
              return (
                <li key={pane.paneId} className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px]">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[line.tone])} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-text-primary">{pane.name}</span>
                  <span className="max-w-[55%] shrink-0 truncate text-[12px] text-text-tertiary">{line.text}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {finished.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Finished tabs</h3>
          <ul className="divide-y divide-border-primary rounded-xl ring-1 ring-border-secondary">
            {finished.map(tab => (
              <li key={tab.id} className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px]">
                <Terminal className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-text-primary">{tab.label}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-text-tertiary">reported done {relativeAge(Date.parse(tab.at), now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
