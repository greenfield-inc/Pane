import type { PanelLayoutNode, SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';
import { TerminalSkeleton } from './panels/TerminalSkeleton';
import { TabStripSkeleton } from './panels/TabStripSkeleton';
import { Bone, LoadingStatus, QuietSkeletons, Skeleton, TextBone } from './ui/Skeleton';
import { wasTerminalRevealed } from '../utils/revealedTerminals';
import { cn } from '../utils/cn';

/**
 * A Session's workspace while it opens, laid out like SessionWorkspacePanels:
 * the tab row, the stage, and the collapsed Terminal bar. A Session shown
 * before in this window draws its saved split layout, one tab strip per group,
 * and the screen each terminal last showed. Every step of opening (the
 * Session's record, its layout, the terminal itself) draws this same shape, so
 * the screen only changes when the real content arrives.
 */
export function SessionWorkspaceSkeleton({ name, tabTitle, agentPanelId, chain, layout, panels = [], chromeInline = false }: {
  /** For screen readers: what is opening. */
  name: string;
  /** The agent tab's title, which sizes its bone. */
  tabTitle: string;
  /** The agent's terminal panel, whose last screen shapes the skeleton. */
  agentPanelId?: string;
  /** The Session's internal session id: every step of opening it shares one skeleton clock. */
  chain?: string;
  /** The Session's layout from an earlier visit, when this window has it. */
  layout?: SessionPanelLayout;
  /** The Session's tabs from an earlier visit, for the layout's tab titles. */
  panels?: readonly ToolPanel[];
  /** Tiled or inline: the tab row stays even when split (it holds the Session's controls). */
  chromeInline?: boolean;
}) {
  const split = layout?.root.type === 'split';
  // A Session whose terminal this window showed before is cached content: no bones.
  const quiet = Boolean(agentPanelId && wasTerminalRevealed(agentPanelId));
  return (
    <QuietSkeletons quiet={quiet}>
    <div data-testid="session-workspace-skeleton" className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      <LoadingStatus label={`Opening ${name}`} />
      {/* A split Session's tabs live in its groups' strips; the row stays only for tiled controls. */}
      {(!split || chromeInline) && <TabStripSkeleton titles={split ? [] : [tabTitle]} addButton={!split} chain={chain} />}
      <div className="relative flex min-h-0 flex-1">
        <SessionStageSkeleton layout={layout} panels={panels} agentPanelId={agentPanelId} chain={chain} />
      </div>
      <div className="flex h-8 flex-shrink-0 flex-col border-t border-border-primary">
        <Skeleton chain={chain} className="flex h-8 flex-shrink-0 items-center gap-2 px-3 text-[11px] font-medium uppercase leading-none tracking-wider">
          <Bone className="h-3.5 w-3.5" />
          <Bone className="h-3.5 w-3.5" />
          <TextBone text="Terminal" />
        </Skeleton>
      </div>
    </div>
    </QuietSkeletons>
  );
}

/**
 * The stage under the tab row: the saved split layout when there is one, else
 * the agent's terminal. SessionWorkspacePanels also draws it while its split
 * layout measures itself.
 */
export function SessionStageSkeleton({ layout, panels = [], agentPanelId, chain }: {
  layout?: SessionPanelLayout;
  panels?: readonly ToolPanel[];
  agentPanelId?: string;
  chain?: string;
}) {
  if (layout?.root.type === 'split') {
    const titleOf = (id: string) => panels.find(panel => panel.id === id)?.title;
    return <LayoutNodeSkeleton node={layout.root} titleOf={titleOf} panels={panels} chain={chain} />;
  }
  return <div className="relative min-h-0 flex-1 bg-[var(--color-terminal-bg)]"><TerminalSkeleton panelId={agentPanelId} chain={chain} /></div>;
}

/** SplitLayout's tree: rows or columns at their saved proportions, each group with its own tab strip. */
function LayoutNodeSkeleton({ node, titleOf, panels, chain }: {
  node: PanelLayoutNode;
  titleOf: (id: string) => string | undefined;
  panels: readonly ToolPanel[];
  chain?: string;
}) {
  if (node.type === 'group') {
    const titles = node.panelIds.map(titleOf).filter((title): title is string => !!title);
    const active = panels.find(panel => panel.id === node.activePanelId);
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabStripSkeleton titles={titles} chain={chain} />
        {active?.type === 'terminal'
          ? <div className="relative min-h-0 flex-1 bg-[var(--color-terminal-bg)]"><TerminalSkeleton panelId={active.id} chain={chain} /></div>
          : <div className="min-h-0 flex-1 bg-bg-editor" />}
      </div>
    );
  }
  const total = node.sizes.reduce((sum, size) => sum + size, 0) || node.children.length;
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1', node.direction === 'column' ? 'flex-col' : 'flex-row')}>
      {node.children.map((child, index) => (
        <div key={child.id} className={cn('flex min-h-0 min-w-0', index > 0 && (node.direction === 'column' ? 'border-t border-border-primary' : 'border-l border-border-primary'))}
          style={{ flex: `${(node.sizes[index] ?? total / node.children.length) / total} 1 0` }}>
          <LayoutNodeSkeleton node={child} titleOf={titleOf} panels={panels} chain={chain} />
        </div>
      ))}
    </div>
  );
}
