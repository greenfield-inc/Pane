import { useLocalSearchParams } from 'expo-router';

import { NotifySheet } from '@/features/notify/NotifySheet';

/** A question from an agent outside any Pane; questions from a Pane open under it. */
export default function NotifyRoute() {
  const { notifyId } = useLocalSearchParams<{ notifyId: string }>();
  return <NotifySheet notifyId={notifyId} />;
}
