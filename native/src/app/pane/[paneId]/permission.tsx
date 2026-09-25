import { router, useLocalSearchParams } from 'expo-router';

import { Button, Sheet, Text } from '@/ui';

// PLACEHOLDER: the permission feature answers a blocked agent's prompt here.
export default function PermissionSheet() {
  const { paneId } = useLocalSearchParams<{ paneId: string }>();
  return (
    <Sheet title="Permission request" footer={<Button title="Close" variant="secondary" onPress={() => router.back()} />}>
      <Text tone="muted">{`Pane ${paneId} is waiting for approval.`}</Text>
    </Sheet>
  );
}
