import { useLocalSearchParams } from 'expo-router';

import { NotifySheet } from '@/features/notify/NotifySheet';

/** A question from an agent outside any Pane, or from another saved machine (`host`); questions from a Pane open under it. */
export default function NotifyRoute() {
  const { notifyId, host } = useLocalSearchParams<{ notifyId: string; host?: string }>();
  return <NotifySheet notifyId={notifyId} host={host} />;
}
