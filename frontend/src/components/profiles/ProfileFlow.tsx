import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import type { Profile, ProfileEdgeChooser, ProfileRunEntry } from '../../../../shared/types/profiles';
import { cn } from '../../utils/cn';
import { FLOW_END_ID, layoutProfileFlow, litPath, type FlowEdgeLayout, type FlowNodeLayout } from './profileFlowLayout';

/** Arrow colour by who chose the edge: the agent, you, or a command's exit code. */
const CHOOSER_STROKE = {
  agent: 'stroke-status-info',
  you: 'stroke-status-warning',
  command: 'stroke-text-tertiary',
} satisfies Record<ProfileEdgeChooser, string>;
const CHOOSER_FILL = {
  agent: 'fill-status-info',
  you: 'fill-status-warning',
  command: 'fill-text-tertiary',
} satisfies Record<ProfileEdgeChooser, string>;
const CHOOSER_TEXT = {
  agent: 'text-status-info',
  you: 'text-status-warning',
  command: 'text-text-secondary',
} satisfies Record<ProfileEdgeChooser, string>;

interface OpenSample {
  step: string;
  outcome: string;
  /** In a run: the one sample it shows (1-based); otherwise every sample. */
  only?: number;
}

function hexagon(node: FlowNodeLayout): string {
  const left = node.x - node.width / 2;
  const right = node.x + node.width / 2;
  const top = node.y - node.height / 2;
  const bottom = node.y + node.height / 2;
  const inset = 16;
  return [[left + inset, top], [right - inset, top], [right, node.y], [right - inset, bottom], [left + inset, bottom], [left, node.y]].map((point) => point.join(',')).join(' ');
}

function edgePath(edge: FlowEdgeLayout): string {
  return edge.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
}

function StepNode({ node, faded }: { node: FlowNodeLayout; faded: boolean }) {
  const step = node.step;
  const left = node.x - node.width / 2;
  const top = node.y - node.height / 2;
  if (!step) {
    return (
      <g data-testid="profile-flow-end" className={cn(faded && 'opacity-40')}>
        <rect x={left} y={top} width={node.width} height={node.height} rx={15} className="fill-surface-secondary stroke-status-success" strokeWidth={1.5} />
        <text x={node.x} y={node.y + 4} textAnchor="middle" className="fill-status-success text-[12px] font-medium">end</text>
      </g>
    );
  }
  const subtitle = faded ? 'not used in this run' : step.kind === 'agent' ? step.goal : step.kind === 'ask' ? 'you\'re asked' : '';
  return (
    <g data-testid="profile-flow-step" data-step={step.id} data-kind={step.kind} className={cn(faded && 'opacity-40')}>
      <title>{step.kind === 'agent' ? `${step.agent}: ${step.goal}` : step.kind === 'command' ? step.run : step.ask}</title>
      {step.kind === 'agent' && <rect x={left} y={top} width={node.width} height={node.height} rx={14} className="fill-surface-secondary stroke-status-info" strokeWidth={1.5} />}
      {step.kind === 'command' && <rect x={left} y={top} width={node.width} height={node.height} rx={2} className={cn('fill-surface-primary', step.outcomes.length === 0 ? 'stroke-status-success' : 'stroke-text-secondary')} strokeWidth={1.25} />}
      {step.kind === 'ask' && <polygon points={hexagon(node)} className="fill-surface-secondary stroke-status-warning" strokeWidth={1.5} />}
      {step.kind === 'command' && step.title === step.run && (
        <text x={node.x} y={node.y + 4} textAnchor="middle" className={cn('font-mono text-[12px]', step.outcomes.length === 0 ? 'fill-status-success' : 'fill-text-primary')}>{step.title}</text>
      )}
      {step.kind === 'command' && step.title !== step.run && (
        // A titled command still shows the command it runs.
        <>
          <text x={node.x} y={node.y - 3} textAnchor="middle" className={cn('text-[13px] font-semibold', step.outcomes.length === 0 ? 'fill-status-success' : 'fill-text-primary')}>{step.title}</text>
          <text x={node.x} y={node.y + 14} textAnchor="middle" className="fill-text-secondary font-mono text-[11px]" data-testid="profile-flow-command">{step.run.length > Math.floor(node.width / 6.8) ? `${step.run.slice(0, Math.floor(node.width / 6.8) - 1)}…` : step.run}</text>
        </>
      )}
      {step.kind !== 'command' && (
        <>
          <text x={node.x} y={node.y - 3} textAnchor="middle" className="fill-text-primary text-[13px] font-semibold">{step.kind === 'ask' ? step.ask : step.title}</text>
          <text x={node.x} y={node.y + 14} textAnchor="middle" className="fill-text-secondary text-[11px]">{subtitle.length > Math.floor(node.width / 6.2) ? `${subtitle.slice(0, Math.floor(node.width / 6.2) - 1)}…` : subtitle}</text>
        </>
      )}
    </g>
  );
}

