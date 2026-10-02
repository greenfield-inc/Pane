import { useLocalSearchParams } from 'expo-router';

import { TerminalScreen } from '@/features/terminal/TerminalScreen';

export default function PaneRoute() {
  const { paneId } = useLocalSearchParams<{ paneId: string }>();
  return <TerminalScreen paneId={paneId} />;
}
