import type { Agent } from '../model';
import { BranchIcon, DiffStat, PrBadge, StatusDot, StatusWord, Terminal } from '../primitives';
import { CardSkeleton } from './sidebar';
import { AgentButtons, Composer, EmptyPanel, ErrorBanner, liveCount, NoticeLine } from './shared';
import type { CardProps, PanelProps } from './types';

// Direction B: one Pane card per agent. The panel sorts them by what needs the user first.

function PaneCard({ agent, actions, selected, compact = false }: { agent: Agent; actions: CardProps['actions']; selected?: boolean; compact?: boolean }) {
  return (
    <article className={`card card-b card-b-${agent.status} ${selected ? 'card-selected' : ''}`}>
      <div className="card-b-head">
        <span className={`chip chip-${agent.status}`}><StatusDot status={agent.status} /><StatusWord status={agent.status} /></span>
        <PrBadge agent={agent} />
      </div>
      <h3 className="card-b-title">{agent.name}</h3>
      <div className="card-b-sub">
        <BranchIcon agent={agent} />
        <span>{agent.pr?.title ? `#${agent.pr.number} ${agent.pr.title}` : agent.repo ?? 'pane'}</span>
        <DiffStat agent={agent} />
      </div>
      <Terminal agent={agent} lines={compact ? 4 : 6} header={!compact} />
      {!compact && agent.status !== 'gone' && <Composer agent={agent} actions={actions} />}
      <AgentButtons agent={agent} actions={actions} primaryOpen={compact} />
      <NoticeLine agent={agent} actions={actions} />
    </article>
  );
}

export function Card({ data, failed, actions }: CardProps) {
  if (!data) return <div className="card card-b"><CardSkeleton failed={failed} /></div>;
  return (
    <>
      {data.error && <ErrorBanner text={data.error} />}
      <PaneCard agent={data.agent} actions={actions} compact />
    </>
  );
}

const GROUPS: { title: string; statuses: Agent['status'][] }[] = [
  { title: 'needs you', statuses: ['blocked'] },
  { title: 'working', statuses: ['working', 'unknown'] },
  { title: 'done', statuses: ['ready', 'idle', 'exited', 'gone'] },
];

export function Panel({ data, selected, actions }: PanelProps) {
  return (
    <main className="panel panel-b">
      <header className="panel-header">
        <h1>Chat agents</h1>
        <span className="faint">{liveCount(data.agents)}</span>
      </header>
      {data.error && <ErrorBanner text={data.error} />}
      {data.agents.length === 0 ? <EmptyPanel /> : GROUPS.map(({ title, statuses }) => {
        const agents = [...data.agents].reverse().filter((agent) => statuses.includes(agent.status));
        if (agents.length === 0) return null;
        return (
          <section key={title} className="group">
            <h2 className="repo-label">{title} <span className="faint">{agents.length}</span></h2>
            <div className="card-grid">
              {agents.map((agent) => <PaneCard key={agent.paneId} agent={agent} actions={actions} selected={agent.paneId === selected} />)}
            </div>
          </section>
        );
      })}
    </main>
  );
}
