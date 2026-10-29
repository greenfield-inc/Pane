import { useLocalSearchParams } from 'expo-router';

import { ConnectMachineSheet } from '@/features/machines/ConnectMachineSheet';

export default function ConnectMachineRoute() {
  const { key } = useLocalSearchParams<{ key: string }>();
  return <ConnectMachineSheet machineKey={key} />;
}
