import { router, useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';

import { FocusScope } from '@/features/controller/FocusScope';
import { useShowsWaiting } from '@/features/home/seenStore';
import { NotifySheet } from '@/features/notify/NotifySheet';

/** A question from an agent outside any Pane, or from another saved machine (`host`); questions from a Pane open under it. */
export default function NotifyRoute() {
  const { notifyId, host } = useLocalSearchParams<{ notifyId: string; host?: string }>();
  const { profile } = useDaemon();
  const machineKey = host ?? profile.id;
  useShowsWaiting({ machineKey, key: `${machineKey}:question:${notifyId}` });
  // A controller picks among its options; the press that opened it can't also answer it.
  return <FocusScope bare guardActivate onBack={() => router.back()}><NotifySheet notifyId={notifyId} host={host} /></FocusScope>;
}
