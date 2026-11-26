import { pickInDirection, type Rect } from '@shared/controller/geometry';
import type { Direction } from '@shared/controller/types';

export type { Direction, Rect };

/**
 * Which control the controller's focus ring is on. Controls opt in with a
 * way to measure their frame on screen and what A does on them. Sheets and
 * screens open focus scopes; only the newest scope's controls take focus. A
 * move asks the shared direction function for the nearest control in that
 * direction; when none is there, the focused control's list may scroll a step
 * (`onEdge`), and the caller moves again once the new rows are mounted.
 */

interface FocusItem {
  id: string;
  scope: string;
  measure(): Rect | null;
  activate(): void;
  /** Where focus lands when its scope opens (the recommended option). */
  preferred?: boolean;
  /** The screen context while this control has focus: a terminal makes the D-pad arrow keys. */
  context?: string;
  /** Scrolls the control's list toward `direction`; true when there was more to show. */
  onEdge?(direction: Direction): boolean;
  /** Scrolls the control's list so `rect` is in view. */
  reveal?(rect: Rect): void;
}

interface FocusScope {
  key: string;
}

type MoveResult = 'moved' | 'scrolled' | 'none';

export interface FocusRegistry {
  openScope(scope: FocusScope): () => void;
  add(item: FocusItem): () => void;
  focused(): FocusItem | null;
  /** The newest scope's key: a sheet's controls draw their own ring. */
  activeScope(): string;
  focus(id: string | null): void;
  /** The focused control's frame now, or null. */
  rect(): Rect | null;
  move(direction: Direction): MoveResult;
  /** Runs A on the focused control; false when nothing is focused. */
  activate(): boolean;
  subscribe(listener: () => void): () => void;
}

const ROOT = '';

export function createFocusRegistry(): FocusRegistry {
  const scopes: FocusScope[] = [{ key: ROOT }];
  const items = new Map<string, FocusItem>();
  const listeners = new Set<() => void>();
  let current: string | null = null;

  const notify = () => listeners.forEach(listener => listener());
  const activeScope = () => scopes.at(-1)!;
  const inScope = () => [...items.values()].filter(item => item.scope === activeScope().key);
  const visible = () => inScope().flatMap(item => {
    const rect = item.measure();
    return rect && rect.width > 0 && rect.height > 0 ? [{ item, rect }] : [];
  });
  const set = (id: string | null) => {
    if (current === id) return;
    current = id;
    notify();
  };
  /** The preferred control in the scope, else the one nearest the top left. */
  const initial = (): string | null => {
    const shown = visible();
    const preferred = shown.find(entry => entry.item.preferred);
    if (preferred) return preferred.item.id;
    shown.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    return shown[0]?.item.id ?? null;
  };
  const reveal = (id: string | null) => {
    const item = id ? items.get(id) : undefined;
    const rect = item?.measure();
    if (item && rect) item.reveal?.(rect);
  };
  const focusedItem = () => (current ? items.get(current) : undefined);
  const valid = () => {
    const item = focusedItem();
    return item && item.scope === activeScope().key ? item : undefined;
  };

  return {
    openScope(scope) {
      scopes.push(scope);
      set(null);
      return () => {
        const index = scopes.indexOf(scope);
        if (index > 0) scopes.splice(index, 1);
        if (focusedItem()?.scope === scope.key) set(null);
      };
    },
    add(item) {
      items.set(item.id, item);
      return () => {
        if (items.get(item.id) !== item) return;
        items.delete(item.id);
        if (current === item.id) set(null);
      };
    },
    focused: () => valid() ?? null,
    activeScope: () => activeScope().key,
    focus: set,
    rect: () => valid()?.measure() ?? null,
    move(direction) {
      const from = valid();
      const fromRect = from?.measure();
      if (!from || !fromRect) {
        const first = initial();
        set(first);
        reveal(first);
        return first ? 'moved' : 'none';
      }
      const candidates = visible().filter(entry => entry.item.id !== from.id).map(entry => ({ id: entry.item.id, rect: entry.rect }));
      const next = pickInDirection(fromRect, candidates, direction);
      if (next !== null) {
        set(next);
        reveal(next);
        return 'moved';
      }
      return from.onEdge?.(direction) ? 'scrolled' : 'none';
    },
    activate() {
      const item = valid();
      if (!item) return false;
      item.activate();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
