import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cn } from '../utils/cn';
import { dropOrder, stepOrder, type SessionDropTarget } from '../utils/sessionReorder';

/** A drag of a sidebar row being reordered; its own type, so tiles and tabs never take it. */
const ROW_DRAG_MIME = 'application/x-pane-sidebar-row';

/** One list a row can move within, such as a project's Panes; pinned rows can be a list of their own. */
export interface ReorderList {
  id: string;
  keys: string[];
  /** Saves the list's keys in their new order. */
  save: (order: string[]) => void;
}

/** What a row needs to move within its list: drag source and target, the drop line, and Alt+Up/Down. */
export interface RowReorder {
  drag: {
    draggable: true;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  indicator: SessionDropTarget['edge'] | null;
}

/** A drop in the top half of a row lands before it, else after. */
function dropEdge(event: { clientY: number; currentTarget: Element }): SessionDropTarget['edge'] {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

/** The line a drop would land on, drawn over the row's edge so nothing shifts. */
export function DropLine({ edge }: { edge: SessionDropTarget['edge'] | null }) {
  if (!edge) return null;
  return <div aria-hidden className={cn('pointer-events-none absolute inset-x-3 z-20 h-0.5 rounded-full bg-interactive', edge === 'before' ? '-top-px' : '-bottom-px')} />;
}

/**
 * Drag and Alt+Up/Down for sidebar rows. A drag moves a row only within the list it started in;
 * a keyboard move refocuses the row once it is drawn in its new place. Rows carry `data-row-key`,
 * and the control to refocus inside them `data-row-open`.
 */
export function useRowReorder(announce: (message: string) => void) {
  const origin = useRef<{ list: string; key: string } | null>(null);
  const [drop, setDrop] = useState<{ list: string; key: string; edge: SessionDropTarget['edge'] } | null>(null);
  const focusAfterMove = useRef<string | null>(null);

  useEffect(() => {
    const key = focusAfterMove.current;
    if (!key) return;
    focusAfterMove.current = null;
    const row = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"] [data-row-open]`);
    if (row && document.activeElement !== row) row.focus();
  });

  const move = (list: ReorderList, key: string, label: string, order: string[] | null) => {
    if (!order) return;
    list.save(order);
    announce(`Moved ${label} to position ${order.indexOf(key) + 1} of ${order.length}`);
  };

  return (list: ReorderList, key: string, label: string): RowReorder => {
    const fromThisList = () => (origin.current?.list === list.id && origin.current.key !== key ? origin.current : null);
    return {
      drag: {
        draggable: true,
        onDragStart: (event) => {
          event.dataTransfer.setData(ROW_DRAG_MIME, key);
          event.dataTransfer.setData('text/plain', label);
          event.dataTransfer.effectAllowed = 'move';
          origin.current = { list: list.id, key };
        },
        onDragEnd: () => {
          origin.current = null;
          setDrop(null);
        },
        onDragOver: (event) => {
          if (!fromThisList()) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const edge = dropEdge(event);
          if (drop?.list !== list.id || drop.key !== key || drop.edge !== edge) setDrop({ list: list.id, key, edge });
        },
        onDragLeave: (event) => {
          const into = event.relatedTarget;
          if (into instanceof Node && event.currentTarget.contains(into)) return;
          if (drop?.list === list.id && drop.key === key) setDrop(null);
        },
        onDrop: (event) => {
          const from = fromThisList();
          if (!from) return;
          event.preventDefault();
          origin.current = null;
          setDrop(null);
          move(list, from.key, event.dataTransfer.getData('text/plain') || label, dropOrder(list.keys, from.key, { targetId: key, edge: dropEdge(event) }));
        },
      },
      onKeyDown: (event) => {
        if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        event.stopPropagation();
        const order = stepOrder(list.keys, key, event.key === 'ArrowUp' ? -1 : 1);
        if (order) focusAfterMove.current = key;
        move(list, key, label, order);
      },
      indicator: drop?.list === list.id && drop.key === key ? drop.edge : null,
    };
  };
}

