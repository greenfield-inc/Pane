import { useCallback, useSyncExternalStore } from 'react';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

/**
 * Which agent-message cards the person opened or closed (T-133), by tab and M-n, so a card keeps
 * its state across re-renders, tab switches and reloads. Only the person's choices are kept: a card
 * nobody touched shows its default (own workers' messages collapsed, everyone else's open).
 * Browser storage is a convenience: when it is unavailable, choices last until the window reloads.
 */

const KEY = 'pane.chat.agentMessageOpen';
/** The newest choices kept; older ones fall back to their card's default. */
const LIMIT = 500;

type Choices = Map<string, boolean>;

function storage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

function read(): Choices {
  try {
    const raw = storage()?.getItem(KEY);
    return raw ? new Map(Object.entries(decodeBoundary(JSON.parse(raw), boundary.record(boundary.boolean)))) : new Map();
  } catch { return new Map(); }
}

let choices: Choices | undefined;
const listeners = new Set<() => void>();

function current(): Choices {
  choices ??= read();
  return choices;
}

const keyOf = (panelId: string, ref: string) => `${panelId}:${ref}`;

export function setAgentMessageOpen(panelId: string, ref: string, open: boolean): void {
  const next = new Map(current());
  const key = keyOf(panelId, ref);
  // Re-inserted last, so the newest choices survive the limit.
  next.delete(key);
  next.set(key, open);
  for (const oldest of next.keys()) {
    if (next.size <= LIMIT) break;
    next.delete(oldest);
  }
  choices = next;
  try { storage()?.setItem(KEY, JSON.stringify(Object.fromEntries(next))); } catch { /* kept for this window only */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: forget what was read, so the next read comes from storage again. */
export function resetAgentMessageOpenForTests(): void {
  choices = undefined;
}

/** A card's open state: the person's last choice for it, else `byDefault`; and the setter. */
export function useAgentMessageOpen(panelId: string | undefined, ref: string | undefined, byDefault: boolean): [boolean, (open: boolean) => void] {
  const read = () => (panelId && ref ? current().get(keyOf(panelId, ref)) : undefined);
  const chosen = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((open: boolean) => { if (panelId && ref) setAgentMessageOpen(panelId, ref, open); }, [panelId, ref]);
  return [chosen ?? byDefault, set];
}
