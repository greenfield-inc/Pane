import { router, useLocalSearchParams } from 'expo-router';

import { FocusScope } from '@/features/controller/FocusScope';

import { ConnectMachineSheet } from '@/features/machines/ConnectMachineSheet';

export default function ConnectMachineRoute() {
  const { key } = useLocalSearchParams<{ key: string }>();
  return <FocusScope bare onBack={() => router.back()}><ConnectMachineSheet machineKey={key} /></FocusScope>;
}
