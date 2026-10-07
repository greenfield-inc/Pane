import { router } from 'expo-router';

import { ComputersScreen } from '@/features/computers/ComputersScreen';

export default function ComputersRoute() {
  return <ComputersScreen onConnected={() => router.back()} />;
}
