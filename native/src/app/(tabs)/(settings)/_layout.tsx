import { Stack } from 'expo-router';

import { tabStackOptions } from '@/features/app/tabStackOptions';

export default function SettingsStack() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
    </Stack>
  );
}
