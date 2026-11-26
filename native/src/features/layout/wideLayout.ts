import { router, type Href } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { createContext, use } from 'react';
import { Dimensions } from 'react-native';
import { create } from 'zustand';

import { secureStore } from '@/auth/secureStore';
import { screenCount, topScreen, type NavigationState, type ScreenToReopen } from '@/features/app/reopenScreen';

import { isWide, type Orientation, type WindowSize } from './windowRule';

interface WideLayoutState {
  /** The app's window as laid out, in dp. */
  window: WindowSize;
  /** Home sits in a column beside the open screen. */
  wide: boolean;
  /** The screen on top of the stack (under any sheet), or null on its root. */
  open: ScreenToReopen | null;
  /** Screens in the stack, its root included and sheets left out. */
  depth: number;
  /** The column's search has the keyboard: the screen beside it stays put. */
  searching: boolean;
  /** The person collapsed Home to its rail. Remembered on the phone. */
  collapsed: boolean;
  /** The search box should take the keyboard once Home expands from the rail. */
  searchRequested: boolean;
  /** The column's width as the person dragged it, per orientation. Remembered on the phone. */
  columnWidths: Partial<Record<Orientation, number>>;
  setWindow(window: WindowSize): void;
  setStack(root: NavigationState | undefined): void;
  setSearching(searching: boolean): void;
  setCollapsed(collapsed: boolean, options?: { search?: boolean }): void;
  /** Keeps the dragged width for this orientation; null goes back to the default. */
  setColumnWidth(orientation: Orientation, width: number | null): void;
  takeSearchRequest(): boolean;
  /** Asks Home's search box for the keyboard (a controller's L3); a collapsed column expands first. */
  requestSearch(): void;
}

const initial = Dimensions.get('window');

/** The window rule's answer for the app's window, and what is open beside Home. */
export const useWideLayout = create<WideLayoutState>((set, get) => ({
  window: { width: initial.width, height: initial.height },
  wide: isWide(initial),
  open: null,
  depth: 1,
  searching: false,
  collapsed: false,
  searchRequested: false,
  columnWidths: readColumnWidths(),
  setWindow: window => set({ window, wide: isWide(window) }),
  setStack: root => {
    const open = topScreen(root);
    const depth = screenCount(root);
    set(state => (sameScreen(state.open, open) && state.depth === depth ? state : { open, depth }));
  },
  setSearching: searching => set({ searching }),
  setCollapsed: (collapsed, options) => {
    set({ collapsed, searchRequested: Boolean(options?.search) });
    void secureStore.setItem(COLLAPSED_KEY, collapsed ? '1' : '0').catch(() => undefined);
  },
  setColumnWidth: (orientation, width) => {
    const columnWidths = { ...get().columnWidths };
    if (width === null) delete columnWidths[orientation];
    else columnWidths[orientation] = width;
    set({ columnWidths });
    void SecureStore.setItemAsync(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }).catch(() => undefined);
  },
  requestSearch: () => {
    const state = get();
    if (state.wide && state.collapsed) state.setCollapsed(false, { search: true });
    else set({ searchRequested: true });
  },
  takeSearchRequest: () => {
    const requested = get().searchRequested;
    if (requested) set({ searchRequested: false });
    return requested;
  },
}));

const COLLAPSED_KEY = 'pane.native.homeCollapsed';
const COLUMN_WIDTHS_KEY = 'pane.native.homeColumnWidths';

/** Read synchronously, so the first frame already draws the column at its width. */
function readColumnWidths(): Partial<Record<Orientation, number>> {
  try {
    const saved: unknown = JSON.parse(SecureStore.getItem(COLUMN_WIDTHS_KEY) ?? '{}');
    const widths: Partial<Record<Orientation, number>> = {};
    for (const orientation of ['portrait', 'landscape'] as const) {
      const width = (saved as Record<string, unknown> | null)?.[orientation];
      if (typeof width === 'number' && Number.isFinite(width)) widths[orientation] = width;
    }
    return widths;
  } catch {
    return {};
  }
}
void secureStore.getItem(COLLAPSED_KEY).then(saved => {
  if (saved === '1') useWideLayout.setState({ collapsed: true });
}).catch(() => undefined);

/** Home shows as its rail: collapsed by the person, with something open beside it. With nothing open it is always expanded. */
export function useRail(): boolean {
  return useWideLayout(state => state.wide && state.collapsed && state.open !== null);
}

/** Whether the screen beside the column should rise with the keyboard: not for the column's own. */
export function useAvoidsKeyboard(): boolean {
  return !useWideLayout(state => state.wide && state.searching);
}

/**
 * Whether the open screen shows a back arrow. Beside the docked Home, only when there is a screen to
 * go back to on the right; the system Back still leaves the first one for "Nothing open".
 */
export function useShowsBack(): boolean {
  return useWideLayout(state => !state.wide || state.depth > 2);
}

let closedAt = 0;

/** A screen or sheet beside the column closed. */
export function noteScreenClosed(): void {
  closedAt = Date.now();
}

/**
 * When a screen closes with its text box focused, Android hands focus to the first box it finds:
 * the column's search, with a caret and no keyboard. Focus the search didn't ask for, this soon
 * after a close, is that handoff.
 */
export function screenJustClosed(): boolean {
  return Date.now() - closedAt < 1_000;
}

/** Rendered around Home when it is the docked column. */
export const InColumn = createContext(false);

/**
 * How Home opens a Pane, a Session or a question. In the column it replaces what is open beside it,
 * so Back leaves it for "Nothing open"; tapping what is already open does nothing. On a phone it
 * opens over Home, as always.
 */
export function useOpenFromHome(): (href: ScreenToReopen) => void {
  const inColumn = use(InColumn);
  return href => {
    if (!inColumn) return router.push(href as Href);
    if (sameScreen(useWideLayout.getState().open, href)) return;
    // Both in one frame: the stack never draws its root in between.
    if (router.canDismiss()) router.dismissTo('/');
    router.push(href as Href);
  };
}

/** The same route with the same id; a Pane's tab doesn't make it another screen. */
function sameScreen(a: ScreenToReopen | null, b: ScreenToReopen | null): boolean {
  if (!a || !b) return a === b;
  return a.pathname === b.pathname && screenId(a) === screenId(b);
}

/** The id in a screen's path: a Pane's, a Session's or an approval's. */
export function screenId(screen: ScreenToReopen): string | undefined {
  const segment = /\[(\w+)\]/.exec(screen.pathname)?.[1];
  return segment ? screen.params[segment] : undefined;
}
