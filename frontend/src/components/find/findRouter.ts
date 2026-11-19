/**
 * Decides which tab Cmd/Ctrl+F, Cmd/Ctrl+G and Shift+Cmd/Ctrl+G act on, and
 * registers those keys in the hotkey registry (so Help lists them and the
 * keyboard-shortcuts setting turns them off).
 */
import { useEffect } from 'react';
import { useHotkey } from '../../hooks/useHotkey';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { getFindBar, getFindTarget, getFindTargets, openFind, refreshFind, stepFind } from './findController';
import { isTypingTarget } from '../../utils/typingTarget';
import { FIND_FRAME_ATTRIBUTE, FIND_WEBVIEW_ATTRIBUTE, markWebviewReady, prepareFindFrame } from './surfaceFind';

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

interface Nested {
  parentNode: Nested | null;
}

/** What the shown check reads of an element (Element itself, or a stand-in in tests). */
interface LaidOut<N> {
  isConnected: boolean;
  getClientRects(): ArrayLike<unknown>;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  contains(other: N): boolean;
}

function depthOf(node: Nested): number {
  let depth = 0;
  for (let parent = node.parentNode; parent; parent = parent.parentNode) depth += 1;
  return depth;
}

/**
 * Nested searchable roots (a chat shown inside an approval column's origin
 * tab) innermost first, so focus inside the inner one routes there.
 */
export function innermostFirst<T extends { root: Nested | null }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index, depth: entry.root ? depthOf(entry.root) : -1 }))
    .sort((a, b) => b.depth - a.depth || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * The root is on screen and not covered by something else: the Session's
 * approval column lies over the right split, whose tab stays laid out
 * underneath and must never take Cmd+F.
 */
export function isFindRootShown<N extends LaidOut<N>>(element: N | null, hit: (x: number, y: number) => N | null): boolean {
  if (!element || !element.isConnected || element.getClientRects().length === 0) return false;
  const rect = element.getBoundingClientRect();
  const top = hit(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!top) return true;
  return element.contains(top) || top.contains(element);
}

const hitTest = (x: number, y: number): Element | null => document.elementFromPoint(x, y);

function targetsInnermostFirst() {
  return innermostFirst(Array.from(getFindTargets(), ([id, target]) => ({ id, target, root: target.root() })));
}

function targetIdContaining(node: EventTarget | null): string | null {
  if (!(node instanceof Node)) return null;
  for (const { id, root } of targetsInnermostFirst()) {
    if (root?.contains(node)) return id;
  }
  return null;
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
    // Embedded pages keep their keys too. A terminal's own textarea counts as a field; the rest of .xterm never did.
    activeIsEditable: isTypingTarget(active, { frames: true, terminals: false }),
    // Monaco has its own find; the Files tree uses Cmd/Ctrl+F as its filter.
    activeOwnsFind: !!active?.closest('.monaco-editor, [data-native-find]'),
    targets: targetsInnermostFirst().map(({ id: targetId, root }) => ({ id: targetId, root, visible: isFindRootShown(root, hitTest) })),
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
    // Summary frames and reference pages load on their own time; an open
    // search runs again on the new page. None of these events bubble, so they
    // are caught on the way down.
    const onLoad = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLIFrameElement) || !target.hasAttribute(FIND_FRAME_ATTRIBUTE)) return;
      prepareFindFrame(target);
      const id = targetIdContaining(target);
      if (id) refreshFind(id);
    };
    const onWebviewReady = (event: Event) => {
      if (event.target instanceof Element && event.target.hasAttribute(FIND_WEBVIEW_ATTRIBUTE)) markWebviewReady(event.target);
    };
    const onWebviewLoaded = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.hasAttribute(FIND_WEBVIEW_ATTRIBUTE)) return;
      const id = targetIdContaining(event.target);
      if (id) refreshFind(id);
    };
    window.addEventListener('pointerdown', remember, true);
    window.addEventListener('focusin', remember, true);
    document.addEventListener('load', onLoad, true);
    document.addEventListener('dom-ready', onWebviewReady, true);
    document.addEventListener('did-finish-load', onWebviewLoaded, true);
    return () => {
      window.removeEventListener('pointerdown', remember, true);
      window.removeEventListener('focusin', remember, true);
      document.removeEventListener('load', onLoad, true);
      document.removeEventListener('dom-ready', onWebviewReady, true);
      document.removeEventListener('did-finish-load', onWebviewLoaded, true);
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
