import { Stack } from 'expo-router';

import { tabStackOptions } from '@/features/app/tabStackOptions';

export default function PanesStack() {
  return (
    <Stack screenOptions={tabStackOptions}>
      <Stack.Screen name="index" options={{ title: 'Panes' }} />
      <Stack.Screen name="archived" options={{ title: 'Archived', headerLargeTitle: false }} />
    </Stack>
  );
}
