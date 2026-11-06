import { useLocalSearchParams } from 'expo-router';

import { AutopilotItemScreen } from '@/features/autopilot/AutopilotItemScreen';

/** One of Autopilot's approvals full screen, above its chat. */
export default function AutopilotItemRoute() {
  const { notifyId } = useLocalSearchParams<{ notifyId: string }>();
  return <AutopilotItemScreen notifyId={notifyId} />;
}
