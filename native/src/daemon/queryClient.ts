import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // The daemon client already retries reviewed reads.
      retry: 1,
    },
  },
});

// Refetch stale queries when the app returns to the foreground.
focusManager.setEventListener(onFocus => {
  const subscription = AppState.addEventListener('change', status => {
    if (Platform.OS !== 'web') onFocus(status === 'active');
  });
  return () => subscription.remove();
});
