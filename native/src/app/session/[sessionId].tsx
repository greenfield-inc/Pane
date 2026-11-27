import { useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';
import { useShowsWaiting } from '@/features/home/seenStore';
import { SessionScreen } from '@/features/sessions/SessionScreen';

export default function SessionRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { profile } = useDaemon();
  // Opening a Session shows what waits in it.
  useShowsWaiting({ machineKey: profile.id, sessionId });
  return <SessionScreen />;
}
