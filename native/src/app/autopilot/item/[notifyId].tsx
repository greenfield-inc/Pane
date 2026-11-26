import { useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';

import { AutopilotItemScreen } from '@/features/autopilot/AutopilotItemScreen';
import { useShowsWaiting } from '@/features/home/seenStore';

/** One of Autopilot's approvals full screen, above its chat. */
export default function AutopilotItemRoute() {
  const { notifyId } = useLocalSearchParams<{ notifyId: string }>();
  const { profile } = useDaemon();
  useShowsWaiting({ machineKey: profile.id, key: `${profile.id}:question:${notifyId}` });
  return <AutopilotItemScreen notifyId={notifyId} />;
}
