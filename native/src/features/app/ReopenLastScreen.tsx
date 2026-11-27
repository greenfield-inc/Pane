import { router, useNavigationContainerRef } from 'expo-router';
import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

import { queryClient } from '@/daemon';
import type { ProjectWithPanes } from '@/features/panes/paneList';

import { forgetScreen, rememberScreen, takeScreenToReopen } from './reopenScreen';
import { useNavigatorReady } from './useNavigatorReady';

/**
 * Android restarts the app's screen when a fold changes the display's density, and the navigator
 * starts again on Home. This puts the screen that was open back over Home. Render it once, beside
 * the signed-in stack and outside the host's provider, so a machine switch doesn't count as a restart.
 */
export function ReopenLastScreen({ hostId }: { hostId: string }) {
  const navigation = useNavigationContainerRef();
  const ready = useNavigatorReady();
  const checked = useRef(false);

  useEffect(() => {
    if (!ready || checked.current) return;
    checked.current = true;
    // A link or a notification that started this screen decides where it opens.
    if (stackDepth(navigation.getRootState()) > 1) return forgetScreen();
    const screen = takeScreenToReopen(hostId, paneId => paneExists(hostId, paneId));
    if (screen) router.push(screen as never);
  }, [ready, navigation, hostId]);

  useEffect(() => {
    // The navigator's first state is Home; it is noted only after the screen to reopen was taken.
    const remember = navigation.addListener('state', () => {
      if (checked.current) rememberScreen(hostId, navigation.getRootState());
    });
    // Back with nothing to go back to closes the app, and its next start opens on Home.
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigation.canGoBack()) forgetScreen();
      return false;
    });
    return () => {
      remember();
      back.remove();
    };
  }, [navigation, hostId]);

  return null;
}

function stackDepth(root: { routes: { state?: { routes: unknown[] } }[] } | undefined): number {
  return root?.routes[0]?.state?.routes.length ?? 0;
}

/** Whether the host's last Pane list has it; with no list yet, it may. */
function paneExists(hostId: string, paneId: string): boolean {
  const projects = queryClient.getQueryData<ProjectWithPanes[]>([hostId, 'sessions:get-all-with-projects']);
  return !projects || projects.some(project => project.sessions?.some(pane => pane.id === paneId));
}
