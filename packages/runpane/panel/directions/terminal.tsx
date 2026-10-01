import type { Agent } from '../model';
import { BranchIcon, MetaLine, PrBadge, StatusDot, StatusWord, Terminal } from '../primitives';
import { CardSkeleton } from './sidebar';
import { AgentButtons, Composer, EmptyPanel, ErrorBanner, liveCount, NoticeLine } from './shared';
import type { CardProps, PanelProps } from './types';

// Direction C: terminal first. Agents are tabs, like Pane's panel tab strip, over a live screen.

function Tab({ agent, selected, onSelect }: { agent: Agent; selected: boolean; onSelect?: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={selected} className={`tab ${selected ? 'tab-selected' : ''}`} onClick={onSelect} tabIndex={onSelect ? 0 : -1}>
      <StatusDot status={agent.status} />
      <span className="tab-name">{agent.name}</span>
    </button>
  );
}

function Window({ agent, children, tabs }: { agent: Agent; children: React.ReactNode; tabs: React.ReactNode }) {
  return (
    <div className={`window window-${agent.status}`}>
      <div className="tabstrip" role="tablist">{tabs}</div>
      <div className="window-meta">
        <BranchIcon agent={agent} />
        <span className="window-meta-title">{agent.pr?.title ? `#${agent.pr.number} ${agent.pr.title}` : agent.repo ?? 'pane'}</span>
        <PrBadge agent={agent} />
        <MetaLine agent={agent} showRepo={Boolean(agent.pr?.title)} />
      </div>
      {children}
    </div>
  );
}

export function Card({ data, failed, actions }: CardProps) {
  if (!data) return <div className="card card-c"><CardSkeleton failed={failed} /></div>;
  const { agent } = data;
  return (
    <article className="card card-c">
      {data.error && <ErrorBanner text={data.error} />}
      <Window agent={agent} tabs={<Tab agent={agent} selected />}>
        <Terminal agent={agent} lines={5} header={false} />
      </Window>
      <div className="card-c-foot">
        <StatusWord status={agent.status} />
        <AgentButtons agent={agent} actions={actions} />
      </div>
      <NoticeLine agent={agent} actions={actions} />
    </article>
  );
}

export function Panel({ data, selected, onSelect, actions }: PanelProps) {
  const agents = [...data.agents].reverse();
  const current = agents.find((agent) => agent.paneId === selected) ?? agents[0];
  return (
    <main className="panel panel-c">
      <header className="panel-header">
        <h1>Chat agents</h1>
        <span className="faint">{liveCount(data.agents)}</span>
      </header>
      {data.error && <ErrorBanner text={data.error} />}
      {!current ? <EmptyPanel /> : (
        <>
          <Window
            agent={current}
            tabs={agents.map((agent) => <Tab key={agent.paneId} agent={agent} selected={agent.paneId === current.paneId} onSelect={() => onSelect(agent.paneId)} />)}
          >
            <Terminal agent={current} header={false} />
            <Composer agent={current} actions={actions} prompt />
          </Window>
          <div className="card-c-foot">
            <StatusWord status={current.status} />
            <AgentButtons agent={current} actions={actions} primaryOpen={false} />
          </div>
          <NoticeLine agent={current} actions={actions} />
        </>
      )}
    </main>
  );
}
