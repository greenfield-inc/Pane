import { ArrowUpRight } from 'lucide-react';
import type { Agent } from '../model';
import { AccentBar, BranchIcon, MetaLine, PrBadge, StatusDot, StatusWord, Terminal } from '../primitives';
import { AgentButtons, Composer, EmptyPanel, ErrorBanner, liveCount, NoticeLine } from './shared';
import type { CardProps, PanelProps } from './types';

// Direction A: Pane's vertical sidebar. Rows grouped under their repo, the selected Pane in detail.

function Row({ agent, selected, onSelect }: { agent: Agent; selected?: boolean; onSelect?: () => void }) {
  const title = agent.pr?.title ?? agent.name;
  const body = (
    <>
      <AccentBar status={agent.status} />
      <BranchIcon agent={agent} />
      <span className="row-text">
        <span className={`row-title ${agent.status === 'working' ? 'shimmer' : ''} ${agent.status === 'ready' ? 'unseen' : ''}`}>{title}</span>
        <MetaLine agent={agent} showRepo={false} />
      </span>
      <StatusDot status={agent.status} />
    </>
  );
  return onSelect
    ? <button type="button" className={`row ${selected ? 'row-selected' : ''}`} onClick={onSelect} aria-current={selected ? 'true' : undefined}>{body}</button>
    : <div className="row">{body}</div>;
}

export function Card({ data, failed, actions }: CardProps) {
  if (!data) return <div className="card card-a"><CardSkeleton failed={failed} /></div>;
  const { agent } = data;
  return (
    <article className="card card-a">
      {data.error && <ErrorBanner text={data.error} />}
      <div className="card-a-head">
        <span className="repo-label">{agent.repo ?? 'pane'}</span>
        <StatusWord status={agent.status} />
      </div>
      <Row agent={agent} />
      <Terminal agent={agent} lines={3} header={false} />
      <AgentButtons agent={agent} actions={actions} />
      <NoticeLine agent={agent} actions={actions} />
    </article>
  );
}

export function CardSkeleton({ failed }: { failed?: string }) {
  if (failed) return <ErrorBanner text={failed} />;
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading agent">
      <span className="skeleton-line wide" />
      <span className="skeleton-line" />
      <span className="skeleton-block" />
    </div>
  );
}

export function Panel({ data, selected, onSelect, actions }: PanelProps) {
  const groups = new Map<string, Agent[]>();
  for (const agent of [...data.agents].reverse()) groups.set(agent.repo ?? 'pane', [...(groups.get(agent.repo ?? 'pane') ?? []), agent]);
  const current = data.agents.find((agent) => agent.paneId === selected) ?? data.agents.at(-1);
  return (
    <main className="panel panel-a">
      <header className="panel-header">
        <h1>Chat agents</h1>
        <span className="faint">{liveCount(data.agents)}</span>
      </header>
      {data.error && <ErrorBanner text={data.error} />}
      {data.agents.length === 0 ? <EmptyPanel /> : (
        <div className="split">
          <nav className="sidebar" aria-label="Agents">
            {[...groups].map(([repo, agents]) => (
              <section key={repo}>
                <h2 className="repo-label">{repo}</h2>
                {agents.map((agent) => (
                  <Row key={agent.paneId} agent={agent} selected={agent.paneId === current?.paneId} onSelect={() => onSelect(agent.paneId)} />
                ))}
              </section>
            ))}
          </nav>
          {current && (
            <section className="detail" aria-label={current.name}>
              <div className="detail-head">
                <StatusDot status={current.status} />
                <h2>{current.name}</h2>
                <StatusWord status={current.status} />
                <PrBadge agent={current} />
              </div>
              {current.pr?.title && (
                <button type="button" className="pr-title" onClick={() => actions.openPr(current)} disabled={!current.pr.url}>
                  <BranchIcon agent={current} />
                  <span>#{current.pr.number} {current.pr.title}</span>
                  <ArrowUpRight className="icon faint" aria-hidden="true" />
                </button>
              )}
              <Terminal agent={current} />
              <Composer agent={current} actions={actions} />
              <div className="detail-foot">
                <AgentButtons agent={current} actions={actions} primaryOpen={false} />
                <MetaLine agent={current} />
              </div>
              <NoticeLine agent={current} actions={actions} />
            </section>
          )}
        </div>
      )}
    </main>
  );
}
