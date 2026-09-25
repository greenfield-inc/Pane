import { Stack } from 'expo-router';

export default function PanesStack() {
  return (
    <Stack screenOptions={{ headerLargeTitle: true, headerTransparent: true, fullScreenGestureEnabled: true }}>
      <Stack.Screen name="index" options={{ title: 'Panes' }} />
      <Stack.Screen name="archived" options={{ title: 'Archived', headerLargeTitle: false }} />
    </Stack>
  );
}
