import { Stack, useLocalSearchParams } from 'expo-router';

import { EmptyState, Screen } from '@/ui';

// PLACEHOLDER: the terminal feature owns this screen (xterm in a WebView plus
// the native input bar, tabs, scroll joystick and quick keys).
export default function PaneDetailScreen() {
  const { paneId } = useLocalSearchParams<{ paneId: string }>();
  return (
    <Screen testID="pane-detail-screen">
      <Stack.Screen options={{ title: 'Pane' }} />
      <EmptyState title="Terminal" message={`Pane ${paneId}. The terminal view lands here.`} />
    </Screen>
  );
}
