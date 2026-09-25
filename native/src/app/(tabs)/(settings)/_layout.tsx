import { Stack } from 'expo-router';

export default function SettingsStack() {
  return (
    <Stack screenOptions={{ headerLargeTitle: true, headerTransparent: true, fullScreenGestureEnabled: true }}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
    </Stack>
  );
}
