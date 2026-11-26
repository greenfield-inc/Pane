import { useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';

import { useShowsWaiting } from '@/features/home/seenStore';
import { NotifySheet } from '@/features/notify/NotifySheet';

export default function PaneNotifyRoute() {
  const { notifyId } = useLocalSearchParams<{ paneId: string; notifyId: string }>();
  const { profile } = useDaemon();
  useShowsWaiting({ machineKey: profile.id, key: `${profile.id}:question:${notifyId}` });
  return <NotifySheet notifyId={notifyId} />;
}
