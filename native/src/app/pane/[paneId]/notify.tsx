import { router, useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';

import { FocusScope } from '@/features/controller/FocusScope';
import { useShowsWaiting } from '@/features/home/seenStore';
import { NotifySheet } from '@/features/notify/NotifySheet';

export default function PaneNotifyRoute() {
  const { notifyId } = useLocalSearchParams<{ paneId: string; notifyId: string }>();
  const { profile } = useDaemon();
  useShowsWaiting({ machineKey: profile.id, key: `${profile.id}:question:${notifyId}` });
  // A controller picks among its options; the press that opened it can't also answer it.
  return <FocusScope bare guardActivate onBack={() => router.back()}><NotifySheet notifyId={notifyId} /></FocusScope>;
}
