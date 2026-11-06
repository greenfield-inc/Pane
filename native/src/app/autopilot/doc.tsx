import { useLocalSearchParams } from 'expo-router';

import { AutopilotDocScreen } from '@/features/autopilot/AutopilotDocScreen';

/** A document full screen: above the approval it belongs to, or above the chat (Sentinel's away log). */
export default function AutopilotDocRoute() {
  const { notifyId, path, url, label } = useLocalSearchParams<{ notifyId?: string; path?: string; url?: string; label?: string }>();
  return <AutopilotDocScreen notifyId={notifyId} path={path} url={url} label={label} />;
}
