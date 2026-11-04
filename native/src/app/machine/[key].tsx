import { useLocalSearchParams } from 'expo-router';

import { MachineDetailsScreen } from '@/features/machines/MachineDetailsScreen';

export default function MachineDetailsRoute() {
  const { key } = useLocalSearchParams<{ key: string }>();
  return <MachineDetailsScreen machineKey={key} />;
}
