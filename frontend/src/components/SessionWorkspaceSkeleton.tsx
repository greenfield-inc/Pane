import { TerminalSkeleton } from './panels/TerminalSkeleton';
import { TabStripSkeleton } from './panels/TabStripSkeleton';
import { Bone, Skeleton, TextBone, LoadingStatus } from './ui/Skeleton';

/**
 * A Session's workspace while it opens, laid out exactly like
 * SessionWorkspacePanels with one tab: the tab row, the agent's terminal, and
 * the collapsed Terminal bar. Every step of opening (the Session's record, its
 * saved layout, the terminal itself) draws this same shape, so the screen only
 * changes when the real content arrives.
 */
export function SessionWorkspaceSkeleton({ name, tabTitle, agentPanelId }: {
  /** For screen readers: what is opening. */
  name: string;
  /** The agent tab's title, which sizes its bone. */
  tabTitle: string;
  /** The agent's terminal panel, whose last screen shapes the skeleton. */
  agentPanelId?: string;
}) {
  return (
    <div data-testid="session-workspace-skeleton" className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      <LoadingStatus label={`Opening ${name}`} />
      <TabStripSkeleton titles={[tabTitle]} />
      <div className="relative min-h-0 flex-1 bg-[var(--color-terminal-bg)]">
        <TerminalSkeleton panelId={agentPanelId} />
      </div>
      <div className="flex h-8 flex-shrink-0 flex-col border-t border-border-primary">
        <Skeleton className="flex h-8 flex-shrink-0 items-center gap-2 px-3 text-[11px] font-medium uppercase leading-none tracking-wider">
          <Bone className="h-3.5 w-3.5" />
          <Bone className="h-3.5 w-3.5" />
          <TextBone text="Terminal" />
        </Skeleton>
      </div>
    </div>
  );
}