function StoryCards({ profile, entries }: { profile: Profile; entries: readonly ProfileRunEntry[] }) {
  return (
    <ol className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]" data-testid="profile-run-story">
      {entries.map((entry, index) => {
        const step = profile.flow?.steps.find((candidate) => candidate.id === entry.step);
        const sample = entry.took && entry.sample ? profile.samples[entry.step]?.[entry.took]?.[entry.sample - 1] : undefined;
        const tone = step?.kind === 'agent' ? 'border-status-info' : step?.kind === 'ask' ? 'border-status-warning' : 'border-border-primary';
        return (
          <li key={`${entry.step}-${index}`} className={cn('min-w-0 rounded-lg border bg-surface-secondary px-3 py-2', tone)}>
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] tabular-nums text-text-tertiary">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{step?.kind === 'ask' ? step.ask : step?.title ?? entry.step}</span>
              <span className="font-mono text-[11px] text-text-tertiary">{entry.step}</span>
            </div>
            <p className={cn('text-xs', step?.kind === 'ask' ? 'text-status-warning' : step?.kind === 'agent' ? 'text-status-info' : 'text-text-secondary')}>
              {entry.took ?? (entry.answer !== undefined ? 'answered' : 'done')}
            </p>
            {(sample ?? entry.answer) && <p className="mt-1 whitespace-pre-line rounded border border-dashed border-border-primary px-2 py-1 text-xs text-text-secondary">{sample ?? entry.answer}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A profile's workflow drawn from its file, the same way for every profile (D-4): one box per
 * step and one labelled arrow per outcome, choice or next. An example run lights its path over
 * the same boxes; a page icon on an agent outcome opens its samples.
 */
export function ProfileFlow({ profile }: { profile: Profile }) {
  const layout = useMemo(() => layoutProfileFlow(profile), [profile]);
  const runIds = Object.keys(profile.runs);
  const [view, setView] = useState<string>('graph');
  const [open, setOpen] = useState<OpenSample | null>(null);
  const entries = view === 'graph' ? undefined : profile.runs[view];
  const lit = entries ? litPath(entries) : undefined;
  const runSample = (from: string, label: string) => entries?.find((entry) => entry.step === from && entry.took === label && entry.sample)?.sample;
  const samples = open ? profile.samples[open.step]?.[open.outcome] ?? [] : [];

  if (!profile.flow) {
    return <p className="text-sm text-text-secondary" data-testid="profile-flow-team-only">This profile is team only: it has no workflow yet, so there is nothing to draw or launch. Its agents are under Team.</p>;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="profile-flow">
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Example runs" className="inline-flex overflow-hidden rounded-md border border-border-primary">
          {['graph', ...runIds].map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              data-testid={`profile-run-toggle-${id}`}
              onClick={() => { setView(id); setOpen(null); }}
              className={cn('px-3 py-1 text-xs', view === id ? 'bg-surface-selected font-medium text-text-primary' : 'text-text-secondary hover:bg-surface-hover')}
            >
              {id === 'graph' ? 'The graph' : `Example run ${id}`}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-tertiary">{entries ? 'Faded steps are not used in this run; its order is in the cards below.' : 'Same graph every time; only the lit path and the samples change. Click a page icon to see an outcome\'s samples.'}</p>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary" aria-label="Key">
        <li className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-md border border-status-info" />agent step (judgment)</li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 border border-text-secondary" />command (mechanical)</li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 border border-status-warning [clip-path:polygon(20%_0,80%_0,100%_50%,80%_100%,20%_100%,0_50%)] " />you're asked</li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded border border-status-success" />ends the run</li>
        <li>arrow colour = who chose: <span className="text-status-info">agent</span> · <span className="text-status-warning">you</span> · <span className="text-text-secondary">command</span></li>
        <li className="flex items-center gap-1"><FileText className="h-3 w-3" aria-hidden="true" />= samples of what the agent produced</li>
      </ul>
      {/* mx-auto centres a narrow drawing; a wide one starts at the left edge and scrolls, so none of it is out of reach. */}
      <div className="overflow-x-auto rounded-lg border border-border-primary bg-surface-primary" data-testid="profile-flow-scroll">
        <svg className="mx-auto block" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`${profile.name} workflow`} data-testid="profile-flow-svg">
          <defs>
            {(['agent', 'you', 'command'] as const).map((chooser) => (
              <marker key={chooser} id={`profile-arrow-${chooser}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={CHOOSER_FILL[chooser]} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((edge) => {
            const faded = lit !== undefined && !lit.edges.has(edge.key);
            return (
              <g key={edge.key} data-testid="profile-flow-edge" data-from={edge.from} data-to={edge.to === 'end' ? FLOW_END_ID : edge.to} data-label={edge.label} className={cn(faded && 'opacity-25')}>
                <path d={edgePath(edge)} fill="none" className={CHOOSER_STROKE[edge.chooser]} strokeWidth={lit && !faded ? 2.25 : 1.5} markerEnd={`url(#profile-arrow-${edge.chooser})`} />
              </g>
            );
          })}
          {layout.nodes.map((node) => (
            <StepNode key={node.id} node={node} faded={lit !== undefined && node.id !== FLOW_END_ID && !lit.steps.has(node.id)} />
          ))}
          {layout.edges.map((edge) => {
            const faded = lit !== undefined && !lit.edges.has(edge.key);
            const width = edge.label.length * 7.2 + 14;
            return (
              <foreignObject key={`label-${edge.key}`} x={edge.labelX - width / 2 - (edge.hasSamples ? 12 : 0)} y={edge.labelY - 11} width={width + (edge.hasSamples ? 26 : 0)} height={22} className={cn(faded && 'opacity-25')}>
                <div className="flex h-full items-center justify-center gap-1">
                  <span className={cn('whitespace-nowrap rounded-full border border-border-primary bg-surface-primary px-1.5 text-[11px] leading-4', edge.chooser === 'command' && 'font-mono', CHOOSER_TEXT[edge.chooser])}>{edge.label}</span>
                  {edge.hasSamples && (
                    <button
                      type="button"
                      aria-label={`Samples for ${edge.from} › ${edge.label}`}
                      data-testid="profile-sample-button"
                      onClick={() => setOpen({ step: edge.from, outcome: edge.label, only: runSample(edge.from, edge.label) })}
                      className="flex h-4 w-4 items-center justify-center rounded text-status-info hover:bg-surface-hover"
                    >
                      <FileText className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>
      {open && (
        <div role="dialog" aria-label={`Samples for ${open.step} › ${open.outcome}`} data-testid="profile-sample-popover" className="rounded-lg border border-status-info bg-surface-secondary p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-text-primary">{open.step} › <span className="text-status-info">{open.outcome}</span>{open.only ? ` · sample ${open.only} of ${samples.length}` : ` · ${samples.length} samples`}</p>
            <button type="button" onClick={() => setOpen(null)} className="text-xs text-text-secondary hover:text-text-primary">Close</button>
          </div>
          <ul className="flex flex-col gap-2">
            {samples.map((sample, index) => (open.only === undefined || open.only === index + 1) && (
              <li key={index} className="whitespace-pre-line rounded border border-dashed border-border-primary px-2 py-1 text-xs text-text-secondary">{sample}</li>
            ))}
          </ul>
        </div>
      )}
      {entries && <StoryCards profile={profile} entries={entries} />}
    </div>
  );
}

