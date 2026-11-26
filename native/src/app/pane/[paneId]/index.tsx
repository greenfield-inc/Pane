import { useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';
import { useShowsWaiting } from '@/features/home/seenStore';
import { TerminalScreen } from '@/features/terminal/TerminalScreen';

export default function PaneRoute() {
  const { paneId } = useLocalSearchParams<{ paneId: string }>();
  const { profile } = useDaemon();
  // Opening a Pane shows what waits in it.
  useShowsWaiting({ machineKey: profile.id, paneId });
  return <TerminalScreen paneId={paneId} />;
}
