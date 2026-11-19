import { useQueryClient, type Query } from '@tanstack/react-query';
import { createContext, use, useEffect, useEffectEvent } from 'react';

/**
 * Whether the screen around these reads is in view. A screen that stays mounted under the one
 * open (Home under a Pane) provides its focus, so the reads sent on a return go to the screen
 * in view first.
 */
export const ScreenFocus = createContext(true);

/** True unless every component reading the query is on a screen out of view. */
export function readOnScreen(query: Query): boolean {
  return query.observers.some(observer => observer.options.meta?.onScreen !== false);
}

/**
 * Options that hold a query's reads while its screen is out of view: no refetch when the app comes
 * back, and the reconnect marks it stale instead of reading it. It reads again once in view.
 */
export function useScreenReads(queryKey: unknown[]) {
  const onScreen = use(ScreenFocus);
  const queryClient = useQueryClient();
  const readIfStale = useEffectEvent(() => {
    const state = queryClient.getQueryState(queryKey);
    if (state?.isInvalidated && state.fetchStatus === 'idle') void queryClient.refetchQueries({ queryKey, exact: true }, { cancelRefetch: false });
  });
  useEffect(() => {
    if (onScreen) readIfStale();
  }, [onScreen]);
  return { meta: { onScreen }, refetchOnWindowFocus: onScreen };
}
