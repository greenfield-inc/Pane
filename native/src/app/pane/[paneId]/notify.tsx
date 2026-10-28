import { useLocalSearchParams } from 'expo-router';

import { NotifySheet } from '@/features/notify/NotifySheet';

export default function PaneNotifyRoute() {
  const { notifyId } = useLocalSearchParams<{ paneId: string; notifyId: string }>();
  return <NotifySheet notifyId={notifyId} />;
}
