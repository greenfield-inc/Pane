import { useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';

import { useShowsWaiting } from '@/features/home/seenStore';
import { PermissionSheet } from '@/features/panes/PermissionSheet';

export default function PermissionRoute() {
  const { paneId, requestId } = useLocalSearchParams<{ paneId: string; requestId?: string }>();
  const { profile } = useDaemon();
  useShowsWaiting({ machineKey: profile.id, paneId });
  return <PermissionSheet paneId={paneId} requestId={requestId} />;
}
