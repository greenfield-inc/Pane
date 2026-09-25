import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useActiveHost, useHostsStore } from '@/auth/hostsStore';
import { DaemonProvider, queryClient } from '@/daemon';
import { NotificationTapRouter, PushRegistration } from '@/features/notifications/NotificationRouting';
import { useTheme } from '@/theme';

void SplashScreen.preventAutoHideAsync();

export { RouteErrorBoundary as ErrorBoundary } from '@/features/app/RouteErrorBoundary';

export default function RootLayout() {
  const theme = useTheme();
  const hydrated = useHostsStore(state => state.hydrated);
  const hydrate = useHostsStore(state => state.hydrate);
  const activeHost = useActiveHost();

  useEffect(() => {
    void hydrate().finally(() => SplashScreen.hideAsync());
  }, [hydrate]);

  if (!hydrated) return null;

  const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navigationTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.colors.accentText,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.text,
      border: theme.colors.border,
    },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style="auto" />
          {activeHost ? (
            <DaemonProvider key={activeHost.id} profile={activeHost}>
              <RootStack signedIn />
              <PushRegistration />
            </DaemonProvider>
          ) : (
            <RootStack signedIn={false} />
          )}
          <NotificationTapRouter />
        </ThemeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

function RootStack({ signedIn }: { signedIn: boolean }) {
  return (
    // Swipe back from anywhere on the screen, not only the left edge.
    <Stack screenOptions={{ fullScreenGestureEnabled: true, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="connect" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pane/[paneId]/index" options={{ title: '' }} />
        <Stack.Screen
          name="pane/[paneId]/permission"
          options={{ presentation: 'formSheet', sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true, headerShown: false }}
        />
        <Stack.Screen
          name="pane/new"
          options={{ presentation: 'formSheet', sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true, headerShown: false }}
        />
        <Stack.Screen name="hosts/add" options={{ presentation: 'modal', title: 'Add host' }} />
      </Stack.Protected>
      <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', headerShown: false }} />
      <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Connect to host' }} />
      {/* Notification taps and pane links; works signed in or out. */}
      <Stack.Screen name="open" options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }} />
    </Stack>
  );
}
