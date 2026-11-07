import { useEffect } from 'react';
import { MessageSquare, Navigation } from 'lucide-react';
import { cn } from '../../utils/cn';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { openOnStack, selectAutopilotStack, useAutopilotStore, useRenderedItems } from '../../stores/autopilotStore';
import { AutopilotDecisionCard } from './AutopilotDecisionCard';
import { groupItemRows } from './autopilotFormat';
import { parseItemIds } from '../../../../shared/autopilotTranscript';

function useRegister(ids: string[]) {
  const key = ids.join('\n');
  useEffect(() => {
    const list = key ? key.split('\n') : [];
    useRenderedItems.setState((state) => {
      const counts = { ...state.counts };
      for (const id of list) counts[id] = (counts[id] ?? 0) + 1;
      return { counts };
    });
    return () => useRenderedItems.setState((state) => {
      const counts = { ...state.counts };
      for (const id of list) { counts[id] = (counts[id] ?? 1) - 1; if (counts[id] <= 0) delete counts[id]; }
      return { counts };
    });
  }, [key]);
}

/**
 * An `autopilot-items` block in Autopilot's chat (d1, D-91): the items it names, grouped by
 * Session, as decision cards. The current one (on the stack) shows in full and answers; the others
 * are one line until clicked, which makes them current.
 */
export function AutopilotItemRows({ content }: { content: string }) {
  const items = useNotifyStore(selectNotifyItems);
  const stack = useAutopilotStore(selectAutopilotStack);
  const ids = parseItemIds(content);
  useRegister(ids);
  const groups = groupItemRows(ids, items, stack);
  if (groups.length === 0) return null;
  return (
    <div className="my-2 flex flex-col gap-2" data-testid="autopilot-items">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1.5">
          <div className={cn('flex items-center gap-2 px-1 text-[12.5px] font-medium', group.autopilot ? 'text-autopilot-on-tint' : 'text-text-secondary')}>
            {group.autopilot ? <Navigation className="h-3.5 w-3.5 text-autopilot" aria-hidden="true" /> : <MessageSquare className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />}
            <span className="min-w-0 truncate">{group.label}</span>
            {group.machine && <span className="rounded bg-surface-tertiary px-1.5 font-mono text-[11px]">{group.machine}</span>}
            <span className="ml-auto tabular-nums text-text-tertiary">{group.rows.length}</span>
          </div>
          {group.rows.map((row) => row.item
            ? <AutopilotDecisionCard key={row.id} item={row.item} current={row.state === 'shown'} onMakeCurrent={() => openOnStack(row.id)} />
            : <p key={row.id} className="px-1 text-[12.5px] text-text-tertiary" data-testid="autopilot-decision" data-state="gone">An earlier item, no longer waiting.</p>)}
        </div>
      ))}
    </div>
  );
}
