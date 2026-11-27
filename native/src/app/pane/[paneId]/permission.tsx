import { router, useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';

import { FocusScope } from '@/features/controller/FocusScope';
import { useShowsWaiting } from '@/features/home/seenStore';
import { PermissionSheet } from '@/features/panes/PermissionSheet';

export default function PermissionRoute() {
  const { paneId, requestId } = useLocalSearchParams<{ paneId: string; requestId?: string }>();
  const { profile } = useDaemon();
  useShowsWaiting({ machineKey: profile.id, paneId });
  // A controller picks among its options; the press that opened it can't also answer it.
  return <FocusScope bare guardActivate onBack={() => router.back()}><PermissionSheet paneId={paneId} requestId={requestId} /></FocusScope>;
}
