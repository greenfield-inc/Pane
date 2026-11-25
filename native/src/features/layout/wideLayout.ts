import { router, type Href } from 'expo-router';
import { createContext, use } from 'react';
import { Dimensions } from 'react-native';
import { create } from 'zustand';

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
  setWindow(window: WindowSize): void;
  setOpen(open: ScreenToReopen | null): void;
  setSearching(searching: boolean): void;
}

const initial = Dimensions.get('window');

/** The window rule's answer for the app's window, and what is open beside Home. */
export const useWideLayout = create<WideLayoutState>(set => ({
  window: { width: initial.width, height: initial.height },
  wide: isWide(initial),
  open: null,
  searching: false,
  setWindow: window => set({ window, wide: isWide(window) }),
  setOpen: open => set(state => (sameScreen(state.open, open) ? state : { open })),
  setSearching: searching => set({ searching }),
}));

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
  if (a.pathname !== b.pathname) return false;
  const id = (screen: ScreenToReopen) => screen.params.paneId ?? screen.params.sessionId ?? screen.params.notifyId;
  return id(a) === id(b);
}
