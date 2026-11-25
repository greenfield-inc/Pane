import { router, type Href } from 'expo-router';
import { createContext, use } from 'react';
import { Dimensions } from 'react-native';
import { create } from 'zustand';

import { secureStore } from '@/auth/secureStore';
import type { ScreenToReopen } from '@/features/app/reopenScreen';

import { isWide, type WindowSize } from './windowRule';

interface WideLayoutState {
  /** The app's window as laid out, in dp. */
  window: WindowSize;
  /** Home sits in a column beside the open screen. */
  wide: boolean;
  /** The screen on top of the stack (under any sheet), or null on its root. */
  open: ScreenToReopen | null;
  /** The column's search has the keyboard: the screen beside it stays put. */
  searching: boolean;
  /** The person collapsed Home to its rail. Remembered on the phone. */
  collapsed: boolean;
  /** The search box should take the keyboard once Home expands from the rail. */
  searchRequested: boolean;
  setWindow(window: WindowSize): void;
  setOpen(open: ScreenToReopen | null): void;
  setSearching(searching: boolean): void;
  setCollapsed(collapsed: boolean, options?: { search?: boolean }): void;
  takeSearchRequest(): boolean;
}

const initial = Dimensions.get('window');

/** The window rule's answer for the app's window, and what is open beside Home. */
export const useWideLayout = create<WideLayoutState>((set, get) => ({
  window: { width: initial.width, height: initial.height },
  wide: isWide(initial),
  open: null,
  searching: false,
  collapsed: false,
  searchRequested: false,
  setWindow: window => set({ window, wide: isWide(window) }),
  setOpen: open => set(state => (sameScreen(state.open, open) ? state : { open })),
  setSearching: searching => set({ searching }),
  setCollapsed: (collapsed, options) => {
    set({ collapsed, searchRequested: Boolean(options?.search) });
    void secureStore.setItem(COLLAPSED_KEY, collapsed ? '1' : '0').catch(() => undefined);
  },
  takeSearchRequest: () => {
    const requested = get().searchRequested;
    if (requested) set({ searchRequested: false });
    return requested;
  },
}));

const COLLAPSED_KEY = 'pane.native.homeCollapsed';
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
