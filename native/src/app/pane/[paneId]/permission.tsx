import { useLocalSearchParams } from 'expo-router';

import { PermissionSheet } from '@/features/panes/PermissionSheet';

export default function PermissionRoute() {
  const { paneId, requestId } = useLocalSearchParams<{ paneId: string; requestId?: string }>();
  return <PermissionSheet paneId={paneId} requestId={requestId} />;
}
