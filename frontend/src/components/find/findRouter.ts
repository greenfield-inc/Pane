/**
 * Decides which tab Cmd/Ctrl+F, Cmd/Ctrl+G and Shift+Cmd/Ctrl+G act on, and
 * registers those keys in the hotkey registry (so Help lists them and the
 * keyboard-shortcuts setting turns them off).
 */
import { useEffect } from 'react';
import { useHotkey } from '../../hooks/useHotkey';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { getFindBar, getFindTarget, getFindTargets, openFind, stepFind } from './findController';

export interface FindRouteInput<N> {
  /** The element with keyboard focus; null when focus is on the page body. */
  active: N | null;
  /** Focus is in a text field, editor or embedded page. */
  activeIsEditable: boolean;
  /** Focus is in a widget with its own Cmd+F (Monaco, the Files tree filter). */
  activeOwnsFind: boolean;
  targets: Array<{ id: string; root: { contains(other: N): boolean } | null; visible: boolean }>;
  /** The searchable tab last clicked or focused, if any. */
  lastInteractedId: string | null;
  /** The focused group's active tab. */
  fallbackId: string | null;
}

export function resolveFindPanelId<N>(input: FindRouteInput<N>): string | null {
  if (input.activeOwnsFind) return null;
  const shown = input.targets.filter(target => target.visible && target.root);
  const active = input.active;
  if (active !== null) {
    const holder = shown.find(target => target.root?.contains(active));
    if (holder) return holder.id;
    // A text field outside every searchable tab (Files filter, Notes) keeps its keys.
    if (input.activeIsEditable) return null;
  }
  const isShown = (id: string | null) => id !== null && shown.some(target => target.id === id);
  if (isShown(input.lastInteractedId)) return input.lastInteractedId;
  if (isShown(input.fallbackId)) return input.fallbackId;
  return null;
}

let lastInteractedId: string | null = null;

function targetIdContaining(node: EventTarget | null): string | null {
  if (!(node instanceof Node)) return null;
  for (const [id, target] of getFindTargets()) {
    if (target.root()?.contains(node)) return id;
  }
  return null;
}

function isEditable(element: Element): boolean {
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'WEBVIEW', 'IFRAME'].includes(element.tagName);
}

function isShownElement(element: Element | null): boolean {
  return !!element && element.isConnected && element.getClientRects().length > 0;
}

function focusedGroupActivePanelId(): string | null {
  const sessionId = useSessionStore.getState().activeSessionId;
  if (!sessionId) return null;
  return usePanelStore.getState().activePanels[sessionId] ?? null;
}

/** The tab Pane's find acts on right now, or null to leave the keys alone. */
function resolveFocusedFindPanelId(): string | null {
  const activeElement = document.activeElement;
  const active = activeElement && activeElement !== document.body && activeElement !== document.documentElement
    ? activeElement
    : null;
  const id = resolveFindPanelId<Node>({
    active,
    activeIsEditable: active ? isEditable(active) : false,
    // Monaco has its own find; the Files tree uses Cmd/Ctrl+F as its filter.
    activeOwnsFind: !!active?.closest('.monaco-editor, [data-native-find]'),
    targets: Array.from(getFindTargets(), ([targetId, target]) => {
      const root = target.root();
      return { id: targetId, root, visible: isShownElement(root) };
    }),
    lastInteractedId,
    fallbackId: focusedGroupActivePanelId(),
  });
  if (!id) return null;
  return getFindTarget(id)?.adapter.mode() === 'native' ? null : id;
}

/** Cmd/Ctrl+G applies when the focused tab's bar is open or remembers a query. */
function canStep(): boolean {
  const id = resolveFocusedFindPanelId();
  if (!id) return false;
  const bar = getFindBar(id);
  return bar.open || bar.query !== '';
}

/** Mount once, at the app root. */
export function useFindHotkeys(): void {
  useEffect(() => {
    const remember = (event: Event) => {
      lastInteractedId = targetIdContaining(event.target);
    };
    window.addEventListener('pointerdown', remember, true);
    window.addEventListener('focusin', remember, true);
    return () => {
      window.removeEventListener('pointerdown', remember, true);
      window.removeEventListener('focusin', remember, true);
    };
  }, []);

  useHotkey({
    id: 'find-in-tab',
    label: 'Find',
    category: 'view',
    enabled: () => resolveFocusedFindPanelId() !== null,
    action: () => {
      const id = resolveFocusedFindPanelId();
      if (id) openFind(id);
    },
  });

  useHotkey({
    id: 'find-next',
    label: 'Find Next',
    category: 'view',
    enabled: canStep,
    action: () => {
      const id = resolveFocusedFindPanelId();
      if (id) stepFind(id, 'next');
    },
  });

  useHotkey({
    id: 'find-previous',
    label: 'Find Previous',
    category: 'view',
    enabled: canStep,
    action: () => {
      const id = resolveFocusedFindPanelId();
      if (id) stepFind(id, 'prev');
    },
  });
}
