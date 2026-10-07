import { router } from 'expo-router';

import { useDaemon } from '@/daemon';
import { ComputersScreen } from '@/features/computers/ComputersScreen';

export default function ComputersRoute() {
  const { connection } = useDaemon();
  return <ComputersScreen connected={connection.status === 'connected'} onConnected={() => router.back()} />;
}
