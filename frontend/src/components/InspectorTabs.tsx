import { useRef } from 'react';
import type { ToolPanel } from '../../../shared/types/panels';
import { cn } from '../utils/cn';

export type InspectorTab = 'details' | 'files' | 'changes';

interface InspectorTabsProps {
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  filesPanel?: ToolPanel;
  changesPanel?: ToolPanel;
  changesCount?: number;
  className?: string;
}

/**
 * The right inspector's tab strip: Details (branch, actions, history) plus
 * Files and Changes, which host the Explorer and Review panels. Files and
 * Changes only appear once their panel exists for the session.
 */
export function InspectorTabs({ tab, onTabChange, filesPanel, changesPanel, changesCount, className }: InspectorTabsProps) {
  const buttons = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({});
  const tabs: Array<{ id: InspectorTab; label: string; badge?: number }> = [
    { id: 'details', label: 'Details' },
    ...(filesPanel ? [{ id: 'files' as const, label: 'Files' }] : []),
    ...(changesPanel ? [{ id: 'changes' as const, label: 'Changes', badge: changesCount }] : []),
  ];
  return (
    <div role="tablist" aria-label="Inspector" className={cn('flex h-8 flex-shrink-0 items-stretch border-b border-border-primary', className)}>
      {tabs.map(item => {
        const selected = item.id === tab;
        return (
          <button
            key={item.id}
            ref={button => { buttons.current[item.id] = button; }}
            tabIndex={selected ? 0 : -1}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={item.label}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = tabs.findIndex(t => t.id === tab);
              const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              onTabChange(next.id);
              buttons.current[next.id]?.focus();
            }}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 px-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring-subtle',
              selected
                ? 'text-text-primary shadow-[inset_0_-2px_0_0_var(--color-interactive-primary)]'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover',
            )}
          >
            <span>{item.label}</span>
            {!!item.badge && (
              <span aria-hidden="true" className="rounded-full bg-surface-tertiary px-1.5 text-[10px] leading-4 text-text-secondary tabular-nums">{item.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
