import type { CSSProperties, Ref } from 'react';
import { TerminalSkeleton } from './panels/TerminalSkeleton';
import { Bone, Skeleton, TextBone, LoadingStatus } from './ui/Skeleton';

const INSPECTOR_TABS = ['Details', 'Files', 'Changes'] as const;

/**
 * A Pane's workspace while it opens, in SessionView's layout and at the sizes
 * it will open at: the tab bar, the active tab's terminal, the Terminal dock
 * and the inspector, or the swapped layout's terminal rail and bottom inspector.
 */
export function PaneWorkspaceSkeleton({ name, swapped, dockHeight, inspectorWidth, railWidth, bottomInspectorHeight, contentRef, centerRef, chain }: {
  /** For screen readers: what is opening. */
  name: string;
  swapped: boolean;
  /** The Terminal dock's height (32 when collapsed, 0 when hidden). */
  dockHeight: number;
  /** The inspector's width; 0 while it is hidden. */
  inspectorWidth: number;
  /** Swapped layout: the terminal rail's width. */
  railWidth: number;
  /** Swapped layout: the bottom inspector's height. */
  bottomInspectorHeight: number;
  /** SessionView's measured boxes, which size the dock and inspector as they will open. */
  contentRef: Ref<HTMLDivElement>;
  centerRef: Ref<HTMLDivElement>;
  /** The Pane's id: every step of opening it shares one skeleton clock. */
  chain: string;
}) {
  const stage = (
    <div className="relative min-h-0 flex-1 bg-[var(--color-terminal-bg)]">
      <TerminalSkeleton chain={chain} />
    </div>
  );
  return (
    <div data-testid="pane-workspace-skeleton" className="flex flex-1 flex-col overflow-hidden bg-bg-primary">
      <LoadingStatus label={`Opening ${name}`} />
      <Skeleton chain={chain} className="flex min-h-[39px] flex-shrink-0 items-center border-b border-border-primary bg-bg-chrome pr-2">
        <div className="inline-flex h-[38px] min-w-[8rem] items-center gap-2 px-3 text-sm leading-none">
          <span className="inline-flex h-3 w-3 items-center justify-center"><Bone className="h-2 w-2 rounded-full" /></span>
          <Bone className="h-4 w-4" />
          <Bone className="h-3.5 w-48" />
        </div>
        <span className="ml-0.5 inline-flex h-7 w-7 items-center justify-center"><Bone className="h-4 w-4" /></span>
      </Skeleton>
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-row">
        <div ref={centerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {stage}
          {swapped
            ? bottomInspectorHeight > 0 && <InspectorSkeleton chain={chain} className="border-t" style={{ height: bottomInspectorHeight }} />
            : dockHeight > 0 && <DockSkeleton height={dockHeight} chain={chain} />}
        </div>
        {swapped
          ? railWidth > 0 && (
            <div className="flex flex-shrink-0 flex-col border-l border-border-primary" style={{ width: railWidth }}>
              <TerminalHeaderSkeleton chain={chain} />
              <div className="relative min-h-0 flex-1 bg-[var(--color-terminal-bg)]"><TerminalSkeleton chain={chain} /></div>
            </div>
          )
          : inspectorWidth > 0 && <InspectorSkeleton chain={chain} className="border-l" style={{ width: inspectorWidth }} />}
      </div>
    </div>
  );
}

function TerminalHeaderSkeleton({ chain }: { chain: string }) {
  return (
    <Skeleton chain={chain} className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-border-primary bg-surface-primary px-3 text-[11px] font-medium uppercase leading-none tracking-wider">
      <Bone className="h-3.5 w-3.5" />
      <Bone className="h-3.5 w-3.5" />
      <TextBone text="Terminal" />
    </Skeleton>
  );
}

function DockSkeleton({ height, chain }: { height: number; chain: string }) {
  return (
    <div className="flex flex-shrink-0 flex-col border-t border-border-primary" style={{ height }}>
      <TerminalHeaderSkeleton chain={chain} />
      {height > 32 && <div className="relative min-h-0 flex-1 bg-[var(--color-terminal-bg)]"><TerminalSkeleton chain={chain} /></div>}
    </div>
  );
}

function InspectorSkeleton({ className, style, chain }: { className: string; style: CSSProperties; chain: string }) {
  return (
    <div className={`flex flex-shrink-0 flex-col border-border-primary bg-surface-primary ${className}`} style={style}>
      <Skeleton chain={chain} className="flex h-8 flex-shrink-0 items-stretch border-b border-border-primary bg-surface-secondary px-1 text-[12px] font-medium leading-none">
        {INSPECTOR_TABS.map(tab => (
          <span key={tab} className="flex flex-1 items-center justify-center"><TextBone text={tab} /></span>
        ))}
      </Skeleton>
      <Skeleton chain={chain} className="flex flex-col">
        <div className="flex h-10 items-center gap-2 border-b border-border-primary px-3">
          <Bone className="h-3.5 w-3.5" />
          <Bone className="h-3.5 w-28" />
        </div>
        <div className="flex h-9 items-center gap-2 border-b border-border-primary px-3">
          <Bone className="h-3.5 w-40" />
        </div>
      </Skeleton>
    </div>
  );
}
